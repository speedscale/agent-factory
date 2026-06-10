/**
 * reproduce-worker — executes a `reproduce` AgentRun.
 *
 * This closes the detect → confirm → replicate loop. The signal→run bridge
 * (reproduce-bridge.ts) enqueued this run when a high-severity regression was
 * detected in streaming traffic. Here we *confirm* the bug is real by replaying
 * the archived failing traffic, and if it reproduces, file a ticket with the
 * evidence.
 *
 * Lifecycle:  queued → scanning (fetch + replay) → validating (confirm) →
 *             succeeded | failed
 *
 * Steps:
 *   1. Fetch the archived evidence tarball from S3 (keyed by signal fingerprint)
 *   2. Extract it to a local snapshot dir
 *   3. Replay the failing requests via `proxymock replay` against the target,
 *      with `proxymock mock` standing in for downstream deps. Degrades to
 *      re-analysing the captured traffic when no replay target is configured.
 *   4. Run analyzeSnapshot on the result
 *   5. If the original signal reappears, the bug is confirmed
 *   6. File a Linear ticket with signal description + replay confirmation
 *
 * External calls (S3, proxymock, Linear) are injected via ReproduceDeps so the
 * orchestration is unit-testable without live infrastructure.
 */

import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentRun } from "../contracts/index.js";
import { analyzeSnapshot, type ScanStats, type Signal } from "./rrpair-stats.js";
import { fetchArchive } from "./snapshot-archive.js";
import { createLinearClient } from "./linear-client.js";
import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger({ component: "reproduce-worker" });

export interface ReproduceRunInput {
  service: string;
  fingerprint: string;
  signal: Signal;
  evidenceKey?: string;
  evidenceUri?: string;
  evidenceFileCount?: number;
  windowStart?: string;
  windowEnd?: string;
}

export type ConfirmationMethod = "replay" | "capture-reanalysis" | "none";

export interface ReproduceResult {
  service: string;
  fingerprint: string;
  reproduced: boolean;
  method: ConfirmationMethod;
  signalsAfter: number;
  ticket: { filed: boolean; ref?: string; url?: string; reason?: string };
  durationMs: number;
}

export interface TicketPayload {
  service: string;
  signal: Signal;
  method: ConfirmationMethod;
  evidenceUri?: string;
  windowStart?: string;
  windowEnd?: string;
}

export interface ReproduceDeps {
  /** Download the evidence tarball to a local path. */
  fetchEvidence: (key: string, destTgz: string) => Promise<{ skipped?: boolean }>;
  /** Extract a .tgz into destDir (which already exists). */
  extractTar: (tgz: string, destDir: string) => Promise<void>;
  /**
   * Replay the failing requests against a target, returning the output dir to
   * analyse — or null when replay was not performed (no target configured).
   */
  replay: (opts: { evidenceDir: string; outDir: string; service: string }) => Promise<{ outDir: string } | null>;
  /** Re-run signal detection on a directory of RRPairs. */
  analyze: (dir: string) => Promise<ScanStats>;
  /** File the confirmed bug. Returns whether it was filed and a reference. */
  fileTicket: (payload: TicketPayload) => Promise<{ filed: boolean; ref?: string; url?: string; reason?: string }>;
}

function parseInput(run: AgentRun): ReproduceRunInput {
  const input = run.spec.input as Record<string, unknown> | undefined;
  if (!input || typeof input.service !== "string" || typeof input.fingerprint !== "string" || !input.signal) {
    throw new Error("reproduce run requires spec.input.{service,fingerprint,signal}");
  }
  return {
    service: input.service as string,
    fingerprint: input.fingerprint as string,
    signal: input.signal as Signal,
    evidenceKey: typeof input.evidenceKey === "string" ? input.evidenceKey : undefined,
    evidenceUri: typeof input.evidenceUri === "string" ? input.evidenceUri : undefined,
    evidenceFileCount: typeof input.evidenceFileCount === "number" ? input.evidenceFileCount : undefined,
    windowStart: typeof input.windowStart === "string" ? input.windowStart : undefined,
    windowEnd: typeof input.windowEnd === "string" ? input.windowEnd : undefined,
  };
}

/**
 * Does the original signal reappear in freshly-analysed traffic? Match on the
 * stable fingerprint first (kind+host+pattern → identical after re-analysis),
 * falling back to kind+pattern in case host labels shifted during replay.
 */
