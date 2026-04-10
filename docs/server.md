# Local and Server Runbook

Audience: Agent Factory users/operators.

This runbook shows how to execute and verify Agent Factory in both modes:

- local one-shot golden path
- server-style intake + worker loop

For a quicker summary path, start at `docs/users.md` and come back here for full command-level detail.

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

Queue backend selection:

- `RUN_QUEUE_BACKEND=filesystem` (default, implemented)
- `RUN_QUEUE_BACKEND=redis` (implemented)

GitHub PR webhook intake (optional):

- endpoint: `POST /webhooks/github/pulls`
- event type: `pull_request`
- supported actions: `opened`, `reopened`, `synchronize`
- `GITHUB_WEBHOOK_SECRET` (optional but recommended)
- `INTAKE_ALLOWED_REPOS` (comma-separated `owner/repo` allowlist)
- `INTAKE_REPO_APP_MAP_JSON` (JSON map of repo to manifest path)
- `INTAKE_REPO_APP_MAP_FILE` (path to JSON mapping file; merged with env map)
- `INTAKE_COMMENT_ON_SKIPPED_ISSUE=true` to post bot fallback comments when label-gated events are skipped
- auth options for GitHub API calls:
  - preferred: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`
  - fallback: `GITHUB_BOT_TOKEN` or `GH_TOKEN`

GitHub poller mode (optional):

- standalone command: `npm run issue-poller -- --once`
- PR-focused command: `npm run pr-poller -- --once`
- embedded in intake: set `INTAKE_ENABLE_EMBEDDED_POLLER=true`
- interval: `POLLER_INTERVAL_MS` (default `120000`)
- poll selector: `POLLER_EVENT_KIND=issues|pulls|both` (default `pulls`)
- polls open issues/PRs in `INTAKE_ALLOWED_REPOS`
- loads repo manifests from `INTAKE_REPO_APP_MAP_FILE` or `INTAKE_REPO_APP_MAP_JSON`
- queues runs for events that satisfy required labels
- posts one bot comment for missing-label or missing-manifest cases
- GitHub auth uses same precedence as webhook intake (App first, token fallback)

Worker trigger mode (optional):

- set `INTAKE_TRIGGER_WORKER_JOB=true` to create one Kubernetes Job when a run is queued
- requires `INTAKE_WORKER_JOB_IMAGE` and in-cluster service account permissions for creating Jobs

Redis configuration:

- `REDIS_URL` (example: `redis://127.0.0.1:6379`)
- `REDIS_QUEUE_KEY` (default: `agent-factory:runs:queued`)
- `RUN_QUEUE_BATCH_SIZE` (default: `25`)

Run operations:

- list runs: `npm run runs -- list [--phase <phase>]`
- retry a failed run: `npm run runs -- retry <run-name>`

When Redis backend is enabled, intake and retry operations enqueue run names to Redis and workers consume from Redis.

### Terminal A: start intake API

```bash
npm run intake-api
```

Health check:

```bash
curl -s http://localhost:8080/healthz
```

Optional secure mode (token auth):

```bash
INTAKE_API_TOKEN=change-me npm run intake-api
```

Example with webhook repo mapping:

```bash
INTAKE_ALLOWED_REPOS=speedscale/microsvc,speedscale/demo \
INTAKE_REPO_APP_MAP_FILE=examples/apps/repo-app-map.json \
INTAKE_COMMENT_ON_SKIPPED_ISSUE=true \
GITHUB_WEBHOOK_SECRET=change-me \
GITHUB_BOT_TOKEN=<bot-token> \
npm run intake-api
```

Reference multi-repo mapping file: `examples/apps/repo-app-map.json`.

In secure mode, include either header on run/metrics requests:

```bash
Authorization: Bearer change-me
```

or

