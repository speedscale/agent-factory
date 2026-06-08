# Implementation History

Audience: Agent Factory developers/contributors.

Compact record of completed work so `docs/plan.md` stays focused on forward execution.

## Refactor timeline

### Era 1: CRD controller (early 2026)

Original architecture used Kubernetes CRDs (`AgentApp`, `AgentRun`, `TrafficSource`) with a controller that watched for CRD events and dispatched agents. Traffic came from batch snapshot pulls via `proxymock cloud pull` or `loki-gather` / `es-gather` scripts.

- AgentRun CRD defined the lifecycle of a fix attempt
- Controller watched k8s events, created worker Jobs
- Traffic materializer pulled snapshots at run start

**Status**: dead code. `src/lib/controller/`, `src/lib/k8s-runs.ts`, `src/lib/k8s-worker-job.ts` still exist but are not used. Pending removal.

### Era 2: Redis queue + worker (mid 2026)

Replaced CRD controller with a simpler Redis queue (or filesystem fallback). intake-api enqueues runs, worker polls and claims them. Eliminated the k8s Job dispatch complexity.

- intake-api: HTTP server, run queue, metrics
- worker: long-running poller, claims runs, executes agents
- Artifact tree per run: plan.json, reproduce.mjs, confirm.mjs, patch.json, quality-report
- LLM engine with Planner/Worker phases
- Multiple agent kinds: triage, bug-fix, perf-investigation, coverage-fill, pr-replay-check

### Era 3: OTLP streaming (2026-06-08)

Replaced batch snapshot creation with a streaming OTLP gRPC receiver. The forwarder's `EXPORTERS` fan-out sends RRPairs directly to intake-api as OTLP log records. No Speedscale cloud dependency.

**PRs**:
- #105 — Add traffic-monitor agent kind + worker handler
- #106 — Add OTLP streaming receiver to intake-api
- #107 — Fix: copy OTLP proto files into Docker image
- #108 — Fix OTLP converter for proto-loader keepCase:true
- #109 — Wire OTLP archive secret for stream findings persistence

**Components added**:
- `src/lib/otlp-receiver.ts` — gRPC server implementing LogsService/Export
- `src/lib/otlp-converter.ts` — reverses forwarder's OTLP MapValue encoding
- `src/lib/otlp-buffer.ts` — per-service tumbling window buffer
- `src/lib/otlp-window-processor.ts` — window close handler (analyze + archive)
- `src/protos/` — vendored opentelemetry-proto v1.3.2
- Helm chart: conditional OTLP port, env vars, archive secret mount

**Deployment**: live on `do-nyc1-staging-decoy`, 6 services streaming, findings archiving to DO Spaces.

## Completed milestones (cumulative)

- Foundation: contracts, local control plane, intake, planner, runner, validator
- Operations baseline: run admin commands, worker claiming, metrics, runbook
- Runtime modes: local CLI, Kubernetes Helm chart
- Redis queue backend for multi-worker processing
- LLM engine hardening: tool-call rescue, escalating nudges, prereqs, compaction
- Multi-provider engine: claude-sdk, openrouter, ds4, omlx, generic-llm, private-llm
- OTLP streaming receiver with per-service windowed analysis
- Findings archival to S3-compatible storage
- Prometheus metrics for both worker and streaming pipeline
