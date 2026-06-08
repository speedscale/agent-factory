# Configuration

Audience: agent-factory operators (anyone deploying the binary to a Docker container, k8s cluster, AI sandbox, or running it from the CLI).

The binary is portable. Engine + control-plane code is identical across deployments; per-deployment policy (which tickets, which repos, deploy topology, observability) is supplied at runtime via env vars or CLI flags. Config bundles per consumer live in [speedstack `instances/agent-factory/`](https://gitlab.com/speedscale/skunkworks/speedstack/-/tree/main/instances/agent-factory).

## Precedence

CLI flag > env var > default. CLI flags are only honored by the one-shot `llm-run` entry-point. Long-running entry-points (`intake-api`, `worker`) take env only.

## OTLP streaming

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `OTLP_RECEIVER_ENABLED` | intake-api | `false` | Master switch — turn on the OTLP gRPC receiver |
| `OTLP_RECEIVER_PORT` | intake-api | `4317` | gRPC listen port |
| `OTLP_WINDOW_MS` | intake-api | `60000` | Tumbling window duration in milliseconds |
| `OTLP_MAX_RECORDS_PER_SERVICE` | intake-api | `10000` | Per-service buffer high-water mark; oldest records dropped on overflow |
| `BASELINE_DIR` | intake-api | `/app/.work/baselines` | Directory for per-endpoint rolling baseline NDJSON files |

## Findings archive (S3-compatible)

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_TRAFFIC_ARCHIVE_BUCKET` | intake-api, worker | — | S3 bucket name for findings + evidence upload |
| `AF_TRAFFIC_ARCHIVE_ENDPOINT` | intake-api, worker | — | S3-compatible endpoint URL (e.g. `https://nyc3.digitaloceanspaces.com`) |
| `AF_TRAFFIC_ARCHIVE_REGION` | intake-api, worker | — | AWS region or equivalent |
| `AF_TRAFFIC_ARCHIVE_ACCESS_KEY_ID` | intake-api, worker | — | Secret. S3 access key |
| `AF_TRAFFIC_ARCHIVE_SECRET_ACCESS_KEY` | intake-api, worker | — | Secret. S3 secret key |

These are mounted from a k8s Secret via `intakeApi.otlp.archiveSecret.name` in the Helm chart. When any of `BUCKET`, `ACCESS_KEY_ID`, or `SECRET_ACCESS_KEY` is missing, archival is silently skipped. The **worker** also needs them — the reproduce handler uses them to `fetchArchive()` the evidence back from S3. Findings/evidence are stored under the `agent-factory/` key prefix in the bucket.

> The legacy `RADAR_ARCHIVE_*` names (from the radar pilot) are still read as a fallback, so a new image runs against an older chart without a flag-day. Prefer `AF_TRAFFIC_ARCHIVE_*` going forward.

## Reproduce loop (confirm + replicate)

Consumed by the worker's `reproduce` handler (`spec.agent: "reproduce"`), which the streaming pipeline enqueues for high-severity regressions.

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `REPRODUCE_REPLAY_TARGET` | worker (reproduce) | — | Full or partial URL passed to `proxymock replay --test-against`. When unset, the handler degrades to re-analysing the captured traffic instead of a live replay. |
| `LINEAR_API_KEY` | worker (reproduce) | — | Secret. Linear personal API key for filing confirmed bugs. When unset, confirmation is recorded but no ticket is filed. |
| `LINEAR_REPRODUCE_TEAM_ID` | worker (reproduce) | — | Linear team UUID the auto-filed issue is created under. Required alongside `LINEAR_API_KEY` to file tickets. |
| `LINEAR_REPRODUCE_LABEL_ID` | worker (reproduce) | — | Optional Linear label UUID attached to auto-filed issues. |

In the Helm chart these map to `worker.reproduce.replayTarget`, `worker.reproduce.linearTeamId`, and `worker.reproduce.linearLabelId`; `LINEAR_API_KEY` comes from `linear.authSecret`. The worker also mounts `intakeApi.otlp.archiveSecret` (as `AF_TRAFFIC_ARCHIVE_*`) so the reproduce handler can fetch archived evidence back from S3.

## Identity / observability

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_INSTANCE` | all binaries | `local` | Free-form tag identifying this deployment in logs and metrics. CLI override: `--instance <name>` (llm-run only). |

## Ticket sourcing

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_LINEAR_QUERY` | poller (Linear path) | — | Linear filter string. Declared but unused today. |
| `INTAKE_ALLOWED_REPOS` | intake-api, issue-poller | `""` | Comma-separated `owner/repo` allow-list for GitHub-issue intake. |
| `INTAKE_ALLOW_UNKNOWN_REPOS` | intake-api | `false` | When `true`, allow repos outside the allow-list. |
| `INTAKE_REPO_APP_MAP_FILE` | intake-api, issue-poller | — | Path to JSON mapping `owner/repo` → GitHub App install. |
| `INTAKE_REPO_APP_MAP_JSON` | intake-api, issue-poller | — | Inline JSON alternative to the file. |
| `INTAKE_COMMENT_ON_SKIPPED_ISSUE` | intake-api | `false` | Post a comment back to GitHub when an issue was seen but skipped. |
| `INTAKE_ENABLE_EMBEDDED_POLLER` | intake-api | `false` | Run the issue poller in-process with the HTTP server. |
| `POLLER_INTERVAL_MS` | poller | — | Poll cadence (recommend ≥ 60_000 to avoid GitHub rate limits). |
| `POLLER_EVENT_KIND` | poller | `pulls` | `pulls` or `issues`. |
| `POLLER_MAX_ISSUES_PER_REPO` | issue-poller | `20` | Per-poll cap. |
| `POLLER_STATE_REDIS_URL` | poller | `redis://127.0.0.1:6379` (falls back to `REDIS_URL`) | Where last-seen state is cached. |
| `POLLER_STATE_KEY_PREFIX` | poller | `agent-factory:poller` | Redis key namespace. |

## GitHub auth + webhooks

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `GITHUB_API_BASE_URL` | intake-api, poller | `https://api.github.com` | Override for GHE or test stubs. |
| `GITHUB_WEBHOOK_SECRET` | intake-api | — | Secret. HMAC verification for inbound webhooks. |
| `GITHUB_TOKEN` | poller, MR creation | — | Secret. Personal or app token. |
| `GITHUB_APP_ID` | poller (App auth) | — | Secret. GitHub App identifier. |
| `GITHUB_APP_PRIVATE_KEY` | poller (App auth) | — | Secret. GitHub App private key. |
| `GITHUB_BOT_TOKEN` | poller (PAT fallback) | — | Secret. Used when App auth isn't configured. |
| `INTAKE_API_TOKEN` | intake-api | — | Secret. Bearer token for inbound API calls. |

## Run queue + workers

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `RUN_QUEUE_BACKEND` | worker | `filesystem` | `filesystem` or `redis`. |
| `REDIS_URL` | run-queue | `redis://redis:6379` | Used when backend is `redis`. |
| `REDIS_QUEUE_KEY` | run-queue | `agent-factory:runs:queued` | Redis list key. |
| `RUN_QUEUE_BATCH_SIZE` | worker | `20` | Items dequeued per worker pass. |
| `WORKER_MAX_ACTIVE_PHASE_MS` | worker | `0` (disabled) | Per-phase wall-clock cap. |
| `WORKER_METRICS_PORT` | worker | — | If set, expose Prometheus metrics on this port. |

## Controller (dead code)

These env vars are consumed by the CRD controller which is no longer used. Listed for reference until the dead code is removed.

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_WATCH_NAMESPACE` | controller | (all namespaces) | Restrict CRD watch to one namespace. |
| `AF_RUN_ROOT_DIR` | controller | `/app/.work/runs` | Per-run scratch dir. |
| `AF_HEALTHZ_PORT` | controller | `8081` | Liveness probe port. |

## Engine / model

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_ENGINE_KIND` | engine | `claude-sdk` | One of: `claude-sdk`, `openrouter`, `ds4`, `omlx`, `generic-llm`, `private-llm`. |
| `AF_ENGINE_MODEL` | engine | per-provider default | Model identifier. |
| `AF_ENGINE_ENDPOINT` | engine | (per provider) | Optional base URL override. |
| `ANTHROPIC_API_KEY` | engine (anthropic) | — | Secret. |
| `OPENROUTER_API_KEY` | engine (openrouter) | — | Secret. |
| `DS4_API_KEY` | engine (ds4) | `ds4-local` | Optional. |
| `DS4_BASE_URL` | engine (ds4) | `http://127.0.0.1:38011/v1` | |
| `OMLX_API_KEY` | engine (omlx) | `omlx-local` | Optional. |
| `OMLX_BASE_URL` | engine (omlx) | `http://127.0.0.1:38010/v1` | |
| `ENGINE_MAX_LOOPS` | engine | `50` | Agent-loop iteration cap. |
| `ENGINE_EVALUATOR_MAX_LOOPS` | engine | `20` | Evaluator-specific cap. |

### Provider matrix

| `AF_ENGINE_KIND` | Internal provider | Auth required | Notes |
|---|---|---|---|
| `claude-sdk` | `anthropic` | yes (`ANTHROPIC_API_KEY`) | Default. Anthropic cloud. |
| `openrouter` | `openrouter` | yes (`OPENROUTER_API_KEY`) | OpenRouter cloud. |
| `generic-llm` | `openrouter` | yes | Alias for OpenAI-compatible HTTP endpoint. |
| `private-llm` | `openrouter` | yes | Alias — same as `generic-llm`. |
| `ds4` | `ds4` | no | Local DeepSeek-V4-Flash. |
| `omlx` | `omlx` | no | Local MLX multi-model server. |

## Bot identity (auto-PR author)

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AGENT_FACTORY_BOT_NAME` | run-to-pr | — | Commit author / committer name. |
| `AGENT_FACTORY_BOT_EMAIL` | run-to-pr | — | Commit author / committer email. |

## HTTP server

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `PORT` | intake-api | `8080` | HTTP listen port. |

## Metrics

Both `intake-api` and `worker` expose Prometheus metrics. `/metrics` returns text/plain exposition format (Prometheus 0.0.4). Neither requires `INTAKE_API_TOKEN`.

| Endpoint | Format | Notes |
|---|---|---|
| `GET /metrics` (intake-api `:8080`) | text/plain | All metrics: run lifecycle + OTLP streaming |
| `GET /metrics.json` (intake-api `:8080`) | application/json | Legacy JSON shape |
| `GET /metrics` (worker) | text/plain | Worker-specific metrics |

Every metric carries an `instance` label sourced from `AF_INSTANCE`.

See `docs/operations.md` for the full metric inventory and thresholds.

## Helm chart values (OTLP-specific)

```yaml
intakeApi:
  otlp:
    enabled: true              # maps to OTLP_RECEIVER_ENABLED
    port: 4317                 # maps to OTLP_RECEIVER_PORT
    windowMs: 60000            # maps to OTLP_WINDOW_MS
    maxRecordsPerService: 10000 # maps to OTLP_MAX_RECORDS_PER_SERVICE
    archiveSecret:
      name: agent-factory-archive-s3   # k8s Secret with keys: bucket, endpoint, region, access-key-id, secret-access-key
```

## CLI flags (llm-run only)

| Flag | Notes |
|---|---|
| `--instance <name>` | Override `AF_INSTANCE` for this one run. |
| `--no-triage` | Skip pre-dispatch LLM triage. |
| `--no-context-check` | Skip the repro-context safety net. |
| `--no-checklist-check` | Skip the multi-deliverable gate. |
| `--no-eval` | Skip the post-Worker Evaluator. |
| `--provider`, `--model` | Override engine provider + model. |
| `--mode auto\|traffic\|source` | Override mode classifier. |
| `--verbose` / `-v` | Verbose tool I/O. |

Full usage: `npm run llm-run -- --help`.

## Reference config bundles

See [speedstack `instances/agent-factory/`](https://gitlab.com/speedscale/skunkworks/speedstack/-/tree/main/instances/agent-factory) for working `.env` files and chart values overrides per consumer.
