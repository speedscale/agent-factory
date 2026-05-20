# LLM Engine

Audience: Agent Factory developers.

The LLM engine is the intelligence layer. It runs a tool-use agentic loop using the Claude API, driving the Planner, Worker, and Evaluator phases. Implementation: `src/lib/llm-engine.ts`.

## Agent loop

Each phase (Planner, Worker, Evaluator) is a conversation with Claude using Anthropic's tool-use API. The loop runs until Claude calls a **terminal tool** (`emit_plan` for Planner, `emit_patch` for Worker, `emit_eval_report` for Evaluator), at which point the phase ends and the result is returned.

```
system prompt
    │
    ▼
user message (spec + context paths)
    │
    ▼
Claude response ──→ tool calls ──→ dispatch tools ──→ tool results
    │                                                       │
    └──────────────────────────────── next turn ←──────────┘
    │
    ▼ (terminal tool called)
structured output (AgentPlan or patch)
```

Maximum iterations: 30. Model: `claude-sonnet-4-6` (configurable via `ENGINE_MODEL` env var).

## Tool catalog

### Data access tools

| Tool | Input | Returns |
|---|---|---|
| `read_file` | `path: string` | File content (truncated at 500 lines) |
| `search_code` | `pattern: string, dir: string` | `grep -rn` output, JS/TS files, max 50 matches |
| `list_snapshot_dir` | `dir: string` | RRPair files grouped by host, first 3 filenames per host |
| `read_rrpair` | `path: string` | RRPair markdown content (truncated at 200 lines) |

### Action tools

| Tool | Input | Returns |
|---|---|---|
| `write_file` | `path: string, content: string` | Confirmation string |
| `run_script` | `path: string` | Combined stdout/stderr, 30s timeout |

### Terminal tools

| Tool | Phase | Key fields |
|---|---|---|
| `emit_plan` | Planner | `summary`, `hypothesis`, `metric`, `baseline`, `targetFile`, `targetFunction`, `rationale` |
| `emit_patch` | Worker | `targetFile`, `patch`, `rationale`, `confirmResult` |
| `emit_eval_report` | Evaluator | `addressedRequirements[]`, `missedRequirements[]`, `confirmHarnessTrustworthy`, `confirmHarnessNotes`, `overallVerdict`, `summary` |

Terminal tools end the loop immediately. The engine extracts their `input` as the structured result.

## Planner phase

**System prompt goal:** analyze snapshot evidence, identify the bug metric, write and run a reproduce harness, emit a structured plan.

**Rules enforced via prompt:**
- List the snapshot directory first, then read individual RRPairs
- Count error responses by host and endpoint; note burst timestamps
- For algorithmic bugs (concurrency, batching), write a self-contained Node.js harness
- Do not write any fix — only emit_plan

**Input to Claude:**
```
Issue: <title>
Description: <body>
Snapshot directory: <path>
Source directory: <path>
Work directory for harness files: <path>
```

**Output (`EmitPlanResult`):**
```typescript
{
  plan: AgentPlan;     // structured run plan
  metric: string;      // e.g. "peak concurrent calls > 10"
  baseline: string;    // e.g. "100 concurrent calls observed"
  rationale: string;   // evidence trail
}
```

## Worker phase

**System prompt goal:** read the source, write the minimal fix, run the confirm harness, emit the patch.

**Rules enforced via prompt:**
- Read the target file and the reproduce harness before writing anything
- Apply the fix directly via `write_file`
- Write a confirm harness with identical methodology to the reproduce harness
- Run the confirm harness via `run_script` and include the output in `emit_patch`
- If confirm fails, fix and re-run; do not emit_patch until it passes

**Input to Claude:**
```
Plan summary: <summary>
Hypothesis: <hypothesis>
Metric to fix: <metric>
Baseline measurement: <baseline>
Target file: <path>
Rationale from Planner: <rationale>
Source directory: <path>
Work directory: <path>
```

**Output (`EmitPatchResult`):**
```typescript
{
  filePath: string;        // patched file
  patch: string;           // the fix (diff or new function body)
  rationale: string;       // why this addresses the root cause
  harnessPath?: string;    // path to confirm harness
  confirmResult?: string;  // confirm harness stdout
}
```

## Evaluator phase

**System prompt goal:** independently verify the Worker's patch actually delivers the spec. The Worker grades its own homework; the Evaluator is a second pair of eyes.

**Tools:** read-only — `read_file`, `search_code`, `list_snapshot_dir`, `read_rrpair`, plus terminal `emit_eval_report`. No `write_file` or `run_script`.

**Rules enforced via prompt:**
- Enumerate every spec requirement (numbered, bulleted, or written as should/must/needs to).
- For each, verify the patched source reflects it — read the file, don't trust the Worker's patch-text description.
- Read the confirm harness (if any) and decide whether it actually exercises the planned metric. A harness that asserts on a hardcoded string or reads the source instead of running it is *not* trustworthy.
- Verdict: `pass` only if every requirement is addressed AND the harness is trustworthy; `partial` for missed requirements or weak harness; `fail` for missing/wrong core fix.

