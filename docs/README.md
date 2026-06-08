# Documentation Index

## Primary entry points

- `docs/architecture.md` — streaming pipeline design, deployment, contracts
- `docs/operations.md` — metrics, thresholds, and remediation runbook
- `docs/CONFIG.md` — every env var and Helm value

## Architecture and design

- `docs/architecture.md` — OTLP streaming pipeline, signal detection, baseline store, archive
- `docs/engine.md` — LLM engine: tool catalog, agent loop, Planner/Worker phases
- `docs/engine-source-mode.md` — engine source mode for non-wire-shaped specs
- `docs/engine-hardening.md` — tool-call hardening: rescue, escalating nudges, prereqs, compaction
- `docs/plan.md` — roadmap: close the detect/confirm/replicate loop

## Deployment

- `charts/agent-factory/` — Helm chart (the supported deployment path)
- `docs/CONFIG.md` — env vars, Helm values, CLI flags
- `docs/operations.md` — metrics thresholds and remediation runbook

## History and release

- `docs/history.md` — refactor history (CRD → Redis queue → OTLP streaming)
- `docs/release.md` — release checklist
- `docs/eval-openrouter-2026-05-18.md` — cross-provider model eval

## Quick rule

- Operating the system → `docs/operations.md`
- Changing the system → `docs/developers.md`
- Understanding the streaming pipeline → `docs/architecture.md`
- Understanding the LLM engine → `docs/engine.md`
- What to build next → `docs/plan.md`
