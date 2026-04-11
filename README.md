# Agent Factory

Agent Factory is a reference architecture for a quality validation loop:

`onboard -> baseline -> compare -> report`

It takes a validation request (usually from a pull request), runs reproducible quality checks, compares results to baseline, and emits artifacts for operator review.

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

Artifacts land in `artifacts/<run-name>/`, including terminal summary `result.json` and quality report outputs.

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

Submit quality runs through intake API `POST /qa/runs` using payloads in `examples/runs/` (comparison and baseline examples are included).

## Core Artifacts Per Run

- `run.json`
- `baseline.json`
- `build.log`
- `validation.log`
- `quality-report.json`
- `quality-report.md`
- `evidence.json`
- `result.json`
