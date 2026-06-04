/**
 * traffic-worker — executes a traffic-monitor AgentRun.
 *
 * Replaces the bash CronJob pipeline with a native TypeScript worker task
 * that flows through the same AgentRun lifecycle as every other agent kind.
 *
 * Lifecycle:  queued → scanning → succeeded | failed
 *
 * Steps:
 *   1. Read spec.input for service name and time window
 *   2. Create a cloud snapshot via speedctl
 *   3. Pull RRPairs to a local temp directory
 *   4. Run rrpair-stats (Pass 1: signal detection)
 *   5. Run traffic-scanner interpretAndFile (Pass 2: interpret + dedup)
 *   6. Upload findings JSON + snapshot tarball to S3 bucket
 *   7. Clean up cloud snapshot + local files
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentRun } from "../contracts/index.js";
import { analyzeSnapshot, type ScanStats } from "./rrpair-stats.js";
import { correlateSignals } from "./signal-correlator.js";
import { interpretAndFile, type ScannerResult } from "./traffic-scanner.js";
import { archiveFile } from "./snapshot-archive.js";
import { BaselineStore } from "./baseline-store.js";
import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger({ component: "traffic-worker" });

export interface TrafficRunInput {
  service: string;
  windowMinutes?: number;
  lookbackMinutes?: number;
  minSeverity?: "high" | "medium" | "low";
  maxTickets?: number;
  dedupWindowDays?: number;
}

export interface TrafficRunResult {
  service: string;
  snapshotId: string | null;
  rrpairCount: number;
  signalsFound: number;
  findingsUploaded: boolean;
  scanDurationMs: number;
}

function parseInput(run: AgentRun): TrafficRunInput {
  const input = run.spec.input as Record<string, unknown> | undefined;
  if (!input || typeof input.service !== "string") {
    throw new Error("spec.input.service is required for traffic-monitor runs");
  }
  return {
    service: input.service as string,
    windowMinutes: typeof input.windowMinutes === "number" ? input.windowMinutes : 35,
    lookbackMinutes: typeof input.lookbackMinutes === "number" ? input.lookbackMinutes : 5,
    minSeverity: (input.minSeverity as TrafficRunInput["minSeverity"]) ?? "medium",
    maxTickets: typeof input.maxTickets === "number" ? input.maxTickets : 5,
    dedupWindowDays: typeof input.dedupWindowDays === "number" ? input.dedupWindowDays : 7,
  };
}

async function ensureSpeedctlConfig(): Promise<void> {
  const apiKey = process.env.SPEEDSCALE_API_KEY;
  const appUrl = process.env.SPEEDSCALE_APP_URL ?? "staging.speedscale.com";
  if (!apiKey) return;
  try {
    await execFileAsync("speedctl", [
      "init", "--api-key", apiKey, "--app-url", appUrl, "--yes", "--quiet",
    ], { timeout: 30_000 });
  } catch {
    log.warn("speedctl init failed — snapshot pulls may not work");
  }
}

async function createSnapshot(
  service: string,
  windowMinutes: number,
  lookbackMinutes: number,
): Promise<string> {
  const { stdout } = await execFileAsync("speedctl", [
    "create", "snapshot",
    "--service", service,
    "--start", `${windowMinutes}m`,
    "--end", `${lookbackMinutes}m`,
    "--name", `traffic-monitor-${service}-${Date.now()}`,
    "--output", "json",
  ], { timeout: 60_000 });
  const parsed = JSON.parse(stdout) as { snapshot: { id: string } };
  return parsed.snapshot.id;
}

async function waitForSnapshot(snapshotId: string): Promise<void> {
  await execFileAsync("speedctl", [
    "wait", "snapshot", snapshotId, "--timeout", "5m",
  ], { timeout: 330_000 });
}

async function pullSnapshot(snapshotId: string, outDir: string): Promise<void> {
  await execFileAsync("proxymock", [
    "cloud", "pull", "snapshot", snapshotId, "--out", outDir,
  ], { timeout: 600_000 });
}

async function deleteCloudSnapshot(snapshotId: string): Promise<void> {
  try {
    await execFileAsync("speedctl", [
      "delete", "snapshot", snapshotId, "--exit-zero",
    ], { timeout: 30_000 });
  } catch {
    // non-fatal
  }
}

async function countRRPairs(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let count = 0;
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith(".json") || e.name.endsWith(".md")) {
        count++;
      }
    }
  }
  await walk(dir);
  return count;
}

async function uploadFindings(
  service: string,
  stats: ScanStats,
  scanResult: ScannerResult | null,
  snapshotId: string,
  snapshotDir: string,
): Promise<boolean> {
  if (stats.signals.length === 0) return false;

  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";

  // Upload findings JSON
  const findingsPath = path.join(snapshotDir, "..", `${service}-findings-${ts}.json`);
  await writeFile(findingsPath, JSON.stringify({
    service,
    timestamp: new Date().toISOString(),
    stats,
    signals: scanResult ? undefined : stats.signals,
    scanResult,
  }, null, 2));

  const findingsResult = await archiveFile(
    findingsPath,
    `radar-monitor/findings/${service}-${ts}.json`,
  );
  if (findingsResult.skipped) return false;

  // Upload snapshot tarball
  const { execFile: execFileCb } = await import("node:child_process");
  const tgzPath = `${snapshotDir}.tgz`;
  await new Promise<void>((resolve, reject) => {
    execFileCb("tar", ["-czf", tgzPath, "-C", snapshotDir, "."], (err) => {
      if (err) reject(err); else resolve();
    });
  });
  await archiveFile(tgzPath, `radar-monitor/snapshots/${snapshotId}.tgz`);

  // Clean up temp files
  await rm(findingsPath, { force: true });
  await rm(tgzPath, { force: true });

  return true;
}

/**
 * Execute a traffic-monitor AgentRun. Called by the worker when
 * spec.agent === "traffic-monitor".
 */
