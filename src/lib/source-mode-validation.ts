/**
 * Source-mode reproduce-gate validation.
 *
 * Traffic mode has "no metric = no fix" as a hard rule: the Planner must
 * measure the failing baseline on the unpatched code before any fix is
 * written. Source mode needs the equivalent: the Planner must prove the
 * `failingAssertion` is actually false today by running a harness that fails
 * on the unpatched worktree.
 *
 * If the Planner's harness exits 0 (passes), the asserted bug doesn't exist
 * and the run must be aborted — exactly the failure mode we hit on the first
 * real source-mode dispatch, where agent-factory wrote a fix for a bug that
 * had already been resolved months earlier.
 */

export interface BaselineEvidence {
  /** Absolute path to the harness script the Planner wrote and the Worker will re-run. */
  harnessPath: string;
  /** Exit code observed when the Planner ran the harness against the unpatched worktree. MUST be non-zero. */
  exitCode: number;
  /** Trimmed stdout/stderr from the harness run. Used by the Evaluator to grade pre-fix evidence. */
  output: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Returns ok=true if the planner's evidence demonstrates a failing harness
 * (the bug exists). Returns ok=false with a human-readable reason otherwise.
 *
 * Rules:
 * - Missing harnessPath → reject (planner skipped the reproduce step entirely)
 * - exitCode === 0 → reject (harness passed; assertion refuted; bug doesn't exist as described)
 * - exitCode is not a finite number → reject (malformed evidence)
 * - Any other non-zero exit code → accept
 *
 * Empty output is allowed — some harnesses fail silently (e.g. `grep -q` that
 * returns 1 with no stdout). The exit code is the load-bearing signal.
 */
export function validateBaselineEvidence(evidence: Partial<BaselineEvidence>): ValidationResult {
  if (!evidence.harnessPath || evidence.harnessPath.trim() === "") {
    return {
      ok: false,
      reason: "missing baselineEvidence.harnessPath — Planner must write a harness file and report its path"
    };
  }
  if (typeof evidence.exitCode !== "number" || !Number.isFinite(evidence.exitCode)) {
    return {
      ok: false,
      reason: `baselineEvidence.exitCode must be a finite number, got ${JSON.stringify(evidence.exitCode)}`
    };
  }
  if (evidence.exitCode === 0) {
    return {
      ok: false,
      reason: "baseline harness passed (exit 0) on unpatched code — the asserted bug does not exist, refusing to write a fix for a non-existent issue"
    };
  }
  return { ok: true };
}
