# Agent Factory

Agent Factory is a public reference architecture for an autonomous inner dev loop:

`issue -> plan -> build -> validate`

The goal is simple: take a bug report, generate a plan, attempt a fix in an isolated workspace, and validate the result against recorded traffic with `proxymock`.

This repo is intentionally focused on the tight inner loop, not full CI/CD or production deployment.

The core design keeps three boundaries clear:

- **app**: the target codebase
- **agent**: planning and code execution
- **validation**: replay-based proof

Apps should be onboarded declaratively through a small manifest instead of being hardcoded into the control plane.

The current repo contains the initial design docs and onboarding contract for the first implementation pass.

- [Architecture](docs/architecture.md)
- [Plan](docs/plan.md)
- [Golden Path Demo](docs/demo.md)
- [Local and Server Runbook](docs/server.md)
- [Microsvc Onboarding](docs/microsvc.md)
- [Sample `AgentApp`](examples/apps/demo-node/agentapp.yaml)

## Run Locally

```bash
npm install
npm run demo
```

This runs one end-to-end golden path and writes artifacts under `artifacts/<run-name>/`.

## Run As Server

Start intake API:

```bash
npm run intake-api
```

Start worker in another terminal:

```bash
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture
```

Queue backend defaults to filesystem. Override with `RUN_QUEUE_BACKEND` when alternate backends are added.

Submit a run:

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

See `docs/server.md` for full setup and verification steps.

## Run As Containers

```bash
docker compose -f docker-compose.server.yml up --build
```
