/**
 * rrpair-stats — programmatic analysis of a proxymock snapshot directory.
 *
 * Pass 1 of the traffic-scan pipeline: no LLM, pure stats computation.
 * Reads every RRPair file in the snapshot, groups by endpoint/query pattern,
 * computes latency percentiles, and emits pre-scored Signals for:
 *
 *   n+1              — same OUT host+pattern with count > threshold
 *   slow-endpoint    — inbound HTTP p95 latency over threshold
 *   slow-query       — SQL operation duration over threshold
 *   high-freq-query  — same SQL pattern executed > threshold times
 *   errors           — non-2xx HTTP or failed SQL with non-trivial rate
 *
 * The caller (traffic-scanner.ts) feeds these Signals to the LLM which
 * produces one Linear ticket hypothesis per signal.  Keeping the LLM out of
 * the discovery step means: (a) the LLM only interprets confirmed signals,
 * not raw noise; (b) total token cost is predictable regardless of snapshot
 * size; (c) thresholds can be tuned without touching any prompt.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type BaselineStore } from "./baseline-store.js";

// ── RRPair shape (the subset we actually read) ────────────────────────────────

interface RawRRPair {
  ts?: string;
  l7protocol?: string;
  duration?: number;
  direction?: "IN" | "OUT";
  tech?: string;
  command?: string;
  /** SQL text for Postgres records; URL path for HTTP records */
  location?: string;
  status?: string;
  service?: string;
  cluster?: string;
  /** Normalised Postgres signatures — prefer over `location` for grouping */
  mutableSignature?: Record<string, string>;
  http?: {
    request?: { method?: string; url?: string };
    response?: { statusCode?: number };
  };
}

// ── Public output types ───────────────────────────────────────────────────────

export type SignalKind =
  | "n+1"
  | "slow-endpoint"
  | "slow-query"
  | "high-freq-query"
  | "errors"
  | "incident";

export type Severity = "high" | "medium" | "low";

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Signal {
  kind: SignalKind;
  severity: Severity;
  /** Stable fingerprint used for dedup — hash of kind+host+pattern */
  fingerprint: string;
  title: string;
  details: string;
  evidence: {
    host: string;
    pattern: string;
    count: number;
    latency?: LatencyStats;
    errorRate?: number;
    /** Up to 3 example file paths from the snapshot */
    examples: string[];
    /** Populated when relative baseline detection was used */
    baseline?: { p95: number; sampleWindows: number };
  };
  /** Set by signal-correlator when this signal is part of an incident */
  components?: Signal[];
}

/** Per-endpoint stats emitted alongside signals, used to update BaselineStore. */
export interface EndpointStat {
  key: string;   // "GET /api/accounts" or "sql:SELECT ..."
  p50: number; p95: number; p99: number;
  count: number;
  errorRate: number;
}

export interface ScanStats {
  snapshotDir: string;
  windowStart: string;
  windowEnd: string;
  totalFiles: number;
  parsedOk: number;
  signals: Signal[];
  /** All observed HTTP endpoints + SQL patterns, for baseline accumulation */
  endpointStats: EndpointStat[];
}

// ── Analysis thresholds — tune here, not in prompts ──────────────────────────

export interface ScanThresholds {
  /** Minimum occurrences of an OUT call pattern to flag as N+1 */
  n1MinCount: number;
  /** p95 latency (ms) above which an inbound HTTP endpoint is "slow" */
  slowEndpointP95Ms: number;
  /** Single-operation SQL duration (ms) above which a query is "slow" */
  slowQueryMs: number;
  /** Minimum occurrences of a SQL pattern to flag as high-frequency */
  highFreqSqlMinCount: number;
  /** Minimum non-2xx ratio to flag as an error signal (0–1) */
  minErrorRate: number;
  /** Minimum absolute error count (avoid noise on single-call endpoints) */
  minErrorCount: number;
}

export const DEFAULT_THRESHOLDS: ScanThresholds = {
  n1MinCount: 20,
  slowEndpointP95Ms: 1000,
  slowQueryMs: 300,
  highFreqSqlMinCount: 100,
  minErrorRate: 0.05,
  minErrorCount: 1,
};

// ── Internal grouping types ───────────────────────────────────────────────────

interface HttpGroup {
  host: string;
  method: string;
  pathPattern: string;
  direction: "IN" | "OUT";
  count: number;
  durations: number[];
  statusCodes: Map<number, number>;
  examples: string[];
}

