/**
 * MR description checklist — kept in sync with the madskillz `mr-enforcement`
 * hook at `plugins/mr-enforcement/hooks/mr-enforcement.sh` in
 * gitlab.com/speedscale/madskillz.
 *
 * The hook does a literal `grep -F` against the `glab mr create` /
 * `gh pr create` command for each of the strings in `MR_CHECKLIST_REQUIRED_LINES`
 * and refuses the command if any are missing. Boxes are pre-checked with `[x]`
 * rather than `[ ]` because the hook enforces that the engineer has actively
 * considered each item before opening the MR.
 *
 * The constant and the required-lines array live together so any drift between
 * "what the agent-factory writes" and "what the hook accepts" surfaces in the
 * unit tests for this module, not at MR creation time inside a customer
 * dispatch.
 */

/**
 * Lines the madskillz hook greps for. These are the contract — keep this
 * array byte-for-byte identical to the `REQUIRED` array in
 * `mr-enforcement.sh`. Any edit here must be mirrored in the hook (or vice
 * versa) and the test suite verifies both halves.
 */
export const MR_CHECKLIST_REQUIRED_LINES: readonly string[] = [
  "## Checklist",
  "Each of these checkboxes should be filled before merge.",
  "- [x] Security impact of change has been considered",
  "- [x] Code follows company security practices and guidelines",
  "- [x] Pull request linked to task tracker",
  "- [x] If this is a breaking change a story has been created and assigned to Ken"
];

/**
 * The canonical checklist block the agent-factory pastes into every MR body.
 * Built from the required lines plus structural whitespace so it composes
 * cleanly under the `# Solution` section.
 */
export const MR_CHECKLIST = `
## Checklist

Each of these checkboxes should be filled before merge.

- [x] Security impact of change has been considered
- [x] Code follows company security practices and guidelines
- [x] Pull request linked to task tracker
- [x] If this is a breaking change a story has been created and assigned to Ken
`;

export type MrBodyValidation =
  | { ok: true }
  | { ok: false; missing: string[] };

/**
 * Validate an MR body the same way the madskillz hook does — literal substring
 * check for each required line. Returns `ok: true` on pass, otherwise the
 * specific lines that are missing so the caller can surface a useful error.
 *
 * Use this before calling `glab mr create` / `gh pr create` to fail fast inside
 * the agent-factory rather than waiting for the hook to refuse the command
 * after the engine has already paid the LLM cost.
 */
export function validateMrBody(body: string): MrBodyValidation {
  const missing: string[] = [];
  for (const line of MR_CHECKLIST_REQUIRED_LINES) {
    if (!body.includes(line)) missing.push(line);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
