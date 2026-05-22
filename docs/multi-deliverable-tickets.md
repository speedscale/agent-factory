# Multi-deliverable tickets

Audience: Agent Factory operators.

The engine ships **one deliverable per dispatch**. The Planner emits a single `failingAssertion` plus a single reproduce harness; the Worker writes the patch that makes that one harness pass. This model works cleanly for "fix this bug" specs and breaks for "implement A, B, and C" specs where the acceptance criteria are a checklist of parallel asks.

When a multi-deliverable spec is dispatched as-is, the typical failure mode is that the Worker delivers the first sub-deliverable and the Evaluator grades the run `partial` (or, when implementation patterns are uniform across the asks, the Worker happens to deliver all of them — but you can't rely on that).

## What the engine does today

A pattern-based checklist detector runs before the Planner and refuses dispatch with `needs-split` when the spec looks like N parallel asks. It fires on two signals:

1. **Title comma+and list with ≥3 items after a build verb.**
   Example: `Add proxymock export subcommands for Postman, k6, and Gatling`
2. **Body contains ≥3 markdown bullets sharing the same build verb.**
   Example: `* Add postman exporter` / `* Add k6 exporter` / `* Add gatling exporter`

Single-deliverable bug specs (`MCP resource cursor incompatible with mcp-go base64 pagination`) and single-feature specs (`Add a --dry-run flag to tenant set`) have neither signal and pass the gate cleanly.

The detector is deterministic — no LLM call — so it's the cheapest pre-Planner check and runs before triage.

## What to do when the gate fires

1. Split the Linear ticket into one child ticket per sub-deliverable. Keep the parent open as the umbrella; each child gets its own `factory` or `auto-fix` label and its own concrete acceptance criteria.
2. Re-dispatch each child independently. You'll typically end up with one PR/MR per sub-deliverable, which makes review and bisecting easier and lets the Evaluator give clean verdicts on each.
3. If the deliverables share scaffolding that's genuinely cheap to deliver together (e.g. you've already prototyped the first one and the other two are 5-line copies of the same pattern), pass `--no-checklist-check` to bypass the gate. The bypass is logged in the run record so the choice stays visible.

## Why we didn't widen the Planner instead

Two alternatives were considered:

- **Widen `EmitPlanSourceResult` so the Planner emits a list of `(failingAssertion, harness)` pairs.** Heavier, requires Worker + Evaluator changes, and makes the "one fix per dispatch" mental model fuzzy. Defer until we see enough multi-deliverable specs that operator-side splitting becomes the bottleneck.
- **Auto-fan-out into N child dispatches inside one run.** Loses the operator's chance to triage which deliverables are actually worth dispatching, and conflates the run logs.

Operator-side split keeps each dispatch focused, keeps the Planner simple, and matches how reviewers want to see the work land (small PRs, one logical change each).

## Related gates

- [`triage.ts`](../src/lib/triage.ts) — refuses dispatch when the spec lacks enough context to attempt a fix (`needs-info`).
- [`repro-context-detector.ts`](../src/lib/repro-context-detector.ts) — refuses source-mode dispatch when the spec names input artifacts the engine doesn't have.
- [`checklist-detector.ts`](../src/lib/checklist-detector.ts) — refuses dispatch when the spec lists multiple parallel deliverables (this gate).

All three share the same exit shape (non-zero exit + reviewer-ready report) and the same bypass-flag convention (`--no-triage` / `--no-context-check` / `--no-checklist-check`).