interface SqlGroup {
  host: string;
  operation: string;
  queryPattern: string;
  count: number;
  durations: number[];
  examples: string[];
  hasErrors: boolean;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Parse a single RRPair file. Handles two on-disk formats:
 *   .json  — bare JSON (Postgres, etc.)
 *   .md    — markdown wrapper with `### REQUEST ###` / `### RESPONSE ###`
 *            sections plus an embedded `json: {...}` fence near the end.
 *
 * For HTTP .md files the embedded JSON carries `duration` and `ts` but NOT
 * the HTTP method, URL, or status code — those live in the markdown headers.
 * We extract them separately and merge them into the parsed record.
 */
function parseRRPairFile(raw: string): RawRRPair | null {
  const trimmed = raw.trim();

  // Pure JSON files
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as RawRRPair;
    } catch {
      return null;
    }
  }

  // ── Markdown files ──────────────────────────────────────────────────────

  // Extract HTTP method + URL from the REQUEST section header line
  // e.g.  GET https://radar.speedscale.com:3000/api/accounts HTTP/1.1
  const methodUrlMatch = trimmed.match(
    /###\s*REQUEST\s*###[\s\S]*?```[^\n]*\n(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(https?:\/\/[^\s]+)/i,
  );

  // Extract HTTP status code from the RESPONSE section header line
  // e.g.  HTTP/1.1 200 OK
  const statusCodeMatch = trimmed.match(
    /###\s*RESPONSE\s*###[\s\S]*?```[^\n]*\nHTTP\/\d(?:\.\d)?\s+(\d{3})/i,
  );

  // Try to extract the embedded RRPair JSON (carries ts, duration, direction, etc.)
  let base: RawRRPair | null = null;

  const fenceMatch = trimmed.match(/```\s*\njson:\s*(\{[\s\S]*?\})\s*\n```/);
  if (fenceMatch) {
    try {
      base = JSON.parse(fenceMatch[1]) as RawRRPair;
    } catch { /* fall through */ }
  }

  if (!base) {
    // Fallback: scan for `"msgType":"rrpair"` JSON object
    const idx = trimmed.indexOf('"msgType"');
    if (idx !== -1) {
      let start = idx;
      while (start > 0 && trimmed[start] !== "{") start--;
      try {
        const candidate = trimmed.slice(start);
        const end = findMatchingBrace(candidate, 0);
        if (end !== -1) {
          base = JSON.parse(candidate.slice(0, end + 1)) as RawRRPair;
        }
      } catch { /* give up */ }
    }
  }

  // If this is an HTTP file, merge the markdown-extracted HTTP fields
  if (methodUrlMatch || statusCodeMatch) {
    if (!base) {
      base = { l7protocol: "http", direction: "IN" };
    }
    if (methodUrlMatch) {
      const [, method, url] = methodUrlMatch;
      base.http = {
        ...base.http,
        request: { method, url },
      };
    }
    if (statusCodeMatch) {
      const statusCode = parseInt(statusCodeMatch[1], 10);
      base.http = {
        ...base.http,
        response: { statusCode },
      };
    }
    // Ensure l7protocol is set
    if (!base.l7protocol) base.l7protocol = "http";
  }

  return base;
}

/** Find the index of the closing brace that matches the opening `{` at `start`. */
function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Normalise an HTTP URL path for grouping.
 * Replaces UUIDs, numeric IDs, and long hex strings with `{id}`.
 */
function normalizeHttpPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `http://x${rawUrl}`);
    let p = u.pathname;
    // UUID
    p = p.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/{id}");
    // Pure numeric segments of any length (e.g. /items/3, /messages/1234567)
    p = p.replace(/\/\d+(?=[/?#]|$)/g, "/{id}");
    // Hex IDs (≥10 chars)
    p = p.replace(/\/[0-9a-f]{10,}/gi, "/{id}");
    // Long alphanumeric IDs (≥16 chars) — Gmail message IDs, etc.
    p = p.replace(/\/[A-Za-z0-9]{16,}/g, "/{id}");
    return p;
  } catch {
    return rawUrl;
  }
}

/** Stable, short fingerprint for dedup — not cryptographic, just consistent. */
function fingerprint(kind: SignalKind, host: string, pattern: string): string {
  const raw = `${kind}:${host}:${pattern}`;
  // djb2-style hash → 8 hex chars
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentiles(sorted: number[]): LatencyStats {
  if (sorted.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const at = (pct: number) => sorted[Math.min(Math.floor(sorted.length * pct), sorted.length - 1)];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Walk a snapshot directory, parse all RRPair files, and return structured
 * Signals above the given thresholds.
 *
 * @param snapshotDir  Absolute path to the proxymock snapshot directory.
 * @param thresholds   Optional overrides for detection thresholds.
 * @param baseline     Optional BaselineStore for relative threshold detection.
 *                     When provided and an endpoint has ≥7 sample windows,
 *                     flags when observed p95 > 2× baseline p95 rather than
 *                     the static slowEndpointP95Ms threshold.
 */
export async function analyzeSnapshot(
  snapshotDir: string,
  thresholds: Partial<ScanThresholds> = {},
  baseline?: BaselineStore,
): Promise<ScanStats> {
  const t: ScanThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  // ── Collect all files recursively ─────────────────────────────────────────
  const allFiles: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith(".json") || e.name.endsWith(".md")) {
        allFiles.push(full);
      }
    }
  }
  await walk(snapshotDir);

  // ── Parse ─────────────────────────────────────────────────────────────────
  const httpGroups = new Map<string, HttpGroup>();
  const sqlGroups = new Map<string, SqlGroup>();
  let parsedOk = 0;
  let windowStart = "9999";
  let windowEnd = "0000";

  for (const filePath of allFiles) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const rr = parseRRPairFile(raw);
    if (!rr) continue;
    parsedOk++;

    if (rr.ts) {
      if (rr.ts < windowStart) windowStart = rr.ts;
      if (rr.ts > windowEnd) windowEnd = rr.ts;
    }

    const duration = rr.duration ?? 0;
    const proto = (rr.l7protocol ?? "").toLowerCase();

    // ── HTTP / JSON (inbound and outbound) ────────────────────────────────
    // l7protocol can be "http", "https", or "json" (proxymock labels vary)
    if (proto === "http" || proto === "https" || proto === "json") {
      const method = rr.http?.request?.method ?? "GET";
      const rawUrl = rr.http?.request?.url ?? rr.location ?? "";
      const host = extractHost(rawUrl);
      const pathPattern = normalizeHttpPath(rawUrl);
      const statusCode = rr.http?.response?.statusCode ?? (rr.status === "OK" ? 200 : 0);
      const direction = rr.direction ?? "IN";
      const key = `${direction}:${host}:${method}:${pathPattern}`;

      let g = httpGroups.get(key);
      if (!g) {
        g = { host, method, pathPattern, direction, count: 0, durations: [], statusCodes: new Map(), examples: [] };
        httpGroups.set(key, g);
      }
      g.count++;
      if (duration > 0) g.durations.push(duration);
      g.statusCodes.set(statusCode, (g.statusCodes.get(statusCode) ?? 0) + 1);
      if (g.examples.length < 3) g.examples.push(path.relative(snapshotDir, filePath));

      continue;
    }

    // ── Postgres ──────────────────────────────────────────────────────────
    if (proto === "postgres") {
      const host = rr.location?.includes("/") ? rr.location : extractHostFromFilePath(filePath, snapshotDir);
      const operation = rr.command ?? "Query";
      // Prefer mutableSignature (already normalised) if present
      const queryPattern =
        rr.mutableSignature?.["postgres:query"] ??
        normalizeQueryLiteral(rr.location ?? "");
      if (!queryPattern) continue;

      const key = `${host}:${operation}:${queryPattern}`;
      let g = sqlGroups.get(key);
      if (!g) {
        g = { host, operation, queryPattern, count: 0, durations: [], examples: [], hasErrors: false };
        sqlGroups.set(key, g);
      }
      g.count++;
      if (duration > 0) g.durations.push(duration);
      if (rr.status && rr.status !== "OK") g.hasErrors = true;
      if (g.examples.length < 3) g.examples.push(path.relative(snapshotDir, filePath));
    }
  }

  // ── Score signals ─────────────────────────────────────────────────────────
  const signals: Signal[] = [];
  const endpointStats: EndpointStat[] = [];

  // --- HTTP signals ---
  for (const [, g] of httpGroups) {
    const sorted = [...g.durations].sort((a, b) => a - b);
    const lat = percentiles(sorted);
    const epKey = `${g.method} ${g.pathPattern}`;

    // Accumulate endpoint stats for baseline
    if (g.direction === "IN" && sorted.length > 0) {
      const total = g.count;
      let errCnt = 0;
      for (const [code, cnt] of g.statusCodes) {
        if (code >= 400 || code === 0) errCnt += cnt;
      }
      endpointStats.push({
        key: epKey,
        p50: lat.p50, p95: lat.p95, p99: lat.p99,
        count: g.count,
        errorRate: total > 0 ? errCnt / total : 0,
      });
    }

    // N+1: high-count OUT calls to an external API
    if (g.direction === "OUT" && g.count >= t.n1MinCount) {
      const sev: Severity = g.count >= 200 ? "high" : "medium";
      signals.push({
        kind: "n+1",
        severity: sev,
        fingerprint: fingerprint("n+1", g.host, `${g.method}:${g.pathPattern}`),
        title: `N+1: ${g.count}× ${g.method} ${g.host}${g.pathPattern}`,
        details: `${g.count} individual ${g.method} calls to ${g.host}${g.pathPattern} in the capture window. ` +
          `p95=${lat.p95}ms, max=${lat.max}ms. Pattern suggests a per-item loop rather than batch/bulk fetch.`,
        evidence: { host: g.host, pattern: `${g.method}:${g.pathPattern}`, count: g.count, latency: lat, examples: g.examples },
      });
    }

    // Slow inbound endpoint — use relative threshold when baseline available
    if (g.direction === "IN" && sorted.length >= 2) {
      const bl = baseline?.getBaseline(epKey) ?? null;
      // Relative: flag when 2× baseline p95 AND above 500ms floor
      // Static fallback: use configured threshold
      const isSlowRelative = bl && lat.p95 >= bl.p95 * 2 && lat.p95 >= 500;
      const isSlowStatic = !bl && lat.p95 >= t.slowEndpointP95Ms;

      if (isSlowRelative || isSlowStatic) {
        const sev: Severity = lat.p95 >= 3000 ? "high" : lat.p95 >= 1500 ? "medium" : "low";
        const baselineNote = bl
          ? ` (baseline p95=${bl.p95}ms over ${bl.sampleWindows} windows)`
          : "";
        signals.push({
          kind: "slow-endpoint",
          severity: sev,
          fingerprint: fingerprint("slow-endpoint", g.host, `${g.method}:${g.pathPattern}`),
          title: `Slow endpoint: ${g.method} ${g.pathPattern} p95=${lat.p95}ms`,
          details: `${g.count} requests to ${g.method} ${g.pathPattern}. p50=${lat.p50}ms p95=${lat.p95}ms p99=${lat.p99}ms max=${lat.max}ms.${baselineNote}`,
          evidence: {
            host: g.host, pattern: `${g.method}:${g.pathPattern}`, count: g.count, latency: lat, examples: g.examples,
            ...(bl ? { baseline: { p95: bl.p95, sampleWindows: bl.sampleWindows } } : {}),
          },
        });
      }
    }

    // Error rate
    const total = g.count;
    let errorCount = 0;
    for (const [code, cnt] of g.statusCodes) {
      if (code >= 400 || code === 0) errorCount += cnt;
    }
    const errorRate = total > 0 ? errorCount / total : 0;
    if (errorCount >= t.minErrorCount && errorRate >= t.minErrorRate) {
      const sev: Severity = errorRate >= 0.5 ? "high" : errorRate >= 0.1 ? "medium" : "low";
      // Collect non-200 codes for display
      const codeSummary = [...g.statusCodes.entries()]
        .filter(([c]) => c !== 200 && c !== 304)
        .map(([c, n]) => `${c}×${n}`)
        .join(", ");
      signals.push({
        kind: "errors",
        severity: sev,
        fingerprint: fingerprint("errors", g.host, `${g.method}:${g.pathPattern}`),
        title: `Errors: ${g.method} ${g.pathPattern} — ${(errorRate * 100).toFixed(0)}% non-2xx (${codeSummary})`,
        details: `${errorCount}/${total} requests returned errors. Status breakdown: ${codeSummary}. p95 latency=${lat.p95}ms.`,
        evidence: { host: g.host, pattern: `${g.method}:${g.pathPattern}`, count: g.count, errorRate, latency: lat, examples: g.examples },
      });
    }
  }

  // --- SQL signals ---
  for (const [, g] of sqlGroups) {
    // Only look at Prepare Statement or Query (skip Bind/Execute/Describe noise)
    if (!["Prepare Statement", "Query", "Execute Prepared Statement"].includes(g.operation)) continue;

    const sorted = [...g.durations].sort((a, b) => a - b);
    const lat = percentiles(sorted);

    // Accumulate SQL stats for baseline
    if (sorted.length > 0) {
      endpointStats.push({
        key: `sql:${g.queryPattern}`,
        p50: lat.p50, p95: lat.p95, p99: lat.p99,
        count: g.count,
        errorRate: 0,
      });
    }

    // High-frequency query
    if (g.count >= t.highFreqSqlMinCount) {
      const sev: Severity = g.count >= 1000 ? "high" : g.count >= 200 ? "medium" : "low";
      signals.push({
        kind: "high-freq-query",
        severity: sev,
        // SQL fingerprints omit host — the query text alone is the discriminator.
        // DB hostnames vary between scan windows (IP vs DNS alias for the same RDS
        // instance), causing the same query to get a different fingerprint each run
        // and bypassing the Linear dedup check. HTTP signals keep the host because
        // different services share path patterns; SQL does not have that problem.
        fingerprint: fingerprint("high-freq-query", "", g.queryPattern),
        title: `High-frequency query: ${g.count}× — ${g.queryPattern.slice(0, 80)}`,
        details: `Query executed ${g.count} times in the capture window. p50=${lat.p50}ms p95=${lat.p95}ms. ` +
          `Even at low per-call cost, this volume indicates a missing cache or per-item loop. Query: ${g.queryPattern}`,
        evidence: { host: g.host, pattern: g.queryPattern, count: g.count, latency: lat, examples: g.examples },
      });
    }

    // Slow individual query (at least one occurrence)
    const maxDur = lat.max;
    if (maxDur >= t.slowQueryMs && sorted.length >= 1) {
      const sev: Severity = maxDur >= 1000 ? "high" : maxDur >= 500 ? "medium" : "low";
      signals.push({
        kind: "slow-query",
        severity: sev,
        fingerprint: fingerprint("slow-query", "", g.queryPattern),  // host omitted — see high-freq-query comment above
        title: `Slow query: max=${maxDur}ms — ${g.queryPattern.slice(0, 80)}`,
        details: `Query hit ${maxDur}ms in at least one execution (p95=${lat.p95}ms across ${g.count} executions). ` +
          `Likely missing index or full-table scan. Query: ${g.queryPattern}`,
        evidence: { host: g.host, pattern: g.queryPattern, count: g.count, latency: lat, examples: g.examples },
      });
    }
  }

  // ── Deduplicate by fingerprint (same query as Prepare + Execute = one signal) ──
  const seenFp = new Set<string>();
  const uniqueSignals = signals.filter((s) => {
    if (seenFp.has(s.fingerprint)) return false;
    seenFp.add(s.fingerprint);
    return true;
  });

  // ── Sort: high first, then by count descending ────────────────────────────
  const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  uniqueSignals.sort((a, b) => {
    const sr = severityRank[a.severity] - severityRank[b.severity];
    return sr !== 0 ? sr : b.evidence.count - a.evidence.count;
  });

  return {
    snapshotDir,
    windowStart: windowStart === "9999" ? "" : windowStart,
    windowEnd: windowEnd === "0000" ? "" : windowEnd,
    totalFiles: allFiles.length,
    parsedOk,
    signals: uniqueSignals,
    endpointStats,
  };
}

// ── Minor helpers ─────────────────────────────────────────────────────────────

function extractHost(rawUrl: string): string {
  try {
    return new URL(rawUrl.startsWith("http") ? rawUrl : `http://x${rawUrl}`).host;
  } catch {
    return rawUrl.split("/")[0];
  }
}

function extractHostFromFilePath(filePath: string, snapshotDir: string): string {
  const rel = path.relative(snapshotDir, filePath);
  return rel.split(path.sep)[0];
}

/**
 * Cheap normalisation for raw SQL strings when mutableSignature is absent.
 * Collapses literals and parameter placeholders.
 */
function normalizeQueryLiteral(sql: string): string {
  return sql
    .replace(/'[^']*'/g, "'?'")
    .replace(/\$\d+/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
