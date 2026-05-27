/**
 * signal-correlator — merge related signals into incidents before Pass 2.
 *
 * When a slow HTTP endpoint and a slow SQL query are causally related
 * (endpoint p95 ≈ query max latency), filing them as two separate tickets
 * forces engineers to connect the dots manually.
 *
 * This module runs between Pass 1 (rrpair-stats) and Pass 2 (traffic-scanner).
 * It returns the same Signal shape but may:
 *   - Merge slow-endpoint + slow-query pairs into an "incident" signal
 *   - Merge slow-query signals that target the same DB table
 *
 * Unrelated signals pass through unchanged.
 */

import { type Signal, type SignalKind, type Severity } from "./rrpair-stats.js";

// ── Correlation rules ─────────────────────────────────────────────────────────

/**
 * Merge related signals into incident signals where appropriate.
 *
 * Rules applied in order:
 *  1. slow-endpoint + slow-query where endpoint.p95 ≤ 2× query.max → "incident"
 *  2. Multiple slow-query signals sharing the same primary table → one "incident"
 *
 * Merged signals take the highest severity of their components.
 * A combined fingerprint is computed as a djb2 hash of sorted component fingerprints.
 */
export function correlateSignals(signals: Signal[]): Signal[] {
  const used = new Set<string>(); // fingerprints consumed into incidents
  const incidents: Signal[] = [];

  const slowEndpoints = signals.filter((s) => s.kind === "slow-endpoint");
  const slowQueries = signals.filter((s) => s.kind === "slow-query");
  const others = signals.filter((s) => s.kind !== "slow-endpoint" && s.kind !== "slow-query");

  // Rule 1: slow-endpoint + slow-query where latencies are correlated
  for (const ep of slowEndpoints) {
    if (used.has(ep.fingerprint)) continue;
    const epP95 = ep.evidence.latency?.p95 ?? 0;

    // Find slow queries whose max latency accounts for a significant portion
    // of the endpoint's p95 (i.e. the query is likely in the hot path)
    const correlated = slowQueries.filter((q) => {
      if (used.has(q.fingerprint)) return false;
      const qMax = q.evidence.latency?.max ?? 0;
      return qMax > 0 && epP95 > 0 && qMax >= epP95 * 0.3 && qMax <= epP95 * 2.5;
    });

    if (correlated.length === 0) continue;

    // Merge: mark all as used, create incident
    used.add(ep.fingerprint);
    for (const q of correlated) used.add(q.fingerprint);

    const components = [ep, ...correlated];
    incidents.push(buildIncident(components, "slow-endpoint"));
  }

  // Rule 2: slow-query signals sharing the same primary table
  const unconsumedQueries = slowQueries.filter((q) => !used.has(q.fingerprint));
  const byTable = new Map<string, Signal[]>();
  for (const q of unconsumedQueries) {
    const table = extractPrimaryTable(q.evidence.pattern);
    if (!table) continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push(q);
  }

  for (const [, group] of byTable) {
    if (group.length < 2) continue; // single query — not worth merging
    // Check none were already used
    if (group.some((q) => used.has(q.fingerprint))) continue;
    for (const q of group) used.add(q.fingerprint);
    incidents.push(buildIncident(group, "slow-query"));
  }

  // Preserve unconsumed signals unchanged
  const unconsumed = signals.filter((s) => !used.has(s.fingerprint));

  return [...incidents, ...unconsumed];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildIncident(components: Signal[], primaryKind: SignalKind): Signal {
  // Take highest severity
  const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  components.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const topSeverity = components[0].severity;

  // Stable combined fingerprint: hash of sorted component fingerprints
  const sortedFps = [...components.map((c) => c.fingerprint)].sort();
  const combinedFp = djb2(sortedFps.join(":"));

  // Build title from primary signal + count of correlated
  const primary = components[0];
  const rest = components.slice(1);
  const title = rest.length === 1
    ? `Incident: ${primary.title} + ${rest[0].evidence.pattern.slice(0, 40)}`
    : `Incident: ${primary.title} (+${rest.length} correlated)`;

  // Build details listing all components
  const details = [
    `Correlated signals (${components.length} root causes for the same performance problem):`,
    ...components.map((c, i) => `  ${i + 1}. [${c.kind}] ${c.title}`),
    "",
    "Fix the underlying cause — they likely share the same hot code path.",
  ].join("\n");

  // Aggregate evidence: highest count, worst latency
  const totalCount = components.reduce((sum, c) => sum + c.evidence.count, 0);
  const maxP95 = Math.max(...components.map((c) => c.evidence.latency?.p95 ?? 0));
  const maxP99 = Math.max(...components.map((c) => c.evidence.latency?.p99 ?? 0));
  const maxVal = Math.max(...components.map((c) => c.evidence.latency?.max ?? 0));
  const allExamples = components.flatMap((c) => c.evidence.examples).slice(0, 3);

  return {
    kind: "incident" as SignalKind,
    severity: topSeverity,
    fingerprint: combinedFp,
    title: title.slice(0, 120),
    details,
    evidence: {
      host: primary.evidence.host,
      pattern: components.map((c) => c.evidence.pattern).join(" | "),
      count: totalCount,
      latency: maxP95 > 0 ? { p50: 0, p95: maxP95, p99: maxP99, max: maxVal } : undefined,
      examples: allExamples,
    },
    components,
  } as Signal & { components: Signal[] };
}

/**
 * Extract the primary table name from a SQL pattern.
 * e.g. "SELECT * FROM meeting_notes WHERE ..." → "meeting_notes"
 */
function extractPrimaryTable(pattern: string): string | null {
  const m = pattern.match(/\bFROM\s+([a-z_][a-z0-9_]*)/i)
    ?? pattern.match(/\bUPDATE\s+([a-z_][a-z0-9_]*)/i)
    ?? pattern.match(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i);
  return m ? m[1].toLowerCase() : null;
}

/** djb2-style hash → 8 hex chars */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
