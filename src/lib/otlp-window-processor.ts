/**
 * otlp-window-processor — handles analysis when a tumbling window closes.
 *
 * Writes buffered RRPair records to a temp directory as .json files, then
 * feeds them through the existing analysis pipeline:
 *   analyzeSnapshot() → correlateSignals() → interpretAndFile() → archiveFile()
 *
 * Runs async so it never blocks the OTLP receiver or the next window close.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { WindowContents } from "./otlp-buffer.js";
import { analyzeSnapshot } from "./rrpair-stats.js";
import { correlateSignals } from "./signal-correlator.js";
import { interpretAndFile, type ScannerResult } from "./traffic-scanner.js";
import { archiveFile, archiveConfigFromEnv } from "./snapshot-archive.js";
import { archiveSignalEvidence, type EvidenceArchiveResult } from "./evidence-archive.js";
import { bridgeSignalsToRuns } from "./reproduce-bridge.js";
import { BaselineStore, type WindowStats } from "./baseline-store.js";
import type { OtlpStreamingMetrics } from "./metrics.js";

export interface WindowProcessorConfig {
  baselineDir: string;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
  metrics: OtlpStreamingMetrics;
}

/**
 * Extract hostname from an RRPair record for directory grouping.
 * Falls back to service name or "unknown" if no URL is available.
 */
function extractHost(record: Record<string, unknown>, fallback: string): string {
  const http = record.http as Record<string, unknown> | undefined;
  const request = http?.request as Record<string, unknown> | undefined;
  const rawUrl = request?.url as string | undefined;

  if (rawUrl) {
    try {
      return new URL(rawUrl.startsWith("http") ? rawUrl : `http://${rawUrl}`).host;
    } catch { /* fall through */ }
  }

  return record.service as string || fallback;
}

/**
 * Process a closed window: write records to temp dir, run analysis pipeline,
 * upload findings, clean up.
 */
export async function processClosedWindow(
  window: WindowContents,
  config: WindowProcessorConfig,
): Promise<void> {
  const { service, records, windowStart, windowEnd, droppedCount } = window;
  const { logger, metrics } = config;
  const startMs = Date.now();

  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";
  const tempDir = path.join(tmpdir(), `otlp-window-${service}-${ts}`);

  try {
    await mkdir(tempDir, { recursive: true });

    if (droppedCount > 0) {
      logger.warn("window had dropped records", { service, droppedCount });
      metrics.recordsDropped.inc({ service }, droppedCount);
    }

    // Write each record as a .json file grouped by host subdirectory.
    // This matches the on-disk format analyzeSnapshot() expects.
    const hostDirs = new Map<string, number>();

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const host = extractHost(record, service);
      const idx = hostDirs.get(host) ?? 0;
      hostDirs.set(host, idx + 1);

      const hostDir = path.join(tempDir, host.replace(/[/:]/g, "_"));
      await mkdir(hostDir, { recursive: true });
      const fileName = `${String(idx).padStart(5, "0")}.json`;
      await writeFile(path.join(hostDir, fileName), JSON.stringify(record));
    }

    // Pass 1: signal detection. Load the service's rolling baseline first so
    // analyzeSnapshot can flag relative regressions (2× baseline p95) rather
    // than only static thresholds.
    await mkdir(config.baselineDir, { recursive: true });
    const baseline = new BaselineStore(config.baselineDir);
    await baseline.load(service);
    const stats = await analyzeSnapshot(tempDir, {}, baseline);

    // Accumulate this window's per-endpoint stats into the baseline. This runs
    // on every window — including clean ones — because clean windows ARE the
    // baseline. Without this the store reads forever against an empty history
    // and relative regression detection can never fire.
    const windowStats: WindowStats[] = stats.endpointStats.map((e) => ({
      ts: windowEnd || new Date().toISOString(),
      service,
      endpoint: e.key,
      p50: e.p50,
      p95: e.p95,
      p99: e.p99,
      count: e.count,
      errorRate: e.errorRate,
    }));
    await baseline.append(service, windowStats);

    if (stats.signals.length === 0) {
      logger.info("window processed, no signals", {
        service,
        rrpairCount: records.length,
        endpointsTracked: windowStats.length,
        durationMs: Date.now() - startMs,
      });
      metrics.windowsProcessed.inc({ service });
      return;
    }

    // Correlate signals
    const signals = correlateSignals(stats.signals);

    // Archive the failing RRPairs for each signal before the temp dir is
    // deleted in `finally`, then bridge confirmed regressions to reproduce
    // runs. Both are gated on an archive backend being configured: without one
    // the evidence can't be preserved, and a reproduce run with no traffic to
    // replay is useless.
    const evidenceByFingerprint = new Map<string, EvidenceArchiveResult>();
    let reproduceRuns: string[] = [];
    if (archiveConfigFromEnv()) {
      for (const signal of signals) {
        try {
          const ev = await archiveSignalEvidence(
            signal,
            tempDir,
            `agent-factory/stream-evidence/${service}`,
            ts,
          );
          evidenceByFingerprint.set(signal.fingerprint, ev);
        } catch (e) {
          logger.warn("evidence archive failed (non-fatal)", {
            service,
            fingerprint: signal.fingerprint,
            error: (e as Error).message,
          });
        }
      }

      // Bridge: enqueue a reproduce run for each high-severity regression.
      try {
        reproduceRuns = await bridgeSignalsToRuns(signals, baseline, {
          service,
          windowStart,
          windowEnd,
          ts,
          evidenceByFingerprint,
          logger,
        });
      } catch (e) {
        logger.warn("signal→run bridge failed (non-fatal)", {
          service,
          error: (e as Error).message,
        });
      }
    }

    // Pass 2: interpret (no LLM, no Linear tickets)
    let scanResult: ScannerResult | null = null;
    try {
      scanResult = await interpretAndFile(signals, undefined, tempDir, {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        minSeverity: "medium",
        maxTickets: 5,
        dedupWindowDays: 7,
        createTickets: false,
        noLLM: true,
        verbose: false,
      });
    } catch (e) {
      logger.warn("interpretAndFile failed (non-fatal)", {
        service,
        error: (e as Error).message,
      });
    }

    // Upload findings to S3 if configured
    const findingsPath = path.join(tempDir, "..", `${service}-stream-findings-${ts}.json`);
    await writeFile(findingsPath, JSON.stringify({
      source: "otlp-stream",
      service,
      windowStart,
      windowEnd,
      rrpairCount: records.length,
      droppedCount,
      timestamp: new Date().toISOString(),
      stats,
      scanResult,
      evidence: Object.fromEntries(evidenceByFingerprint),
      reproduceRuns,
    }, null, 2));

    const archiveResult = await archiveFile(
      findingsPath,
      `agent-factory/stream-findings/${service}-${ts}.json`,
    );

    // Clean up findings file
    await rm(findingsPath, { force: true });

    metrics.windowsProcessed.inc({ service });
    metrics.signalsFound.inc({ service }, signals.length);

    logger.info("window processed", {
      service,
      rrpairCount: records.length,
      signalsFound: signals.length,
      findingsArchived: !archiveResult.skipped,
      reproduceRuns: reproduceRuns.length,
      durationMs: Date.now() - startMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("window processing failed", { service, error: msg });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
