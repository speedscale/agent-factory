/**
 * baseline-store — per-endpoint rolling stats for relative threshold detection.
 *
 * Instead of flagging "p95 > 1000ms" (noisy for slow-by-nature endpoints like
 * LLM calls), we flag when a metric is 2× its own rolling 7-day baseline.
 *
 * Storage: one NDJSON file per service at `<baseDir>/<service>.ndjson`.
 * Each line is one window's stats for one endpoint/query pattern.
 * Lines older than RETENTION_DAYS are pruned on load.
 *
 * Fingerprint suppress list: `<baseDir>/.suppress` — one fingerprint per line.
 * Pass 2 skips any signal whose fingerprint appears here.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WindowStats {
  /** ISO timestamp of this window */
  ts: string;
  /** Service name (e.g. "radar") */
  service: string;
  /** Endpoint key: "GET /api/accounts" or SQL pattern */
  endpoint: string;
  p50: number;
  p95: number;
  p99: number;
  /** Total call count in this window */
  count: number;
  /** Error rate 0–1 */
  errorRate: number;
}

export interface EndpointBaseline {
  /** Rolling median of observed p95 values across recent windows */
  p95: number;
  /** Rolling median of observed p50 values */
  p50: number;
  /** Rolling median of error rates */
  errorRate: number;
  /** Number of windows that contributed to this baseline */
  sampleWindows: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

const RETENTION_DAYS = 30;
const MIN_WINDOWS_FOR_RELATIVE = 7;

// ── BaselineStore ─────────────────────────────────────────────────────────────

export class BaselineStore {
  private baseDir: string;
  /** endpoint → aggregated baseline (lazy-loaded per service) */
  private baselines = new Map<string, EndpointBaseline>();
  /** fingerprints to suppress in Pass 2 */
  private suppressSet = new Set<string>();
  private loaded = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Load baseline data for the given service from disk.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async load(service: string): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.loadBaselines(service);
    await this.loadSuppress();
  }

  /**
   * Append this window's stats to the baseline file, then prune old records.
   */
  async append(service: string, records: WindowStats[]): Promise<void> {
    if (records.length === 0) return;
    try {
      await mkdir(this.baseDir, { recursive: true });
      const file = this.baselineFile(service);
      const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await appendFile(file, lines, "utf8");
    } catch {
      /* non-fatal — best-effort */
    }
  }

  /**
   * Return baseline stats for an endpoint, or null if fewer than
   * MIN_WINDOWS_FOR_RELATIVE windows have been observed (fall back to static).
   */
  getBaseline(endpoint: string): EndpointBaseline | null {
    const b = this.baselines.get(endpoint);
    if (!b || b.sampleWindows < MIN_WINDOWS_FOR_RELATIVE) return null;
    return b;
  }

  /** True if this fingerprint has been suppressed (closed as "not a bug"). */
  isSuppressed(fp: string): boolean {
    return this.suppressSet.has(fp);
  }

  /**
   * Add a fingerprint to the suppress list on disk.
   * Called via `traffic-scan.js --suppress <fp>`.
   */
  async addSuppress(fp: string): Promise<void> {
    if (this.suppressSet.has(fp)) return;
    this.suppressSet.add(fp);
    try {
      await mkdir(this.baseDir, { recursive: true });
      await appendFile(this.suppressFile(), fp + "\n", "utf8");
    } catch {
      /* non-fatal */
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private baselineFile(service: string): string {
    return path.join(this.baseDir, `${service}.ndjson`);
  }

  private suppressFile(): string {
    return path.join(this.baseDir, ".suppress");
  }

  private async loadBaselines(service: string): Promise<void> {
    const file = this.baselineFile(service);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return; // no baseline yet — that's fine
    }

    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const recent: WindowStats[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed) as WindowStats;
        if (new Date(r.ts).getTime() >= cutoff) {
          recent.push(r);
        }
      } catch {
        /* skip malformed lines */
      }
    }

    // Group by endpoint and compute rolling medians
    const byEndpoint = new Map<string, WindowStats[]>();
    for (const r of recent) {
      const key = r.endpoint;
      if (!byEndpoint.has(key)) byEndpoint.set(key, []);
      byEndpoint.get(key)!.push(r);
    }

    for (const [ep, rows] of byEndpoint) {
      this.baselines.set(ep, {
        p95: median(rows.map((r) => r.p95)),
        p50: median(rows.map((r) => r.p50)),
        errorRate: median(rows.map((r) => r.errorRate)),
        sampleWindows: rows.length,
      });
    }

    // Prune stale records from disk (rewrite file with only recent records)
    if (recent.length < raw.split("\n").filter((l) => l.trim()).length) {
      try {
        await writeFile(file, recent.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      } catch {
        /* non-fatal */
      }
    }
  }

  private async loadSuppress(): Promise<void> {
    try {
      const raw = await readFile(this.suppressFile(), "utf8");
      for (const line of raw.split("\n")) {
        const fp = line.trim();
        if (fp) this.suppressSet.add(fp);
      }
    } catch {
      /* no suppress file yet */
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Build the WindowStats records from an analyzeSnapshot result for appending.
 * One record per HTTP endpoint + one per SQL pattern observed.
 */
export function buildWindowStats(
  service: string,
  ts: string,
  httpEndpoints: Array<{
    key: string; // "GET /api/accounts"
    p50: number; p95: number; p99: number;
    count: number; errorRate: number;
  }>,
  sqlPatterns: Array<{
    key: string;
    p50: number; p95: number; p99: number;
    count: number;
  }>,
): WindowStats[] {
  const records: WindowStats[] = [];
  for (const ep of httpEndpoints) {
    records.push({ ts, service, endpoint: ep.key, p50: ep.p50, p95: ep.p95, p99: ep.p99, count: ep.count, errorRate: ep.errorRate });
  }
  for (const sq of sqlPatterns) {
    records.push({ ts, service, endpoint: `sql:${sq.key}`, p50: sq.p50, p95: sq.p95, p99: sq.p99, count: sq.count, errorRate: 0 });
  }
  return records;
}
