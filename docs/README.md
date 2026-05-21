# Documentation Index

## Primary entry points

- `docs/users.md` — start here if you run or operate Agent Factory
- `docs/developers.md` — start here if you build or change Agent Factory

## Architecture and design

- `docs/architecture.md` — full system design: loop phases, planes, deployment models, contracts
- `docs/engine.md` — LLM engine: tool catalog, agent loop, Planner/Worker phases, configuration
- `docs/engine-source-mode.md` — engine source mode for non-wire-shaped specs
- `docs/engine-hardening.md` — tool-call hardening: rescue, escalating nudges, prereqs, compaction, error classification
- `docs/plan.md` — active roadmap and next steps

## Deployment

- `charts/agent-factory/` — Helm chart (the supported deployment path)
- `examples/instances/` — sample Helm values for internal / customer / demo / local flavors
- `docs/operations.md` — metrics thresholds and remediation runbook

## History and release

- `docs/history.md` — implementation history
- `docs/release.md` — release checklist
- `docs/eval-openrouter-2026-05-18.md` — cross-provider model eval

## Quick rule

- Operating the system → `docs/users.md`
- Changing the system → `docs/developers.md`
- Understanding the LLM engine → `docs/engine.md`
- Understanding the architecture → `docs/architecture.md`