export function signalReproduces(original: Signal, after: ScanStats): boolean {
  return after.signals.some(
    (s) =>
      s.fingerprint === original.fingerprint ||
      (s.kind === original.kind && s.evidence.pattern === original.evidence.pattern),
  );
}

// ── Default external implementations ────────────────────────────────────────

async function defaultExtractTar(tgz: string, destDir: string): Promise<void> {
  await execFileAsync("tar", ["-xzf", tgz, "-C", destDir]);
}

/**
 * Resolve the replay target for a service. REPRODUCE_REPLAY_TARGET may contain
 * a `{service}` placeholder — evidence is archived per service, and replaying
 * one service's inbound traffic against another's host would only produce
 * false "not reproduced" verdicts. A templated target like
 * `http://{service}.banking-app.svc.cluster.local` points each reproduce run
 * at the service that emitted the signal.
 */
export function resolveReplayTarget(template: string | undefined, service: string): string | null {
  if (!template || template.trim().length === 0) return null;
  return template.replaceAll("{service}", service);
}

/**
 * proxymock refuses to run before `proxymock init --api-key …` has written
 * ${HOME}/.speedscale/config.yaml. Initialize once per process from
 * SPEEDSCALE_API_KEY, mirroring ensureSpeedctlConfig in traffic-worker.ts.
 * Best-effort: when the key is missing the replay itself fails with
 * proxymock's own clear "not initialized" error.
 */
let proxymockInitDone: Promise<void> | undefined;

function ensureProxymockInit(): Promise<void> {
  proxymockInitDone ??= (async () => {
    const apiKey = process.env.SPEEDSCALE_API_KEY;
    if (!apiKey) return;
    const appUrl = process.env.SPEEDSCALE_APP_URL;
    try {
      await execFileAsync(
        "proxymock",
        ["init", "--api-key", apiKey, ...(appUrl ? ["--app-url", appUrl] : [])],
        { timeout: 30_000 },
      );
    } catch (e) {
      log.warn("proxymock init failed — replay may not work", { error: (e as Error).message });
    }
  })();
  return proxymockInitDone;
}

/**
 * Replay against the target named by REPRODUCE_REPLAY_TARGET (a full or partial
 * URL passed to `proxymock replay --test-against`, with `{service}` expanded to
 * the signal's service). When unset there's no live target to drive, so we
 * return null and the caller falls back to re-analysing the captured traffic.
 */
async function defaultReplay(opts: { evidenceDir: string; outDir: string; service: string }): Promise<{ outDir: string } | null> {
  const target = resolveReplayTarget(process.env.REPRODUCE_REPLAY_TARGET, opts.service);
  if (!target) return null;

  await ensureProxymockInit();
  await mkdir(opts.outDir, { recursive: true });
  // Flag names are `--in` / `--out` (not --in-directory / --out-directory);
  // `--out-format json` because analyzeSnapshot parses RRPair JSON, and the
  // CLI default is markdown.
  await execFileAsync(
    "proxymock",
    [
      "replay",
      "--in", opts.evidenceDir,
      "--out", opts.outDir,
      "--out-format", "json",
      "--test-against", target,
    ],
    { timeout: 300_000 },
  );
  return { outDir: opts.outDir };
}

/**
 * File a Linear ticket when LINEAR_API_KEY + LINEAR_REPRODUCE_TEAM_ID are set.
 * Otherwise no-op with a reason — the run still records the confirmation, and
 * the evidence URI is in the result for manual filing.
 */
async function defaultFileTicket(
  payload: TicketPayload,
): Promise<{ filed: boolean; ref?: string; url?: string; reason?: string }> {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_REPRODUCE_TEAM_ID;
  if (!apiKey || !teamId) {
    return { filed: false, reason: "LINEAR_API_KEY / LINEAR_REPRODUCE_TEAM_ID not set" };
  }
  const client = createLinearClient({ apiKey });
  const issue = await client.createIssue({
    teamId,
    title: `[auto] ${payload.signal.title}`,
    description: renderTicketBody(payload),
    ...(process.env.LINEAR_REPRODUCE_LABEL_ID ? { labelIds: [process.env.LINEAR_REPRODUCE_LABEL_ID] } : {}),
  });
  return { filed: true, ref: issue.identifier, url: issue.url };
}

