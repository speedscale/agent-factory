/**
 * Spec classifier — decides whether a ticket is best dispatched to the
 * traffic-mode Planner (wire evidence, metric-driven) or the source-mode
 * Planner (code evidence, source-level assertion).
 *
 * The classifier is intentionally heuristic. It looks at four signals:
 *   1. Whether a snapshot directory is available and non-empty
 *   2. Labels on the ticket (Component: tags, perf/latency tags)
 *   3. Keyword density in title + body for traffic vs source shapes
 *   4. Explicit operator override (--mode flag)
 *
 * Output:
 *   - "traffic"  — wire-shaped, dispatch to current Planner
 *   - "source"   — non-wire-shaped, dispatch to source-mode Planner
 *   - "mixed"    — both shapes present; caller decides whether to split
 *                  into two dispatches or pick one based on dominant signal
 */

export type SpecMode = "traffic" | "source" | "mixed";

export interface ClassifierInput {
  title: string;
  body: string;
  labels?: string[];
  /** True when a snapshot directory was supplied AND contains RRPair files. */
  snapshotAvailable?: boolean;
}

export interface ClassifierResult {
  mode: SpecMode;
  /** 0..1, higher = more confident. < 0.6 means caller should consider splitting. */
  confidence: number;
  /** Human-readable reason trail; goes into the run record. */
  rationale: string[];
  /** Raw scores so callers can debug or override. */
  scores: { traffic: number; source: number };
}

/** Keywords that imply a wire-observable bug. */
const TRAFFIC_KEYWORDS = [
  "latency", "p50", "p95", "p99", "throughput", "qps", "rps",
  "429", "500", "503", "504", "error rate", "5xx", "4xx",
  "timeout", "burst", "concurrent", "concurrency", "rate limit",
  "slow endpoint", "slow query", "slow request", "n+1",
  "missing field", "wrong status", "wrong payload", "wrong response",
  "snapshot", "rrpair", "rrpairs", "proxymock"
];

/** Keywords that imply a structural/source-only bug. */
const SOURCE_KEYWORDS = [
  "log", "logs", "log line", "log message", "log level",
  "missing log", "no log", "logs not present", "no logs in",
  "cli flag", "command flag", "--dry-run", "dry run", "dry-run",
  "help text", "output formatting", "stdout", "stderr",
  "boot crash", "startup", "init order", "boot ordering",
  "feature flag", "config option", "env var", "environment variable",
  "schema migration", "migration order", "fk constraint", "foreign key",
  "telemetry", "metric tag", "event tag", "test_report_id", "testreportid",
  "report_events", "clickhouse insert", "indexer", "firehose",
  "documentation", "doc only", "rename", "refactor", "comment",
  "unit test", "test coverage"
];

/** Label patterns that lean source. */
const SOURCE_LABEL_PATTERNS = [
  /^doc/i,
  /^docs:/i,
  /^cli/i,
  /^cleanup/i,
  /^refactor/i,
  /^chore/i,
  /^telemetry/i,
  /^logging/i
];

/** Label patterns that lean traffic. */
const TRAFFIC_LABEL_PATTERNS = [
  /^perf/i,
  /^performance/i,
  /^latency/i,
  /^throughput/i,
  /^scaling/i
];

function countMatches(text: string, keywords: string[]): { hits: number; matched: string[] } {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const kw of keywords) {
    // Word-ish match — accept the keyword surrounded by anything but a letter/digit on either side.
    // Keeps "log" from matching "loginflow" but lets "no logs in" match.
    const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(lower)) matched.push(kw);
  }
  return { hits: matched.length, matched };
}

export function classifySpec(input: ClassifierInput): ClassifierResult {
  const rationale: string[] = [];
  const text = `${input.title}\n${input.body}`;

  // Keyword signal
  const traffic = countMatches(text, TRAFFIC_KEYWORDS);
  const source = countMatches(text, SOURCE_KEYWORDS);

  let trafficScore = traffic.hits;
  let sourceScore = source.hits;

  if (traffic.hits > 0) rationale.push(`traffic keywords: ${traffic.matched.slice(0, 5).join(", ")}`);
  if (source.hits > 0) rationale.push(`source keywords: ${source.matched.slice(0, 5).join(", ")}`);

  // Label signal — each matching label adds 2 (stronger than a keyword hit).
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (SOURCE_LABEL_PATTERNS.some((re) => re.test(label))) {
      sourceScore += 2;
      rationale.push(`source label: ${label}`);
    }
    if (TRAFFIC_LABEL_PATTERNS.some((re) => re.test(label))) {
      trafficScore += 2;
      rationale.push(`traffic label: ${label}`);
    }
  }

  // Snapshot availability — only counts as a traffic signal when there's
  // already at least one traffic keyword to corroborate it. Operators
  // frequently attach a snapshot speculatively even on structural bugs, so
  // unconditional boosting flips clearly-source tickets into mixed.
  if (input.snapshotAvailable && trafficScore > 0) {
    trafficScore += 1;
    rationale.push("snapshot directory present (corroborates traffic keywords)");
  } else if (!input.snapshotAvailable) {
    sourceScore += 1;
    rationale.push("no snapshot directory");
  } else {
    rationale.push("snapshot directory present (ignored: no traffic keywords)");
  }

  // Decide. "mixed" means both sides have non-trivial signal *and* neither
  // overwhelmingly dominates — minority share >= 30% of the total. This catches
  // the real workflow case: a ticket with a clear wire bug plus an unrelated
  // CLI/log requirement bolted on.
  let mode: SpecMode;
  const total = trafficScore + sourceScore;
  const minority = Math.min(trafficScore, sourceScore);
  const dominantShare = total > 0 ? Math.max(trafficScore, sourceScore) / total : 0.5;
  const minorityShare = total > 0 ? minority / total : 0;

  if (total === 0) {
    // Nothing to go on — default to source mode (safer: no harness to fake).
    mode = "source";
    rationale.push("no signals — defaulting to source mode");
  } else if (trafficScore >= 2 && sourceScore >= 2 && minorityShare >= 0.3) {
    mode = "mixed";
    rationale.push(`both shapes present (traffic=${trafficScore}, source=${sourceScore}, minority share=${minorityShare.toFixed(2)})`);
  } else if (trafficScore > sourceScore) {
    mode = "traffic";
    rationale.push(`traffic dominant (traffic=${trafficScore}, source=${sourceScore})`);
  } else {
    mode = "source";
    rationale.push(`source dominant (traffic=${trafficScore}, source=${sourceScore})`);
  }

  return {
    mode,
    confidence: dominantShare,
    rationale,
    scores: { traffic: trafficScore, source: sourceScore }
  };
}
