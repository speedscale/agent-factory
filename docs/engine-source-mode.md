# Engine source mode

Audience: Agent Factory developers.

The engine has two intake modes. Picking the right one before the run starts is the difference between a clean fix and a half-fix that leaves "obvious" requirements on the floor.

## Why two modes

The original engine was designed around wire evidence. The Planner reads RRPairs from a snapshot, names a measurable metric (latency, error rate, concurrency peak), and the Worker writes a confirm harness with **identical methodology** — same mock, same measurement, same threshold. The Evaluator gates on `confirmHarnessTrustworthy`.

This works on bugs that show up on the wire. It fails on bugs that don't:

- Telemetry / logging pipeline gaps where the bug is a missing or empty tag inside the producer, and the wire shows nothing because the request itself succeeded.
- CLI ergonomics: `--dry-run` flags, output formatting, log-level changes, help-text fixes.
- Init / migration ordering bugs that crash startup before any traffic flows.
- Structural fixes in code paths the captured snapshot doesn't exercise.

In the past these tickets either failed outright or got "split" into a second narrower dispatch as a workaround. Source mode makes that a first-class path.

## Mode summary

|  | Traffic mode | Source mode |
|---|---|---|
| Evidence | RRPairs in snapshot | Source code, source-grep, unit test |
| Planner output | `metric` + `baseline` (numbers) | `failingAssertion` + `assertionShape` |
| Confirm shape | Node script measuring metric | Unit test / source-grep / log-line / behavior-check |
| Required input | `--snapshot <dir>` | source dir only |
| Planner terminal tool | `emit_plan` | `emit_plan_source` |
| Worker terminal tool | `emit_patch` (unchanged) | `emit_patch` (unchanged) |
| Evaluator | Same loop; grades harness by shape | Same loop; grades harness by shape |

## Picking a mode

The CLI accepts `--mode auto|traffic|source` (default `auto`).

`auto` runs the spec classifier — a heuristic over the title, body, labels, and snapshot availability. It returns `traffic`, `source`, or `mixed`. On `mixed`, the runner picks the dominant signal for this dispatch and warns; the operator can re-run the residual with the other mode (or use `--mode` to override).

Operators usually want `auto`. Override to `--mode source` when:

- The ticket has rich captured snapshot data but the actual bug is in a code branch that snapshot data can't see (e.g. an indexer drops events on an empty tag — the snapshot shows the events but the bug is the discard branch in the consumer).
- The ticket is about output formatting, log content, or a CLI flag and the classifier was tripped by a stray keyword.

Override to `--mode traffic` when:

