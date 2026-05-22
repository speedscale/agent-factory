/**
 * Repro-context detector.
 *
 * Answers: "does the ticket reference external reproduction context that the
 * engine would need to honor a proper reproduce → fix → re-demonstrate loop?"
 *
 * "Repro context" is intentionally broad. It includes:
 *   - HTTP traffic captures (HAR, Postman, VCR cassettes, mitmproxy flows, proxymock recordings)
 *   - Network captures (pcap, tcpdump output, Wireshark references)
 *   - Inline reproductions (curl/HTTPie commands with URLs)
 *   - Log captures (concrete file paths, kubectl/docker/journalctl output dumps)
 *   - Distributed traces (trace IDs, Jaeger/Zipkin/Tempo/Honeycomb URLs, APM links)
 *   - Stack traces and crash captures (Sentry issue URLs, multi-line trace patterns)
 *   - Reproducer projects ("minimal reproducer", MRE, dedicated repro repos)
 *
 * Used as a safety net before dispatching source mode: if the ticket clearly
 * references external repro context but the operator didn't supply it to the
 * engine, source mode falls back to a synthetic Planner-authored harness,
 * which produces a circular reproduce gate (the same LLM authors both the
 * failing assertion and the harness that proves it false).
 *
 * The detector is deliberately precision-biased — it only fires on patterns
 * that strongly imply a concrete artifact, not on casual mentions ("we should
 * add log files" doesn't match; "see /var/log/app.log" does).
 *
 * The patterns are not tied to any single capture tool. Speedscale-flavored
 * signals (proxymock recordings, RRPair) are present alongside HAR, Postman,
 * VCR, etc. — they're one source of repro context among many.
 */

export interface ReproContextResult {
  /** True when the ticket references external repro context. */
  detected: boolean;
  /** Up to 5 distinct matched signal names, for the error/log message. */
  signals: string[];
}

interface ArtifactPattern {
  /** Human-readable category name shown in the diagnostic. */
  name: string;
  /** Regex applied to `${title}\n${body}`. */
  re: RegExp;
}

/**
 * Order is roughly: most specific / least false-positive-prone first. The
 * detector caps reported signals at 5, so the most useful diagnostic names
 * surface first when many patterns hit at once.
 */
const ARTIFACT_PATTERNS: ArtifactPattern[] = [
  // ---- HTTP traffic captures ----
  { name: "HAR file", re: /\.har\b/i },
  { name: "Postman collection file", re: /\.postman_(?:collection|environment)\.json\b/i },
  { name: "Postman collection reference", re: /\bpostman\s+(?:collection|workspace|environment)\b/i },
  { name: "VCR cassette", re: /\bcassettes?\/[\w./-]+\.ya?ml\b/i },
  { name: "mitmproxy capture", re: /\bmitm(?:proxy|dump|web)\b|\.mitm\b/i },
  { name: "proxymock recording dir", re: /\brecorded-\d{4}-\d{2}-\d{2}[_T]\d{2}-?\d{2}-?\d{2}[\d.]*Z?/ },
  { name: "proxymock mock dir", re: /\bmocked-\d{4}-\d{2}-\d{2}[_T]\d{2}-?\d{2}-?\d{2}[\d.]*Z?/ },
  { name: "RRPair reference", re: /\b[Rr][Rr]Pairs?\b/ },
  { name: "proxymock CLI command", re: /\bproxymock\s+(?:mock|record|replay)\b/i },

  // ---- Inline HTTP repros ----
  // curl with an actual URL (not bare `curl` in prose).
  { name: "curl command (with URL)", re: /\bcurl\s+(?:-\S+\s+)*['"]?https?:\/\/\S+/i },
  // HTTPie: `http GET https://...` or `https GET ...`.
  { name: "HTTPie command", re: /(?:^|\s)https?\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\S+/im },

  // ---- Network captures ----
  { name: "packet capture", re: /\.pcapn?g?\b|\btcpdump\b|\bwireshark\b/i },

  // ---- Logs (concrete paths or capture commands, not casual mentions) ----
  { name: "log file path", re: /\/var\/log\/[\w./-]+|\/var\/lib\/docker\/containers\/[\w./-]+/ },
  { name: "kubectl/pod logs", re: /\bkubectl\s+logs\b|\bpod\/[a-z0-9-]+\s+logs?\b/i },
  { name: "container/system log dump", re: /\b(?:journalctl|docker\s+logs)\b/i },

  // ---- Distributed traces ----
  { name: "trace ID", re: /\btrace[\s_-]?id[:=]\s*[a-f0-9]{16,32}\b/i },
  { name: "tracing UI URL", re: /\b(?:jaeger|zipkin|tempo|honeycomb)[\w.-]*\/(?:trace|ui)\b/i },
  { name: "APM trace link", re: /\bapp\.(?:datadoghq|datadog)\.com\/apm\b|\.newrelic\.com\/[^\s]*trace/i },

  // ---- Crash / error services ----
  { name: "Sentry issue link", re: /\bsentry\.io\/(?:organizations\/[^/]+\/)?issues\/\d+/ },
  // Multi-line stack trace patterns from common languages. Require an actual
  // source-file extension to avoid matching prose about "the trace".
  { name: "stack trace", re: /(?:^|\n)\s*(?:at\s|File\s|Caused by:|Traceback)[^\n]*\.(?:py|js|ts|tsx|go|rb|java|kt|rs|cpp|cs)\b/m },

  // ---- Reproducer projects ----
  { name: "minimal reproducer phrase", re: /\b(?:minimal\s+reproducer|MRE|repro(?:duction)?\s+(?:repo|project|case|steps))\b/i },

  // ---- Generic capture/fixture directories (catch-all, low priority) ----
  // E.g. fixtures/foo.json, recordings/x.yaml, snapshots/y.har — anything that
  // looks like a checked-in capture under a known directory convention.
  { name: "fixture/recording file", re: /\b(?:recordings?|fixtures?|snapshots?|replays?|captures?)\/[\w./-]+\.(?:har|json|ya?ml|md)\b/i }
];

/**
 * Scan `${title}\n${body}` for evidence the ticket references external repro
 * context. Returns up to 5 distinct matched signal names.
 *
 * A `false` result does NOT mean the ticket is source-only — only that it
 * lacks explicit repro-context references. Callers should still defer to
 * the spec classifier for the mode decision; this detector is a safety net
 * against silent source-mode fallback when context IS named but absent.
 */
export function detectReproContext(spec: { title: string; body: string }): ReproContextResult {
  const text = `${spec.title}\n${spec.body}`;
  const signals: string[] = [];
  for (const { name, re } of ARTIFACT_PATTERNS) {
    if (re.test(text) && !signals.includes(name)) {
      signals.push(name);
      if (signals.length >= 5) break;
    }
  }
  return { detected: signals.length > 0, signals };
}
