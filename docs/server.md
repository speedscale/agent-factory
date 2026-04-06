# Local and Server Runbook

This runbook shows how to execute and verify Agent Factory in both modes:

- local one-shot golden path
- server-style intake + worker loop

## Prerequisites

- Node.js 20+
- npm

Install dependencies:

```bash
npm install
```

## 1) Local Mode (single command)

Run the golden path:

```bash
npm run demo
```

Expected outcome:

- one run directory under `artifacts/`
- `run.json` ends in `succeeded`
- build and validation logs are present

Quick verification:

```bash
ls artifacts
```

## 2) Server Mode (API + worker)

Server mode uses two long-lived processes.

### Terminal A: start intake API

```bash
npm run intake-api
```

Health check:

```bash
curl -s http://localhost:8080/healthz
```

### Terminal B: create fixture and start worker

Create a deterministic local app fixture and proxymock shim:

```bash
npm run create-demo-fixture
```

Start worker with fixture source and proxymock shim on `PATH`:

```bash
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture
```

### Terminal C: submit a run request

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

Expected outcome:

- intake response includes a run name
- worker logs `run processed`
- `artifacts/<run-name>/run.json` reaches `succeeded`

## 3) Server Mode Test Assertions

Use these checks after submitting a run:

```bash
ls artifacts
```

```bash
npm run planner -- --run <run-name>
```

```bash
npm run runner -- --run <run-name> --source .work/demo-fixture
```

```bash
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run validator -- --run <run-name>
```

Notes:

- The worker already executes planner/runner/validator automatically; manual stage commands are for debugging.
- `--source` must point at a directory that contains the app workdir from `AgentApp` (`node/` in demo).

## 4) Artifact Expectations

For every run, verify these files exist under `artifacts/<run-name>/`:

- `app.json`
- `issue.json`
- `run.json`
- `plan.yaml`
- `patch.diff`
- `build.log`
- `validation.log`

This artifact set is the minimum proof contract for `issue -> plan -> build -> validate`.
