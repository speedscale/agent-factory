# Repository Guidelines

## Purpose

Agent Factory is an LLM-driven software-delivery loop:

**Spec → Generate → Validate → Deploy → Observe**

The LLM is grounded in real captured traffic (RRPairs via proxymock). Every fix is validated against production evidence before a human approves it. The system ships as a Helm chart alongside `speedscale-operator` for BYOC customers, and runs as an internal service for Speedscale Cloud (SOS).

## Design boundaries

Four planes must stay explicit:

- **Engine plane** — LLM orchestration (Planner, Worker). Lives in `src/lib/llm-engine.ts`. The engine proposes; it does not decide.
- **Tool plane** — proxymock MCP + engine-native tools (read, search, write, run). The LLM calls tools; tools execute deterministically and return results.
- **Control plane** — intake API, run queue, run store, artifact tree. App-agnostic; reads `AgentApp` manifests, not repo-specific logic.
- **Context plane** — RRPairs, metrics, logs, source code. Customer-owned. Enters LLM prompts only via the tool plane, never directly.

## Core rules

- **Reproduce before generating.** The Planner must name the measurement metric and confirm it is measurable from the snapshot before the Worker writes any code. No metric = no fix.
- **Identical harness methodology.** The reproduce and confirm harnesses must use the same mock, same measurement, same threshold. Changing methodology between phases invalidates the comparison.
- **Cluster filter on snapshots.** Always pass `--filter '(cluster IS "prod")'` (or the correct cluster) when pulling snapshots. Wrong cluster = empty or wrong signal.
- **Proxymock evidence is a hard gate.** Do not mark a run succeeded without proxymock regression replay exit `0`.
- **Minimal fixes only.** Workers write the minimal change that addresses the root cause. No cleanup, no refactoring beyond the fix.
- **No private Speedscale dependencies.** Keep the repo portable. Internal integrations belong in configuration, not source.
- **Worktree per run.** Every agent run creates a `git worktree` at `<workdir>/repo` on a new branch `agent/<ticket-slug>` (e.g. `agent/s-10886-radar-perf`) branched from `main`. The Worker writes all fixes into the worktree directory, never into the operator's live checkout. The worktree is created at Worker phase start, before any file is modified.
- **Branch cleanup.** Agent branches are deleted and their worktrees removed after the PR merges. Stale unmerged agent branches older than 7 days must be flagged in the run store for operator review and deleted if no open PR exists. The naming prefix `agent/` is reserved; no human work should land on these branches.
- **Engine config is resolved, never defaulted to Anthropic.** Agents and engine entry points pick the LLM via `resolveEngineConfig(env)` from `src/lib/engine-config.ts`. No `?? "anthropic"` fallbacks in `src/`. A misconfigured BYOC deployment must surface as a startup error, not quietly hit the public API. `npm run check:no-anthropic-default` enforces this on CI.

## Deployment models — what changes between them

The code is identical. Configuration differs:

| | Cloud (SOS) | BYOC |
|---|---|---|
| `AgentApp.spec.engine.endpoint` | Anthropic direct | Customer-configured |
| `AgentApp.spec.repo.url` | Speedscale's GitLab | Customer's git mirror |
| Helm release operator | Speedscale | Customer |

## Repository conventions

- `src/lib/llm-engine.ts` — LLM agent loop, tool implementations, Planner/Worker phases
- `src/lib/planner.ts` — deterministic planner stub (fallback when no LLM key configured)
- `src/agents/` — per-agent modules (triage, bug-fix, perf-investigation, coverage-fill, pr-replay-check, mock-generation, migration-safety)
- `src/contracts/` — typed contracts: AgentRun, AgentApp, AgentPlan, QualityReport, TrafficSource/Slice/Fingerprint/Evidence
- `crds/` — CustomResourceDefinitions (AgentRun, AgentApp, TrafficSource)
- `charts/agent-factory/` — Helm chart (supported deployment path)
- `examples/instances/` — sample Helm values (internal / customer / demo / local)
- `docs/` — reference docs; update when behavior changes

## Multi-repo instruction resolution

When Agent Factory drives changes in a target repo:

1. Read this repo's `AGENTS.md` and the target repo's `AGENTS.md` before planning.
2. Stricter constraint wins when both can be satisfied.
3. If constraints conflict and cannot both be satisfied, stop and request operator direction.
4. In PR summaries, state which instruction files were applied.

## Versioning

- Version bumps are CI-managed on merge to `main`.
- Do not manually bump `package.json` in feature PRs.
- Semantic intent: patch = docs/fixes, minor = new capability or contract extension, major = breaking contract change.

## Out of scope

- Multi-cluster deployment automation (post-MVP)
- Private internal integrations in source (use config)
- LLM fine-tuning or model training
- Replacing proxymock as the validation evidence layer
