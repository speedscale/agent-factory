# Engine — tool-call hardening

Five reliability techniques layered on top of `agentLoop` to make multi-step
tool-using runs survive weaker models, longer histories, and tool calls that
arrive in unexpected shapes. Inspired by
[antoinezambelli/forge](https://github.com/antoinezambelli/forge); pure helpers
live in `src/lib/engine-hardening.ts`.

The Planner / Worker / Evaluator phase design and evidence-grounded prompts
remain the engine's differentiators. This page is purely about the loop
plumbing underneath them.

## 1. Rescue parsing

**Symptom:** model emits a tool call as fenced markdown JSON inside text
instead of a structured `tool_use` block. Loop sees `stopReason=end_turn`
with empty `toolUses` and burns an iteration on a re-prompt.

**Fix:** `rescueToolCall(text, toolDefs)` scans for fenced JSON blocks whose
`tool`/`name` matches a known tool and reconstructs `ToolUse` objects with
synthetic IDs (`rescued-<n>`). Accepts the Anthropic shape
(`{"tool", "input"}`) and the OpenAI shape (`{"name", "arguments"}`).

**When it fires:** every turn where the model returned text but no tool calls.
Cheap — string scan over the assistant's text blocks.

## 2. Escalating nudges

**Symptom:** the original engine fired a single hard nudge at 60% of loop
budget with `tool_choice` force. Worked for capable models but wasted budget
on weaker ones that would have self-terminated with a softer prompt.

**Fix:** three tiers, each fires once at its threshold (50% / 70% / 85% of
`maxLoops` by default; see `DEFAULT_NUDGE_THRESHOLDS`):

| Tier | Threshold | Message style                       | `tool_choice` force |
|------|-----------|-------------------------------------|---------------------|
| 1    | 50%       | Gentle: "consider emitting now"     | no                  |
| 2    | 70%       | Sharp + list of tools called so far | no                  |
| 3    | 85%       | Curt: "MUST call X now"             | yes                 |

All nudge messages are prefixed `[SYSTEM]` — load-bearing, used by
compaction to identify them.

## 3. Per-tool prerequisites

**Symptom:** weaker models call `write_file` on a path they haven't
`read_file`'d first, producing destructive rewrites (see also the Evaluator's
`compare_file_declarations` check in `engine.md`).

**Fix:** `ToolDef.requires?: string[]` lists tool names that must have been
successfully dispatched at least once before the tool itself can dispatch.
`checkPrerequisites` returns a `PREREQUISITE_NOT_MET: ...` soft-error
string that the engine hands back as the `tool_result`. The model can
satisfy the prereq and retry — the error does **not** count toward the
consecutive-error budget.

Prereqs are opt-in. Most tools have no requires field; behavior for those
is unchanged.

## 4. Tiered deterministic compaction

**Symptom:** long runs (especially in source mode with `run_shell` output)
push message history past the provider's context window.

**Fix:** `compactMessages(messages, phase)` shrinks the history without an
LLM call. Three phases escalate as character count crosses fractions of
`ENGINE_CONTEXT_BUDGET_CHARS` (default 800k chars ≈ 200k tokens):

| Phase | Trigger    | What it drops                                             |
|-------|------------|-----------------------------------------------------------|
| 1     | 70% budget | `[SYSTEM]` nudge messages; truncate older tool_results to 200 chars |
| 2     | 85% budget | Drop older tool_results entirely (assistant tool_use blocks stay) |
| 3     | 95% budget | Strip reasoning text from older assistant turns           |

Invariants preserved at every phase:

- `messages[0]` (the original task) is never modified.
- The last `recentTurns` user/assistant pairs (default 3) are untouched.
- Assistant `tool_use` blocks always survive so the provider can still match
  follow-up `tool_results` to them.

Set `ENGINE_CONTEXT_BUDGET_CHARS=0` to disable compaction.

## 5. Control state outside message history

**Invariant:** loop counter, nudge tier, called-tools set, consecutive-error
count, and the force-next-turn flag all live as runner-local variables in
`agentLoop`. None depend on inspecting prior assistant turns. This is what
makes compaction safe — dropping reasoning blocks or truncating tool results
cannot lose any control state.

`terminal-tool-seen` is similarly safe: when the terminal tool is called,
`agentLoop` returns immediately, so there's no flag to preserve across
compaction.

## 6. Tool-call error classification

`ToolResolutionError` vs `ToolExecutionError`:

- **Resolution** — the call cannot be bound to a tool implementation:
  unknown tool name, missing required argument, wrong argument type. The
  model can self-correct cheaply. Returned as `softError`; **does not**
  count toward `MAX_CONSECUTIVE_ERRORS`.
- **Execution** — the tool ran but its underlying operation failed:
  file not found, command exited non-zero, network error. Returned as
  `executionError`; **does** count.

A successful tool dispatch resets the consecutive-error counter. When the
counter hits `MAX_CONSECUTIVE_ERRORS` (default 5, env-overridable via
`ENGINE_MAX_CONSECUTIVE_ERRORS`), the loop aborts — the model is stuck and
more iterations won't help.

Prereq soft-errors and resolution errors are both classified as `softError`
and treated identically.

## Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `ENGINE_MAX_LOOPS` | 50 | Loop budget |
| `ENGINE_MAX_CONSECUTIVE_ERRORS` | 5 | Abort after N consecutive execution errors |
| `ENGINE_CONTEXT_BUDGET_CHARS` | 800000 | Compaction budget (0 disables) |

All hardening is on by default and backwards-compatible. Existing
traffic-mode and source-mode runs see no behavior change unless they
actually hit one of the trigger conditions (rescue, late nudge, prereq
fail, context pressure, or execution-error streak).

## Out of scope

- `SlotWorker` (forge's GPU-slot queue) — irrelevant on cloud providers
- Replacing the Planner / Worker / Evaluator loop — those remain the engine's
  primary differentiators
- Eval harness changes — forge tests tool-call correctness; the Evaluator
  phase tests fix quality (different problem, addressed separately)