- The ticket is genuinely a wire bug but the body uses a lot of structural-sounding vocabulary (e.g. "the indexer is too slow" — that's wire-shaped, not source).

## Source-mode Planner

System prompt: `PLANNER_SOURCE_SYSTEM` (`src/lib/llm-engine.ts`). Differences vs the traffic Planner:

- No requirement to list the snapshot directory or read RRPairs.
- Required output is a "failing assertion": a single sentence that is FALSE about today's code and must be TRUE after the fix. The assertion must be falsifiable — checkable by a real test or grep, not a fuzzy goal like "the code should log better".
- Required `assertionShape`: `unit-test` | `source-grep` | `log-line` | `behavior-check`. This tells the Worker what shape of confirm to build.
- **Reproduce gate (mandatory).** The Planner must write a harness exercising the failing assertion, run it against the unpatched worktree with `run_shell`, and observe a non-zero exit. The harness path, exit code, and output go into `emit_plan_source` as `baselineHarnessPath` / `baselineExitCode` / `baselineOutput`. The same harness is reused by the Worker after the fix.

The Planner phase has `write_file` and `run_shell` available (the read-only constraint relaxed for source mode so the Planner can run a harness).

Output (`EmitPlanSourceResult`):

```typescript
{
  plan: AgentPlan;
  failingAssertion: string;  // false today, true after fix
  assertionShape: "unit-test" | "source-grep" | "log-line" | "behavior-check";
  rationale: string;
  baselineEvidence: {
    harnessPath: string;   // absolute path to the harness the Planner wrote
    exitCode: number;      // non-zero — gate rejects exit 0
    output: string;        // stdout/stderr, truncated
  };
}
```

The synthesized `AgentPlan.spec.validation.command` is the harness path itself — the contract the Worker must satisfy.

## Reproduce gate

After `emit_plan_source` returns, `runPlannerSource` calls `validateBaselineEvidence` (`src/lib/source-mode-validation.ts`). Rules:

- Missing `harnessPath` → reject (Planner skipped the step).
- `exitCode === 0` → reject (asserted bug doesn't exist; refuse to write a fix for a non-existent issue).
- `exitCode` not a finite number → reject (malformed).
- Any other non-zero → accept.

On reject, the runner throws with a message that quotes the assertion, the harness path, and the failing output. The Worker phase never starts.

This is the source-mode equivalent of traffic mode's "no metric = no fix" rule. Validator has 10 unit tests in `src/lib/source-mode-validation.test.ts`.

**Why this exists:** the first real source-mode dispatch wrote a confident fix for a bug that had been resolved months earlier. The Planner emitted a `failingAssertion`, the Worker satisfied it, the Evaluator graded "partial." No part of the chain checked whether the assertion was actually false on real code. The reproduce gate plugs that hole.

## Source-mode Worker

System prompt: `WORKER_SOURCE_SYSTEM`. Differences vs the traffic Worker:

- Reads the target file in the worktree and applies the minimal fix.
- **Reuses the Planner's baseline harness verbatim.** The harness already exists at `baselineEvidence.harnessPath` and already failed (non-zero exit) on unpatched code. The Worker's job is to make that exact same harness pass — not to write a new harness.
- Runs the harness via `run_shell`. The exit code must be 0 after the fix. If still failing, the Worker iterates on the source until it passes.
- Prompt explicitly forbids deleting unrelated code from the target file. `write_file` is full-content overwrite — preserve every pre-existing function, import, and declaration.

The terminal tool is still `emit_patch` — the same shape works for both modes. The Worker's `harnessPath` in the patch result MUST match the Planner's `baselineHarnessPath`; the Evaluator checks this.

## Source-mode Evaluator

The Evaluator system prompt now describes three harness shapes (wire, unit-test, source-grep/log-line/behavior-check) and how to grade each. The trustworthy bar is the same in spirit: the harness must FAIL on the unpatched code and PASS on the patched code, and the assertion must exercise the actual code change rather than a hardcoded constant.

The input prompt also includes a `Mode: source|traffic` field so the Evaluator knows which rubric applies before reading the patch.

`runEvaluator` accepts either plan shape via a polymorphic `AnyPlanResult` union — no separate evaluator runner.

### Destructive-rewrite check (`compare_file_declarations`)

The Worker uses full-content `write_file` to apply fixes, which means it has to reproduce every existing function, type, and import in the file from memory. Anything it forgets disappears — and the resulting code may not compile. This actually happened on the first real source-mode dispatch: a 4-line behavioral change shipped with two unrelated helper functions silently deleted.

The Evaluator now has a `compare_file_declarations(path)` tool that:

1. Resolves the git worktree containing the file
2. Detects the base branch (`origin/HEAD` → `master` → `main`)
3. Runs `git show <base>:<rel-path>` to read the pre-patch content
4. Diffs top-level declarations (Go funcs / TS classes / Python defs / Rust fns / …) using the regex-based extractor in `src/lib/declaration-diff.ts`
5. Returns JSON: `{ file, baseRef, added: [], removed: [], preserved_count }`

The Evaluator prompt makes this check **mandatory**: it must be called on every file the Worker modified. A non-empty `removed` list on a patch that didn't explicitly authorize deletions is a destructive rewrite — fail-verdict, even if the intentional change is correct.

The declaration extractor is intentionally permissive (covers Go, TS/JS, Python, Rust top-level patterns). False positives — extra names in the output — are harmless. False negatives — missed names — would leak destructive rewrites past the gate, so the patterns are biased toward matching.

11 unit tests in `src/lib/declaration-diff.test.ts` covering each language, CRLF handling, nested-function rejection, and the worked-example failure mode this gate is designed to catch.

## New tool: `run_shell`

`run_shell({ command, cwd? })` executes an arbitrary shell command with a 90s timeout. Used by the source-mode Worker to invoke `go test`, `npm test`, `pytest`, or custom shell probes. Output is truncated to 8000 chars to keep the prompt manageable.

`run_script` (Node-only, 30s timeout) is unchanged and still used by traffic harnesses.

## Configuration

No new env vars. The existing `ENGINE_PLANNER_MAX_LOOPS` / `ENGINE_WORKER_MAX_LOOPS` / `ENGINE_EVALUATOR_MAX_LOOPS` apply to both modes.

The source-mode Planner prompt sets a tighter stopping rule (loop 18 vs 20) because there's no snapshot to dig through indefinitely.

## Mixed mode (today: dominant-signal pick + warning)

When the classifier returns `mixed`, the runner picks the dominant signal for the current dispatch and prints a warning. The operator then re-runs the residual with `--mode` set explicitly. A future iteration may automatically queue two child runs.

## Worked example: telemetry tagging bug

Ticket: a downstream component reports zero log events for a run that the producer demonstrably executed. The wire shows the producer's API calls succeeding; the bug is invisible there.

Classifier signals:

- Source keywords matched: `log`, `logs not present`, `telemetry`, `report_events`, `clickhouse insert`
- No traffic keywords
- Snapshot may be available but the classifier ignores it without corroborating traffic keywords

Result: `source` with high confidence.

Source-mode Planner:

- `search_code` for the producer's tag-emission code; `read_file` on the indexer's event extractor.
- Spots that the indexer's insert branch is `if reportID != ""` — events tagged with an empty report ID are silently dropped.
- Failing assertion: "indexer.extractEvent inserts events whose TestReportID tag is empty into the report_events batch" (false today — the if-branch skips them).
- Assertion shape: `unit-test`.

Source-mode Worker:

- Writes the fix (probably: either fail loudly when the producer's tag is empty, or have the indexer log the dropped event count).
- Writes a `_test.go` asserting the new behavior.
- Runs `go test -run TestExtractEventEmptyReportID ./indexer/...` via `run_shell`.
- Emits `emit_patch` with the test output as `confirmResult`.

Evaluator:

- Re-reads the patched files.
- Reads the test file, confirms it exercises the empty-tag branch and asserts on the right behavior.
- Verdict: pass.

## What still needs work

- `mixed` mode doesn't yet split into two child runs; it picks one and warns. Future work.
- Source-mode Worker doesn't auto-format the patch as a unified diff like traffic-mode does. The patch field carries the new content; reviewers should pull the worktree to see the actual diff.
- No telemetry yet on per-mode success rates. Add to `quality-report.ts` once we have a few real runs.