export function renderTicketBody(payload: TicketPayload): string {
  const { signal, service, method, evidenceUri, windowStart, windowEnd } = payload;
  const confirmation =
    method === "replay"
      ? "Confirmed by replaying the captured failing traffic against the live service — the signal reproduced."
      : "Confirmed by re-analysing the captured failing traffic — the signal is present in the archived evidence.";

  const replayHint = evidenceUri
    ? `\n\n**Reproduce locally:**\n\`\`\`\naws s3 cp ${evidenceUri} ./repro.tgz && mkdir -p repro && tar xzf repro.tgz -C repro\nproxymock replay --in ./repro\n\`\`\``
    : "";

  return [
    `**Service:** ${service}`,
    `**Signal:** ${signal.kind} (severity: ${signal.severity})`,
    `**Fingerprint:** \`${signal.fingerprint}\``,
    windowStart && windowEnd ? `**Window:** ${windowStart} → ${windowEnd}` : "",
    "",
    "## What happened",
    signal.details,
    "",
    "## Confirmation",
    confirmation,
    evidenceUri ? `\n**Evidence:** \`${evidenceUri}\`` : "",
    replayHint,
    "",
    "_Filed automatically by Agent Factory (detect → confirm → replicate)._",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function defaultReproduceDeps(): ReproduceDeps {
  return {
    fetchEvidence: (key, destTgz) => fetchArchive(key, destTgz),
    extractTar: defaultExtractTar,
    replay: defaultReplay,
    analyze: (dir) => analyzeSnapshot(dir),
    fileTicket: defaultFileTicket,
  };
}

/**
 * Execute a reproduce AgentRun. Called by the worker when spec.agent ===
 * "reproduce".
 */
export async function processReproduceRun(
  run: AgentRun,
  updatePhase: (phase: AgentRun["status"]["phase"], summary: string) => Promise<void>,
  deps: ReproduceDeps = defaultReproduceDeps(),
): Promise<ReproduceResult> {
  const input = parseInput(run);
  const startMs = Date.now();
  const workDir = path.join(tmpdir(), `reproduce-${input.fingerprint}-${Date.now()}`);
  const evidenceDir = path.join(workDir, "evidence");
  const replayOutDir = path.join(workDir, "replayed");
  const tgzPath = path.join(workDir, "evidence.tgz");

  try {
    if (!input.evidenceKey) {
      throw new Error("no archived evidence (evidenceKey) — cannot reproduce");
    }

    await mkdir(evidenceDir, { recursive: true });

    // 1 + 2: fetch and extract the failing traffic
    await updatePhase("scanning", `Fetching evidence for ${input.fingerprint}`);
    const fetched = await deps.fetchEvidence(input.evidenceKey, tgzPath);
    if (fetched.skipped) {
      throw new Error("archive backend not configured — cannot fetch evidence");
    }
    await deps.extractTar(tgzPath, evidenceDir);

    // 3: replay (or degrade to capture re-analysis)
    await updatePhase("scanning", `Replaying ${input.service} traffic`);
    const replayResult = await deps.replay({ evidenceDir, outDir: replayOutDir, service: input.service });
    const analyzeDir = replayResult?.outDir ?? evidenceDir;
    const method: ConfirmationMethod = replayResult ? "replay" : "capture-reanalysis";

    // 4 + 5: re-run detection and confirm
    await updatePhase("validating", "Confirming the signal reproduces");
    const stats = await deps.analyze(analyzeDir);
    const reproduced = signalReproduces(input.signal, stats);

    // 6: file the ticket when confirmed
    let ticket: ReproduceResult["ticket"] = { filed: false, reason: "not reproduced" };
    if (reproduced) {
      try {
        ticket = await deps.fileTicket({
          service: input.service,
          signal: input.signal,
          method,
          evidenceUri: input.evidenceUri,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
        });
      } catch (e) {
        ticket = { filed: false, reason: `ticket filing failed: ${(e as Error).message}` };
        log.warn("ticket filing failed (non-fatal)", { fingerprint: input.fingerprint, error: (e as Error).message });
      }
    }

    const result: ReproduceResult = {
      service: input.service,
      fingerprint: input.fingerprint,
      reproduced,
      method,
      signalsAfter: stats.signals.length,
      ticket,
      durationMs: Date.now() - startMs,
    };

    const summary = reproduced
      ? `Confirmed ${input.signal.kind} on ${input.service} via ${method}${ticket.filed ? ` — filed ${ticket.ref}` : ""}`
      : `Not reproduced: ${input.signal.kind} on ${input.service} did not reappear (${method})`;
    await updatePhase("succeeded", summary);

    log.info("reproduce run complete", { ...result });
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("reproduce run failed", { service: input.service, fingerprint: input.fingerprint, error: msg });
    await updatePhase("failed", `${input.service}/${input.fingerprint}: ${msg}`);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