**Input to Claude:** original spec, Planner's plan, Worker's patch + confirm result, plus paths to source/snapshot/work dirs.

**Output (`EmitEvalReportResult`):**
```typescript
{
  addressedRequirements: string[];        // quoted from spec body
  missedRequirements: string[];           // quoted from spec body
  confirmHarnessTrustworthy: boolean;
  confirmHarnessNotes: string;
  overallVerdict: "pass" | "partial" | "fail";
  summary: string;
}
```

**Effect on the run:** the engine writes `eval-report.json` to the work directory and prints the verdict + missed-requirements list. A `fail` verdict exits the process with code 2 so CI / orchestration scripts can react. Skip with `--no-eval`.

Without an Evaluator, the only signal that a patch is complete is the Worker's self-reported `confirmResult`. In practice, that signal is unreliable: a Worker can write a harness that doesn't actually test the planned metric, or skip a spec item entirely while passing its own self-graded check. The Evaluator catches both failure modes.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required for Claude SDK) |
| `ANTHROPIC_API_KEY_DO_NOT_USE` | — | Fallback key name used in this workspace |
| `ENGINE_MODEL` | `claude-sonnet-4-6` | Model ID |
| `ENGINE_MAX_TOKENS` | `8192` | Max tokens per response |
| `ENGINE_MAX_LOOPS` | `30` | Max tool-use iterations per phase |
| `ENGINE_PLANNER_MAX_LOOPS` | `30` | Planner-specific loop cap |
| `ENGINE_WORKER_MAX_LOOPS` | `25` | Worker-specific loop cap |
| `ENGINE_EVALUATOR_MAX_LOOPS` | `20` | Evaluator-specific loop cap |

## Running the engine directly

```bash
npm run llm-run -- \
  --title  "Service X returning 429s" \
  --body   "Errors cluster in bursts..." \
  --snapshot /path/to/snapshot/inner-dir \
  --source   /path/to/service/src \
  --workdir  /tmp/run-work \
  --verbose
```

`--verbose` logs each tool call and its result to stderr. Useful for debugging loop behavior.

## Adding a new tool

1. Add an implementation function in `src/lib/llm-engine.ts` following the `toolReadFile` / `toolSearchCode` pattern.
2. Add an entry to the `TOOLS` array (Anthropic `Tool` schema).
3. Add a case to `dispatchTool`.
4. Update this doc.

Terminal tools (`emit_*`) follow the same pattern but are detected by name in the loop and cause early return rather than dispatch.

## Modes

The engine has two intake modes:

- **Traffic mode** (described in this doc): wire-grounded, metric-driven. The default for tickets with a captured snapshot and observable failure on the wire.
- **Source mode** (see [`engine-source-mode.md`](./engine-source-mode.md)): code-grounded, assertion-driven. For bugs with no wire signal — telemetry/logging gaps, CLI ergonomics, init ordering, structural fixes outside the snapshot's reach.

The CLI's `--mode auto|traffic|source` flag (default `auto`) picks the right path. In `auto`, a classifier reads the title/body/labels/snapshot to decide. Operators can override.

## Spec shape: what the engine handles, what it drops

The engine is built around a metric-driven Planner → Worker loop. A spec succeeds when the agent can derive a measurable metric from snapshot evidence, write a reproduce harness measuring the baseline, apply a fix, and write a confirm harness measuring the new value.

**Works well:**

- Bugs visible in captured traffic: wrong status codes, malformed request/response bodies, latency, concurrency bursts, missing fields.
- Anything where the difference between buggy and fixed is observable on the wire.

**Drops or fails in traffic mode:**

- Requirements with no wire signal — new CLI flags, dry-run modes, ergonomics, output formatting, log messages.
- Multi-requirement specs where some items are wire-shaped and others aren't. Example seen in practice: a spec asked for (1) gate request body fields with a CLI-flag check — wire-shaped — and (2) add a `--dry-run` mode — no wire signal. Run 1 delivered item 1 cleanly with a passing confirm harness, then ignored item 2 despite both being explicit in the body.

**Route non-wire requirements to source mode.** See [`engine-source-mode.md`](./engine-source-mode.md). The classifier picks automatically when `--mode auto` is set (the default); operators can override with `--mode source`. For mixed specs, the classifier returns `mixed` and the runner picks the dominant signal — re-run the residual with the other mode explicitly. This replaces the older "split into two narrower dispatches" workaround.

## SOS spike results (2026-05-17)

Validated against the radar Gmail sync bug (S-10885). The LLM:

- Read 183 Gmail RRPairs from the snapshot
- Identified the `Promise.all` concurrency burst in `gmail.js:276`
- Wrote a reproduce harness measuring peak=100 concurrent calls (baseline confirmed)
- Applied a `mapWithConcurrency` fix capping calls at 10
- Wrote a confirm harness measuring peak=10 (fix confirmed)

Times: Planner 84s, Worker 88s, total ~3 minutes issue → confirmed fix.
