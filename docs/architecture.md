# Reference Architecture

Audience: Agent Factory developers/contributors.

## Overview

Agent Factory is designed around one quality-first inner loop:

`request -> select scope -> run checks -> compare baseline -> report`

The control plane must stay app-agnostic by reading a declarative `AgentApp` manifest instead of embedding repository-specific logic.

## System Planes

### App Plane

The app plane owns:

- application source
- tests and build configuration
- runtime manifests
- app onboarding manifest (`AgentApp`)

The app plane should not contain orchestration logic for the agent itself.

### Agent Plane

The agent plane owns:

- validation request intake (PR/manual/agent)
- run queueing and state transitions
- scope selection and baseline targeting
- isolated workspace execution
- artifact persistence and status reporting

The agent does not fix code; it evaluates quality and reports regressions.

### Validation Plane

The validation plane owns:

- replay datasets
- mock/replay command configuration
- replay execution (`proxymock`)
- pass/fail evidence

In practice, Speedscale capture and proxymock replay provide the request/response evidence chain from incident discovery through fix validation.

Validation is the proof layer that determines whether the candidate fix behaved as expected.

## Runtime Modes

### Local Mode

Use local mode for rapid iteration and deterministic demos:

- run `npm run demo` for a complete golden path
- optional stage-by-stage commands: `intake-api`, `planner`, `runner`, `validator`
- artifacts are written to `artifacts/<run-name>/`

### Server Mode

Use server mode for continuous, API-driven automation:

- `intake-api` accepts quality run requests (`POST /qa/runs`)
- `intake-api` exposes run status queries (`GET /runs`, `GET /runs/{name}`)
- `intake-api` exposes queue/run metrics (`GET /metrics`)
- `intake-api` supports optional token auth for run and metrics endpoints (`INTAKE_API_TOKEN`)
- `worker` polls queued runs and executes plan/build/validate
- external webhook/slack adapters can translate events into canonical intake requests
- `worker` can expose optional local metrics endpoint when `WORKER_METRICS_PORT` is set
- both services are stateless; run state is stored in artifact files
- queue backend is selected via `RUN_QUEUE_BACKEND` (`filesystem` or `redis`)

This is the minimal server architecture required to migrate from CLI-only operation to a daemonized agent model.

### Cluster Bot Mode

Use cluster bot mode for ticket-driven automation across repositories:

- GitHub webhooks and Slack commands feed a canonical intake event
- intake queues runs and workers execute as short-lived Kubernetes Jobs
- automation credentials are bot-scoped (not operator personal identity)
- completed Jobs are garbage-collected with TTL/history limits

See `docs/cluster-bot-runtime.md` for deployment profile and identity contract.

## Control Flow

1. Intake receives a validation request and app manifest, then writes `run.json` in `queued` phase.
2. Worker resolves the baseline target(s) for the repository/workdir scope.
3. Worker prepares isolated workspace and runs configured quality checks.
4. Worker executes configured validation commands (for example proxymock replay).
5. Worker compares current outputs to baseline artifacts.
6. Worker writes structured quality report artifacts and updates run phase.
7. Artifacts remain available for audit and reproducibility.

## Component Contracts

### `AgentApp`

Each app manifest declares:

- repository location and default branch
- one or more project working directories for quality scope
- install/test/start commands
- validation commands and baseline target contract
- reporting policy (fail on regression, output formats)

### `AgentRun`

Each run captures:

- request source and trigger context (PR/manual/agent)
- workspace root and branch intent
- baseline target(s)
- lifecycle phase (`queued`, `planned`, `building`, `validating`, `succeeded`, `failed`)
- artifact pointers

### Artifact Set

Each run should emit:

- `request.json`
- `app.json`
- `run.json`
- `evidence.json`
- `baseline.json`
- `build.log`
- `validation.log`
- `quality-report.json`
- `quality-report.md`
- `result.json`

## Reliability and Safety Guardrails

- **Deterministic workers**: execute one run at a time per worker process.
- **Isolated workspace**: run commands under `.work/<run-name>`.
- **Run claiming**: workers create a per-run claim file before processing to avoid double execution.
- **Idempotent intake**: run identity is derived from app name + request scope + source id.
- **Evidence-first completion**: do not mark success without validation command exit `0`.
- **App-agnostic control plane**: onboarding data lives in app manifest, not worker code.

## Deployment Topology (Server)

For early server deployments:

- 1 intake API instance
- 1+ worker instances (single-run concurrency per process)
- shared persistent volume or object-backed artifact store

In Kubernetes terms, this maps to one `Deployment` for API and one `Deployment` for workers, both mounting the same run store (or using a future external state backend).

## What This Architecture Guarantees

- You can run and test the factory locally end-to-end.
- You can run and test the same flow as long-lived services.
- Every phase emits inspectable artifacts that prove what happened.

## Known Early Limitations

- Current run store is file-based (single shared filesystem assumption).
- Current planner/runner are deterministic stubs for reference behavior.
- Queue semantics are polling-based, not event-stream based.

These are acceptable for reference architecture and local/server validation of the inner loop.
