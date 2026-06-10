/**
 * reproduce-bridge — turn a confirmed regression signal into an AgentRun.
 *
 * This is the hinge of the detect → confirm → replicate loop. Signal detection
 * (rrpair-stats) finds anomalies; this module decides which ones are worth the
 * expense of a full reproduce run and enqueues them.
 *
 * Two gates, both must pass:
 *
 *  1. Severity — only signals at or above `minSeverity` (default "high").
 *  2. Regression — the signal must represent a *change* from the endpoint's
 *     prior baseline, not a standing characteristic. A slow endpoint that has
 *     always been slow is not a regression; one whose p95 jumped to 2× its
 *     rolling baseline is. We never spawn a reproduce run from a cold baseline
 *     (no history = no way to claim regression).
 *
 * A reproduce run is a minimal AgentRun with `spec.agent = "reproduce"` and a
 * `spec.input` payload the reproduce worker consumes: the signal, its archived
 * evidence location, and the window bounds.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentRun } from "../contracts/index.js";
import type { Severity, Signal } from "./rrpair-stats.js";
import type { BaselineStore } from "./baseline-store.js";
import type { EvidenceArchiveResult } from "./evidence-archive.js";
import { resolveFromRepo, writeJsonFile } from "./io.js";
import { listRuns } from "./run-admin.js";
import { createRunQueueFromEnv } from "./run-queue.js";

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Phases in which a reproduce run is still "live" — don't spawn a duplicate. */
const ACTIVE_PHASES = new Set<AgentRun["status"]["phase"]>([
  "queued",
  "planned",
  "building",
  "scanning",
  "validating",
  "generating",
  "deploying",
  "reporting",
]);

/**
 * How long after a reproduce run *succeeds* before the same fingerprint may
 * file again. A persistent regression re-qualifies every window (the rolling
 * baseline takes a while to absorb the new behavior), and reproduce runs
 * complete in seconds — without a cooldown the same bug files a duplicate
 * ticket every ~60s for as long as it persists.
 */
const DEFAULT_REFILE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * How long after a reproduce run *fails* (e.g. transient S3 error) before the
 * same fingerprint may retry. Much shorter than the success cooldown — a
 * failure didn't produce a ticket, so we want another attempt, just not a hot
 * loop every window.
 */
const DEFAULT_RETRY_BACKOFF_MS = 15 * 60 * 1000; // 15m

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Fingerprints that must not enqueue a new reproduce run right now: any with a
 * run still live, one that succeeded within the refile cooldown, or one that
 * failed within the retry backoff. A completed run with no parseable
 * transition time blocks conservatively (treated as just-completed).
 */
export function blockedFingerprints(
  runs: AgentRun[],
  nowMs: number,
  opts: { refileCooldownMs?: number; retryBackoffMs?: number } = {},
): Set<string> {
  const refileCooldownMs = opts.refileCooldownMs ?? envMs("REPRODUCE_REFILE_COOLDOWN_MS", DEFAULT_REFILE_COOLDOWN_MS);
  const retryBackoffMs = opts.retryBackoffMs ?? envMs("REPRODUCE_RETRY_BACKOFF_MS", DEFAULT_RETRY_BACKOFF_MS);

  const blocked = new Set<string>();
  for (const run of runs) {
    if (run.spec.agent !== "reproduce") continue;
    const fp = (run.spec.input as { fingerprint?: string } | undefined)?.fingerprint;
    if (!fp) continue;

    const phase = run.status.phase;
    if (ACTIVE_PHASES.has(phase)) {
      blocked.add(fp);
      continue;
    }

    const windowMs = phase === "succeeded" ? refileCooldownMs : retryBackoffMs;
    const completedAt = run.status.lastTransitionAt ? Date.parse(run.status.lastTransitionAt) : NaN;
    if (!Number.isFinite(completedAt) || nowMs - completedAt < windowMs) {
      blocked.add(fp);
    }
  }
  return blocked;
}

export interface ReproduceTriggerOptions {
  /** Lowest severity that qualifies for a reproduce run. Default "high". */
  minSeverity?: Severity;
  /**
   * For error signals, how far above the baseline error rate the current rate
   * must climb to count as a regression. Default 2 (doubled).
   */
  errorRegressionFactor?: number;
}

/**
 * Derive the baseline endpoint key ("GET /api/x") from a signal whose
 * `evidence.pattern` is in "METHOD:/path" form. Returns null for SQL/pattern
 * signals that aren't endpoint-keyed.
 */
function endpointKeyForSignal(signal: Signal): string | null {
  if (signal.kind !== "errors" && signal.kind !== "slow-endpoint") return null;
  const p = signal.evidence.pattern;
  const idx = p.indexOf(":");
  if (idx === -1) return null;
  return `${p.slice(0, idx)} ${p.slice(idx + 1)}`;
}

/** True when relative-latency detection already confirmed a 2×-baseline jump. */
function hasLatencyRegression(signal: Signal): boolean {
  if (signal.evidence.baseline) return true;
  for (const c of signal.components ?? []) {
    if (c.evidence.baseline) return true;
  }
  return false;
}

/**
 * Decide whether a signal represents a regression versus the prior baseline.
 *
 * - slow-endpoint / incident: regression iff relative detection fired (the
 *   signal carries an `evidence.baseline` snapshot, meaning p95 ≥ 2× baseline).
 * - errors: regression iff the endpoint had a baseline and the current error
 *   rate climbed materially above it (≥ factor× baseline, or baseline ~0 and
 *   now erroring).
 */
