/**
 * Evaluator verdict types + final-verdict bucketing.
 *
 * The Evaluator used to return one of `pass | partial | fail`. `partial` was
 * the most common and the least informative — it fired on substantively
 * different signal classes (a load-bearing acceptance miss vs. tests that
 * merely matched the established-but-shallow codebase pattern) and demanded
 * the same response from operator and reviewer.
 *
 * We split `partial` along the dimension that actually drives reviewer
 * behavior: was the miss a hard requirement (`blocker`), or a quality bar
 * the patch didn't exceed but is still in line with what the spec asked
 * for (`soft`)? The overall verdict surfaces the worst-severity miss:
 *
 *   pass             — no misses, harness trustworthy
 *   partial-soft     — only soft misses, harness trustworthy
 *   partial-blocker  — at least one blocker miss OR harness not trustworthy
 *   fail             — Evaluator judges the core fix missing / patch wrong /
 *                      destructive rewrite detected
 *
 * `fail` always wins over partial buckets — if the Evaluator says the core
 * fix is missing, that's not a "blocker miss," it's a wrong patch.
 *
 * The final verdict is DERIVED from the structured misses + harness flag
 * rather than trusted from the Evaluator's self-graded field. The Evaluator
 * still emits its own verdict (we use it to detect `fail`), but per-bucket
 * partials are computed deterministically so the run record stays consistent
 * with the misses it lists.
 */

export type MissSeverity = "blocker" | "soft";

export interface MissedRequirement {
  /** Verbatim or near-verbatim quote of the unmet requirement from the spec. */
  text: string;
  /**
   * `blocker` — load-bearing acceptance criterion the spec explicitly called
   * out; a reviewer will reject the MR until it's satisfied.
   *
   * `soft` — quality bar the patch didn't exceed but matched (or nearly
   * matched) established codebase patterns the spec told the Worker to
   * mirror. Worth a follow-up, not a blocker.
   */
  severity: MissSeverity;
  /** One short sentence on why this severity. Optional but recommended. */
  reason?: string;
}

export type FinalVerdict = "pass" | "partial-soft" | "partial-blocker" | "fail";

/**
 * Derive the final verdict from the structured misses + harness flag,
 * with the Evaluator's own verdict acting only as a `fail` override.
 *
 * Why derive: a `partial` verdict with only soft misses should not look the
 * same as a `partial` with a blocker miss. Deriving in code (rather than
 * trusting the model to bucket itself) keeps the verdict consistent with
 * the misses list — there's no way for the run record to say "partial-soft"
 * while the misses array contains a blocker.
 */
export function computeFinalVerdict(
  modelVerdict: string,
  misses: MissedRequirement[],
  confirmHarnessTrustworthy: boolean
): FinalVerdict {
  // The model's `fail` is load-bearing — it means "core fix missing" or
  // "destructive rewrite," not a recoverable partial. Preserve it.
  if (modelVerdict === "fail") return "fail";

  const hasBlockerMiss = misses.some((m) => m.severity === "blocker");
  const hasSoftMiss = misses.some((m) => m.severity === "soft");

  // An untrustworthy confirm harness is always a blocker — the patch may
  // be correct but we have no way to prove it without the harness.
  if (hasBlockerMiss || !confirmHarnessTrustworthy) return "partial-blocker";
  if (hasSoftMiss) return "partial-soft";
  return "pass";
}

/**
 * Render a missed-requirement list for human display. Groups blockers first
 * so a reviewer scanning the report sees the load-bearing items before any
 * soft follow-ups.
 */
export function formatMisses(misses: MissedRequirement[]): string {
  if (misses.length === 0) return "  (none)";
  const blockers = misses.filter((m) => m.severity === "blocker");
  const softs = misses.filter((m) => m.severity === "soft");
  const lines: string[] = [];
  for (const m of blockers) {
    lines.push(`  [BLOCKER] ${m.text}${m.reason ? ` — ${m.reason}` : ""}`);
  }
  for (const m of softs) {
    lines.push(`  [soft]    ${m.text}${m.reason ? ` — ${m.reason}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * One-line gloss of the verdict suitable for a log line or MR title prefix.
 */
export function verdictGloss(verdict: FinalVerdict): string {
  switch (verdict) {
    case "pass": return "PASS — all requirements addressed, harness trustworthy";
    case "partial-soft": return "PARTIAL (soft only) — patch matches codebase pattern; follow-ups noted";
    case "partial-blocker": return "PARTIAL (BLOCKER) — at least one load-bearing acceptance criterion missed";
    case "fail": return "FAIL — core fix missing or patch is wrong";
  }
}
