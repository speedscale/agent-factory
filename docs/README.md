# Documentation Index

## Primary entry points

- `docs/users.md` — start here if you run or operate Agent Factory
- `docs/developers.md` — start here if you build or change Agent Factory

## Architecture and design

- `docs/architecture.md` — full system design: loop phases, planes, deployment models, contracts
- `docs/engine.md` — LLM engine: tool catalog, agent loop, Planner/Worker phases, configuration
- `docs/engine-hardening.md` — tool-call hardening: rescue, escalating nudges, prereqs, compaction, error classification
- `docs/plan.md` — active roadmap and next steps

## Deployment

- `docs/users.md` — runtime modes (local, server, Docker Compose, Kubernetes)
- `docs/server.md` — local/server runbook detail
- `docs/kubernetes.md` — Kubernetes deployment
- `docs/cluster-bot-runtime.md` — webhook/Slack bot runtime on Kubernetes
- `docs/operations.md` — metrics thresholds and remediation runbook

## Autonomy and quality contracts

- `docs/autonomy-mvp.md` — real-ticket intake contract and pass/fail rubric
- `schemas/` — machine-readable YAML schemas for all contracts

## History and release

- `docs/history.md` — implementation history
- `docs/phase-b-first-run.md` — first live run record
- `docs/release.md` — release checklist

## Quick rule

- Operating the system → `docs/users.md`
- Changing the system → `docs/developers.md`
- Understanding the LLM engine → `docs/engine.md`
- Understanding the architecture → `docs/architecture.md`