export function isRegression(
  signal: Signal,
  baseline: BaselineStore,
  factor = 2,
): boolean {
  if (hasLatencyRegression(signal)) return true;

  if (signal.kind === "errors") {
    const key = endpointKeyForSignal(signal);
    if (!key) return false;
    const bl = baseline.getBaseline(key);
    if (!bl) return false; // no history → can't claim regression
    const current = signal.evidence.errorRate ?? 0;
    // Baseline healthy (≈0 errors) and now erroring, OR error rate doubled.
    const threshold = Math.max(bl.errorRate * factor, bl.errorRate + 0.05);
    return current > bl.errorRate && current >= threshold;
  }

  return false;
}

/**
 * A signal qualifies for a reproduce run when it clears the severity gate, is a
 * regression, and is not on the suppress list.
 */
export function isReproducibleSignal(
  signal: Signal,
  baseline: BaselineStore,
  opts: ReproduceTriggerOptions = {},
): boolean {
  const minSeverity = opts.minSeverity ?? "high";
  if (SEVERITY_RANK[signal.severity] > SEVERITY_RANK[minSeverity]) return false;
  if (baseline.isSuppressed(signal.fingerprint)) return false;
  return isRegression(signal, baseline, opts.errorRegressionFactor ?? 2);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export interface ReproduceRunInput {
  service: string;
  signal: Signal;
  /** Where the failing RRPairs were archived, from evidence-archive. */
  evidence?: EvidenceArchiveResult;
  windowStart?: string;
  windowEnd?: string;
  /** Compact timestamp tag, shared with the evidence object key. */
  ts: string;
}

/**
 * Create a queued `reproduce` AgentRun on disk and enqueue it. Returns the run
 * name. The worker's traffic/reproduce handler picks it up from there.
 */
export async function enqueueReproduceRun(input: ReproduceRunInput): Promise<string> {
  const { service, signal, evidence, windowStart, windowEnd, ts } = input;
  const now = new Date().toISOString();
  const runName = slugify(`reproduce-${service}-${signal.fingerprint}-${ts}`);
  const artifactRoot = resolveFromRepo("artifacts", runName);
  await mkdir(artifactRoot, { recursive: true });

  const run: AgentRun = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRun",
    metadata: { name: runName },
    spec: {
      appRef: { name: service },
      agent: "reproduce",
      input: {
        service,
        fingerprint: signal.fingerprint,
        signal,
        evidenceKey: evidence?.key,
        evidenceUri: evidence?.uri,
        evidenceFileCount: evidence?.fileCount ?? 0,
        windowStart,
        windowEnd,
      },
      issue: {
        id: signal.fingerprint,
        title: signal.title,
        body: signal.details,
      },
      workspace: {
        root: path.posix.join(".work", runName),
        branch: `agent/${runName}`,
      },
    },
    status: {
      phase: "queued",
      lastTransitionAt: now,
      summary: `Reproduce candidate: ${signal.kind} regression on ${service}`,
      artifacts: {},
    },
  };

  await writeJsonFile(path.join(artifactRoot, "run.json"), run);

  const queue = createRunQueueFromEnv();
  try {
    await queue.enqueueRun(runName);
  } finally {
    await queue.close();
  }

  return runName;
}

export interface BridgeContext {
  service: string;
  windowStart?: string;
  windowEnd?: string;
  ts: string;
  /** fingerprint → archived evidence location (from evidence-archive). */
  evidenceByFingerprint: Map<string, EvidenceArchiveResult>;
  options?: ReproduceTriggerOptions;
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

/**
 * Bridge a window's signals to reproduce runs. For each reproducible signal:
 * skip it if a reproduce run for the same fingerprint is already live (so a
 * persistent regression doesn't enqueue a fresh run every 60s), otherwise
 * enqueue one carrying its archived evidence. Returns the created run names.
 */
export async function bridgeSignalsToRuns(
  signals: Signal[],
  baseline: BaselineStore,
  ctx: BridgeContext,
): Promise<string[]> {
  const candidates = signals.filter((s) => isReproducibleSignal(s, baseline, ctx.options));
  if (candidates.length === 0) return [];

  // One scan of existing runs to dedup: skip fingerprints with a live run,
  // a recent success (refile cooldown), or a recent failure (retry backoff).
  let blocked = new Set<string>();
  try {
    blocked = blockedFingerprints(await listRuns(), Date.now());
  } catch {
    /* best-effort dedup; fall through and enqueue */
  }

  const created: string[] = [];
  for (const signal of candidates) {
    if (blocked.has(signal.fingerprint)) {
      ctx.logger?.info("reproduce run live or in cooldown, skipping", {
        service: ctx.service,
        fingerprint: signal.fingerprint,
      });
      continue;
    }
    try {
      const runName = await enqueueReproduceRun({
        service: ctx.service,
        signal,
        evidence: ctx.evidenceByFingerprint.get(signal.fingerprint),
        windowStart: ctx.windowStart,
        windowEnd: ctx.windowEnd,
        ts: ctx.ts,
      });
      created.push(runName);
      blocked.add(signal.fingerprint);
      ctx.logger?.info("enqueued reproduce run", {
        service: ctx.service,
        fingerprint: signal.fingerprint,
        run: runName,
      });
    } catch (e) {
      ctx.logger?.warn("failed to enqueue reproduce run", {
        service: ctx.service,
        fingerprint: signal.fingerprint,
        error: (e as Error).message,
      });
    }
  }

  return created;
}