```bash
x-api-key: change-me
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

The worker claims runs with an on-disk claim file to avoid double-processing when multiple workers are running.

Optional claim expiration override:

```bash
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture --claim-ttl-ms 900000
```

Use `--once` for one-shot processing in tests/CI:

```bash
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture --once
```

## 3) Server Mode with Docker Compose

Build and start services:

```bash
docker compose -f docker-compose.server.yml up --build
```

Run as always-on services (recommended):

```bash
cp .env.server.example .env.server
docker compose --env-file .env.server -f docker-compose.server.yml up -d
```

This profile enables:

- container restart policy (`unless-stopped`) for intake/worker/redis
- health checks for intake and redis
- worker metrics endpoint on `:9090`
- configurable worker source via `WORKER_SOURCE`

Check status:

```bash
docker compose --env-file .env.server -f docker-compose.server.yml ps
curl -sS http://127.0.0.1:8080/healthz
curl -sS http://127.0.0.1:9090/metrics
```

View logs:

```bash
docker compose --env-file .env.server -f docker-compose.server.yml logs -f intake-api worker
```

Enable Redis queue backend in compose:

```bash
RUN_QUEUE_BACKEND=redis docker compose -f docker-compose.server.yml up --build
```

To run worker against a real repo (instead of demo fixture), mount that repo and set `WORKER_SOURCE`.
Example:

```bash
WORKER_SOURCE=/repos/microsvc docker compose --env-file .env.server -f docker-compose.server.yml up -d
```

Then submit intake requests from another terminal:

```bash
curl -sS -X POST http://127.0.0.1:8080/runs \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

QA-mode intake example:

```bash
curl -sS -X POST http://127.0.0.1:8080/qa/runs \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-pr-quality-intake.json
```

Stop services:

```bash
docker compose --env-file .env.server -f docker-compose.server.yml down
```

### Submit a run request

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H "Authorization: Bearer change-me" \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

If secure mode is disabled, omit the auth header.

Expected outcome:

- intake response includes a run name
- worker logs `run processed`
- `artifacts/<run-name>/run.json` reaches `succeeded`

Query run status from intake API:

```bash
curl -sS "http://127.0.0.1:8080/runs?phase=succeeded&limit=20&offset=0"
curl -sS "http://127.0.0.1:8080/runs/<run-name>"
```

Query intake metrics (queue depth + run totals):

```bash
curl -sS "http://127.0.0.1:8080/metrics"
```

Optional worker metrics endpoint:

```bash
WORKER_METRICS_PORT=9090 PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture
curl -sS "http://127.0.0.1:9090/metrics"
```

Baseline operational checks:

- queue depth stays near `0` during steady state
- `runsFailed` does not increase continuously over multiple polling intervals
- queue depth growth faster than processed runs indicates scale-up need (add worker replicas)

See `docs/operations.md` for threshold values and remediation workflow.

## 4) Server Mode Test Assertions

After submission, confirm:

- intake returns a run name
- worker logs show the run progressing through `planned -> built -> validated`
- `artifacts/<run-name>/run.json` ends in `succeeded` or `failed` with explicit summary

Manual `planner` / `runner` / `validator` command execution is developer debugging workflow and is documented in `docs/developers.md`.

## 5) Artifact Expectations

For every run, verify these files exist under `artifacts/<run-name>/`:

- `app.json`
- `issue.json`
- `run.json`
- `evidence.json`
- `triage.json`
- `plan.yaml`
- `patch.diff`
- `build.log`
- `validation.log`
- `result.json`

This artifact set is the minimum proof contract for `issue -> plan -> build -> validate`.

`result.json` is the terminal summary artifact for operators and automation. It includes run identity, final phase, summary, command outcomes, and artifact pointers.

`evidence.json` captures the incident investigation chain (logs/capture summary, repro steps, and replay outcome) and should be reflected in PR summaries.

If the `POST /runs` intake payload includes an `evidence` object (see `examples/runs/real-ticket-intake.template.json`), intake seeds that content directly into `evidence.json` at run creation time.

Intake rejects no-op build/validation commands; `build.test` and `validate.proxymock.command` must be meaningful commands (for example, `true` and `:` are rejected).
