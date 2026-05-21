/**
 * Normalized RRPair view used by the fingerprint computation.
 *
 * Source-agnostic — proxymock pulled-snapshots, search_traffic results, and
 * synthetic test data all reduce to this shape. File-format-specific loaders
 * live separately and emit RRPair[] for the fingerprinter to consume.
 */
export interface RRPair {
  /** Stable identifier (file path, hash, or proxymock record ID). */
  id: string;
  /** HTTP method (uppercase) or protocol-equivalent. */
  method: string;
  /** Path or URL of the request (just the path; query string stripped is fine). */
  path: string;
  /** Numeric status code (200, 429, 500…). For non-HTTP, use a domain-equivalent. */
  status: number;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
  /** RFC3339 timestamp the request was observed. */
  occurredAt: string;
  /** Optional service name (proxymock service registry). */
  service?: string;
  /** Optional cluster name (proxymock cluster registry). */
  cluster?: string;
}
