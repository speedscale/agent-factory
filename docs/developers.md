# Developer Guide

Audience: contributors who build or change Agent Factory.

## Design boundaries

Keep four planes explicit — see `docs/architecture.md` for full detail:

- **Engine plane** — LLM orchestration (`src/lib/llm-engine.ts`)
- **Tool plane** — deterministic tools the LLM calls (engine-native + proxymock MCP)
- **Control plane** — intake API, run queue, run store, artifact tree
- **Context plane** — RRPairs, metrics, logs, source code (customer-owned)

The engine proposes. Tools execute. Humans approve.

## Source of truth documents

- architecture: `docs/architecture.md`
- LLM engine detail: `docs/engine.md`
- roadmap: `docs/plan.md`
- autonomy contract and pass/fail rubric: `docs/autonomy-mvp.md`
- history: `docs/history.md`
- release process: `docs/release.md`

## Core contracts — do not break without a major version bump

- `AgentApp` — service manifest (repo, build, validate, engine config, quality policy)
- `AgentRun` — lifecycle state and artifact pointers
- `AgentPlan` — Planner output (metric, baseline, hypothesis, steps)
- `QualityReport` — Validate phase output (before/after metric, regression diff)
- Artifact filenames in `artifacts/<run-name>/`

## Development setup

After cloning, activate the pre-commit hook that checks for sensitive data (internal ticket IDs, secrets, person names):

```bash
git config core.hooksPath .githooks
```

The hook runs automatically on every commit. If it fires on a false positive, remove the flagged content or add a `nocheck` comment on that line.

## Development workflow

```bash
npm install
npm run check          # type-check
npm run demo           # validation loop demo (no LLM key needed)
npm run loop-demo      # baseline → regression → recovery sequence
```

LLM engine (requires `ANTHROPIC_API_KEY`):

```bash
export ANTHROPIC_API_KEY=<key>

npm run llm-run -- \
  --title  "Service X returning 429s" \
  --snapshot /path/to/snapshot/inner-dir \
  --source  /path/to/service/src \
  --workdir /tmp/work \
  --verbose
```

Individual stage debugging:

```bash
npm run planner   -- --run <run-name>
npm run runner    -- --run <run-name> --source .work/demo-fixture
npm run validator -- --run <run-name>
```

Service-mode checks:

```bash
npm run intake-api
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture --once
```

## Key source files

| File | Purpose |
|---|---|
| `src/lib/llm-engine.ts` | LLM agent loop, tool implementations, Planner/Worker phases |
| `src/lib/planner.ts` | Deterministic planner stub (used when no LLM key is set) |
| `src/lib/runner.ts` | Build stage execution |
| `src/lib/validator.ts` | proxymock replay stage |
| `src/lib/quality-report.ts` | QualityReport generation and comparison |
| `src/lib/run-queue.ts` | Filesystem / Redis run queue |
| `src/contracts/` | TypeScript types for all contracts |
| `src/bin/llm-run.ts` | CLI entry for LLM fix loop |
| `src/bin/worker.ts` | Long-running worker daemon |
| `src/bin/intake-api.ts` | HTTP intake API |

## Extending the LLM engine

To add a new tool:

1. Implement a `toolXxx(input)` function in `src/lib/llm-engine.ts`
2. Add it to the `TOOLS` array (Anthropic `Tool` schema with `input_schema`)
3. Add a case to `dispatchTool`
4. Document it in `docs/engine.md`

To add a new terminal tool (ends the agent loop):

- Follow the `emit_plan` / `emit_patch` pattern
- The loop returns `terminal.input` as the structured result
- Add result type to the `EmitXxxResult` interface

## Contribution expectations

- Keep plane boundaries clear; don't reach across them
- Preserve artifact-first evidence — no run succeeds without proxymock exit `0` and confirm harness exit `0`
- No private Speedscale dependencies in source
- Update `docs/` when behavior changes
- Do not bump `package.json` manually; CI bumps version on merge to `main`

## Agent instruction resolution across repos

When Agent Factory drives changes in a target repo, read and apply both:
- `agent-factory/AGENTS.md`
- `<target-repo>/AGENTS.md`

Stricter constraint wins. If constraints conflict and cannot both be satisfied, stop and request operator direction. State which instruction files were applied in the PR summary.