export async function processTrafficRun(
  run: AgentRun,
  updatePhase: (phase: AgentRun["status"]["phase"], summary: string) => Promise<void>,
): Promise<TrafficRunResult> {
  const input = parseInput(run);
  const startMs = Date.now();
  let snapshotId: string | null = null;
  const snapshotDir = path.join(tmpdir(), `traffic-monitor-${input.service}-${Date.now()}`);

  try {
    await updatePhase("scanning", `Scanning ${input.service} traffic (${input.windowMinutes}m window)`);
    await ensureSpeedctlConfig();
    await mkdir(snapshotDir, { recursive: true });

    // Create + pull snapshot
    log.info("creating cloud snapshot", { service: input.service, window: input.windowMinutes });
    snapshotId = await createSnapshot(input.service, input.windowMinutes ?? 35, input.lookbackMinutes ?? 5);
    log.info("waiting for snapshot", { snapshotId });
    await waitForSnapshot(snapshotId);
    log.info("pulling snapshot", { snapshotId });
    await pullSnapshot(snapshotId, snapshotDir);

    const rrpairCount = await countRRPairs(snapshotDir);
    if (rrpairCount === 0) {
      await deleteCloudSnapshot(snapshotId);
      await updatePhase("succeeded", `No traffic for ${input.service} in window`);
      return {
        service: input.service,
        snapshotId,
        rrpairCount: 0,
        signalsFound: 0,
        findingsUploaded: false,
        scanDurationMs: Date.now() - startMs,
      };
    }

    log.info("running signal detection", { rrpairCount });

    // Pass 1: signal detection
    const baselineDir = process.env.BASELINE_DIR ?? path.join(tmpdir(), "traffic-baselines");
    await mkdir(baselineDir, { recursive: true });
    const baseline = new BaselineStore(baselineDir);
    const stats = await analyzeSnapshot(snapshotDir, {}, baseline);

    if (stats.signals.length === 0) {
      await deleteCloudSnapshot(snapshotId);
      await updatePhase("succeeded", `${input.service}: ${rrpairCount} RRPairs, no signals`);
      return {
        service: input.service,
        snapshotId,
        rrpairCount,
        signalsFound: 0,
        findingsUploaded: false,
        scanDurationMs: Date.now() - startMs,
      };
    }

    // Correlate signals
    const signals = correlateSignals(stats.signals);
    log.info("signals detected", { count: signals.length });

    // Pass 2: interpret (no LLM, no Linear — just dedup + structure)
    let scanResult: ScannerResult | null = null;
    try {
      scanResult = await interpretAndFile(signals, undefined, snapshotDir, {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        snapshotId,
        minSeverity: input.minSeverity ?? "medium",
        maxTickets: input.maxTickets ?? 5,
        dedupWindowDays: input.dedupWindowDays ?? 7,
        createTickets: false,
        noLLM: true,
        verbose: false,
      });
    } catch (e) {
      log.warn("interpretAndFile failed (non-fatal)", { error: (e as Error).message });
    }

    // Upload findings to bucket
    const uploaded = await uploadFindings(
      input.service,
      stats,
      scanResult,
      snapshotId,
      snapshotDir,
    );

    // Clean up cloud snapshot
    await deleteCloudSnapshot(snapshotId);

    const summary = `${input.service}: ${rrpairCount} RRPairs, ${signals.length} signal(s)${uploaded ? ", findings archived" : ""}`;
    await updatePhase("succeeded", summary);

    return {
      service: input.service,
      snapshotId,
      rrpairCount,
      signalsFound: signals.length,
      findingsUploaded: uploaded,
      scanDurationMs: Date.now() - startMs,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("traffic run failed", { service: input.service, error: msg });
    if (snapshotId) await deleteCloudSnapshot(snapshotId);
    await updatePhase("failed", `${input.service}: ${msg}`);
    throw error;
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}
