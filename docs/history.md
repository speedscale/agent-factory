# Implementation History

Audience: Agent Factory developers/contributors.

This file keeps a compact record of completed work so `docs/plan.md` can stay focused on forward execution.

## Completed Milestones

- **Foundation**: contracts, local control plane, intake, planner, runner, validator, and golden path demo.
- **Operations baseline**: run admin commands, worker claiming, durable `result.json`, run status API, queue/run metrics, and operations runbook.
- **Runtime modes**: local CLI flow, server mode, docker compose packaging, and Kubernetes base deployment.
- **Scaling path**: Redis queue backend and Kubernetes Redis overlay for multi-worker processing.
- **Access control baseline**: optional token auth for intake run/metrics APIs plus Kubernetes auth overlay.

## Current Capability Snapshot

- Intake API: create runs, query runs, query metrics.
- Worker: consume queue (filesystem or Redis), execute plan/build/validate, emit artifacts.
- Artifact contract: `app.json`, `issue.json`, `run.json`, `evidence.json`, `triage.json`, `plan.yaml`, `patch.diff`, `build.log`, `validation.log`, `result.json`.
- Deployability: local, compose, and Kubernetes profiles.
