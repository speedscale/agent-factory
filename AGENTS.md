# Repository Guidelines

## Purpose

Agent Factory is a streaming traffic analysis engine:

**Detect → Confirm → Replicate**

The Speedscale forwarder streams all RRPairs (request/response pairs) via OTLP gRPC into Agent Factory, which buffers them per-service in tumbling time windows, runs signal detection on each closed window, and archives findings. The killer feature — detecting a real bug, confirming it via replay, and filing a ticket with evidence — is now wired end-to-end: detection + archival, a signal→AgentRun bridge for high-severity regressions, and a `reproduce` worker that replays the evidence and files a ticket. Exercising it in production needs live config (`REPRODUCE_REPLAY_TARGET`, `LINEAR_API_KEY`, `LINEAR_REPRODUCE_TEAM_ID`).

The system ships as a Helm chart alongside `speedscale-operator`.

## Design boundaries

Four planes must stay explicit:

- **Engine plane** — LLM orchestration (Planner, Worker). Lives in `src/lib/llm-engine.ts`. The engine proposes; it does not decide.
- **Tool plane** — proxymock MCP + engine-native tools (read, search, write, run). The LLM calls tools; tools execute deterministically and return results.
- **Control plane** — intake API, OTLP receiver, run queue, run store, streaming buffer. App-agnostic.
- **Context plane** — RRPairs, metrics, logs, source code. Customer-owned. Enters LLM prompts only via the tool plane, never directly.

## Core rules

- **Reproduce before generating.** The Planner must name the measurement metric and confirm it is measurable from the snapshot before the Worker writes any code. No metric = no fix.
- **Identical harness methodology.** The reproduce and confirm harnesses must use the same mock, same measurement, same threshold. Changing methodology between phases invalidates the comparison.
- **Proxymock evidence is a hard gate.** Do not mark a run succeeded without proxymock regression replay exit `0`.
- **Minimal fixes only.** Workers write the minimal change that addresses the root cause. No cleanup, no refactoring beyond the fix.
- **No private Speedscale dependencies.** Keep the repo portable. Internal integrations belong in configuration, not source.
- **Worktree per run.** Every agent run creates a `git worktree` on a new branch `agent/<ticket-slug>`. The Worker writes all fixes into the worktree, never into the operator's live checkout.
- **Engine config is resolved, never defaulted to Anthropic.** Agents pick the LLM via `resolveEngineConfig(env)` from `src/lib/engine-config.ts`. No `?? "anthropic"` fallbacks in `src/`. `npm run check:no-anthropic-default` enforces this on CI.

## Streaming pipeline

```
Forwarder EXPORTERS → OTLP/gRPC :4317 → intake-api → OtlpBuffer → [window close]
  → analyzeSnapshot() → correlateSignals() → archiveSignalEvidence() → bridgeSignalsToRuns()
  → interpretAndFile() → archiveFile()
                                  ↓ (reproduce AgentRun, async via worker)
  fetchArchive() → proxymock replay → analyzeSnapshot() → confirm → Linear createIssue()
```

See `docs/architecture.md` for full design.

## Repository conventions

- `src/lib/otlp-receiver.ts` — gRPC server implementing LogsService/Export
- `src/lib/otlp-converter.ts` — reverses forwarder's OTLP MapValue encoding
- `src/lib/otlp-buffer.ts` — per-service tumbling window buffer
- `src/lib/otlp-window-processor.ts` — window close handler (analyze + archive)
- `src/lib/rrpair-stats.ts` — signal detection (errors, slow endpoints, N+1, slow queries)
- `src/lib/baseline-store.ts` — per-endpoint rolling baseline stats
- `src/lib/signal-correlator.ts` — merge related signals into incidents
- `src/lib/snapshot-archive.ts` — S3/Spaces upload (`archiveFile`) + download (`fetchArchive`)
- `src/lib/evidence-archive.ts` — tar+upload the failing RRPairs per signal, keyed by fingerprint
- `src/lib/reproduce-bridge.ts` — enqueue `reproduce` AgentRuns for confirmed regressions
- `src/lib/reproduce-worker.ts` — fetch evidence, replay, confirm, file ticket (the confirm/replicate step)
- `src/lib/llm-engine.ts` — LLM agent loop, tool implementations, Planner/Worker phases
- `src/agents/` — per-agent modules (triage, bug-fix, perf-investigation, coverage-fill, pr-replay-check)
- `src/contracts/` — typed contracts: AgentRun, AgentApp, AgentPlan, QualityReport
- `charts/agent-factory/` — Helm chart (supported deployment path)
- `docs/` — reference docs; update when behavior changes

### Dead code (pending removal)

These files are from the CRD-era controller architecture and are not used:

- `src/lib/controller/` — CRD watcher + dispatcher
- `src/lib/k8s-runs.ts` — k8s CRD run management
- `src/lib/k8s-worker-job.ts` — k8s Job dispatch
- `src/bin/archive-snapshot.ts` — standalone snapshot archiver
- `src/bin/traffic-scan.ts` — standalone traffic scanner
- `src/lib/traffic/` — shadowed traffic module
- `crds/` — CustomResourceDefinitions (AgentRun, AgentApp, TrafficSource)

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
