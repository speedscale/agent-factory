# Agent Factory

Agent Factory is a reference architecture for an autonomous inner loop:

`issue -> plan -> build -> validate`

It takes an intake payload, creates a run workspace, attempts a fix, validates with replay evidence, and emits artifacts for operator review.

## Start Here

- **I want to run Agent Factory:** see `docs/users.md`
- **I want to build/change Agent Factory:** see `docs/developers.md`
- **I need the full doc index:** see `docs/README.md`

## Audience Split

- **Users (operators/integrators):** deployment, run submission, metrics, troubleshooting, and day-2 operations
- **Developers (contributors):** architecture, contracts, roadmap, release flow, and implementation history

## Quick Run (Local Golden Path)

```bash
npm install
npm run demo
```

Artifacts land in `artifacts/<run-name>/`, including terminal summary `result.json`.

## Quick Run (Always-On Compose)

```bash
cp .env.server.example .env.server
docker compose --env-file .env.server -f docker-compose.server.yml up -d
docker compose --env-file .env.server -f docker-compose.server.yml ps
```

## Quick Run (Kubernetes)

```bash
kubectl apply -k examples/deploy/kubernetes/base
kubectl apply -k examples/deploy/kubernetes/overlays/redis
```

Submit runs through intake API `POST /runs` using payloads in `examples/runs/`.

## Core Artifacts Per Run

- `run.json`
- `triage.json`
- `plan.yaml`
- `patch.diff`
- `build.log`
- `validation.log`
- `evidence.json`
- `result.json`
