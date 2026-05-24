# Configuration

Audience: agent-factory operators (anyone deploying the binary to a Docker container, k8s cluster, AI sandbox, or running it from the CLI).

The binary is portable. Engine + control-plane code is identical across deployments; per-deployment policy (which tickets, which repos, deploy topology, observability) is supplied at runtime via env vars or CLI flags. Config bundles per consumer live in [speedstack `instances/agent-factory/`](https://gitlab.com/speedscale/skunkworks/speedstack/-/tree/main/instances/agent-factory).

## Precedence

CLI flag > env var > default. CLI flags are only honored by the one-shot `llm-run` entry-point. Long-running entry-points (`intake-api`, `controller`, `worker`) take env only.

## Identity / observability

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_INSTANCE` | all binaries | `local` | Free-form tag identifying this deployment in logs and metrics (e.g. `ken-local-cli`, `minikube-local`, `k8s-staging`). Surfaced in startup banner and in run-record JSON. CLI override: `--instance <name>` (llm-run only). |

## Ticket sourcing

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_LINEAR_QUERY` | poller (Linear path) | — | Linear filter string passed to the Linear API. **Declared but unused today**: the Linear intake path is a separate ticket (see "Roadmap" below). Configs may pin this value in advance. |
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
| `GITHUB_API_BASE_URL` | intake-api, poller, k8s-worker-job | `https://api.github.com` | Override for GHE or test stubs. |
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
| `REDIS_URL` | run-queue | `redis://redis:6379` | Used when backend is `redis`; shared with poller state. |
| `REDIS_QUEUE_KEY` | run-queue | `agent-factory:runs:queued` | Redis list key. |
| `RUN_QUEUE_BATCH_SIZE` | worker | `20` | Items dequeued per worker pass. |
| `WORKER_MAX_ACTIVE_PHASE_MS` | worker | `0` (disabled) | Per-phase wall-clock cap. |
| `WORKER_METRICS_PORT` | worker | — | If set, expose Prometheus metrics on this port. |

## K8s worker-job dispatch

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `INTAKE_TRIGGER_WORKER_JOB` | k8s-worker-job | `false` | Master switch — when on, intake dispatches into a Worker `Job` instead of a long-running worker. |
| `INTAKE_WORKER_JOB_NAMESPACE` | k8s-worker-job | (falls back to `POD_NAMESPACE` then SA file) | Where to create Jobs. |
| `INTAKE_WORKER_JOB_IMAGE` | k8s-worker-job | — | Required when `INTAKE_TRIGGER_WORKER_JOB=true`. |
| `INTAKE_WORKER_JOB_PVC` | k8s-worker-job | `agent-factory-data` | Persistent volume for the worker. |
| `INTAKE_WORKER_JOB_SERVICE_ACCOUNT` | k8s-worker-job | — | Worker SA. |

## Controller (k8s)

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_WATCH_NAMESPACE` | controller | (all namespaces) | Restrict CRD watch to one namespace. Empty = cluster-scoped. |
| `AF_RUN_ROOT_DIR` | controller | `/app/.work/runs` | Per-run scratch dir. |
| `AF_HEALTHZ_PORT` | controller | `8081` | Liveness probe port. |
| `KUBERNETES_SERVICE_HOST` | controller/k8s | (set by k8s) | Used to detect in-cluster vs out-of-cluster. |

## Engine / model

The agent loop picks an LLM provider from `AF_ENGINE_KIND`. The Helm
chart's `engine.kind` value is wired straight through to this env var,
and `src/lib/engine-config.ts` is the single source of truth for the
mapping. Unknown kinds throw at startup — there is no silent fallback to
Anthropic, so misconfiguration is loud rather than billed.

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AF_ENGINE_KIND` | engine | `claude-sdk` | One of: `claude-sdk`, `openrouter`, `ds4`, `omlx`, `generic-llm`, `private-llm`. See provider matrix below. |
| `AF_ENGINE_MODEL` | engine | per-provider default | Model identifier. Defaults: `claude-sonnet-4-6` (anthropic), `openai/gpt-5.4` (openrouter), `deepseek-v4-flash` (ds4), `Qwen3.6-27B-4bit` (omlx). |
| `AF_ENGINE_ENDPOINT` | engine | (per provider) | Optional base URL override. Today only consumed by the OpenAI-compatible providers via their own `*_BASE_URL` env vars. |
| `ANTHROPIC_API_KEY` | engine (anthropic provider) | — | Secret. Mirrored from `engine.authSecret` by the chart when `engine.kind=claude-sdk`. |
| `OPENROUTER_API_KEY` | engine (openrouter provider) | — | Secret. Required for the OpenRouter cloud client. |
| `DS4_API_KEY` | engine (ds4 provider) | `ds4-local` | Optional. Local server doesn't validate. |
| `DS4_BASE_URL` | engine (ds4 provider) | `http://127.0.0.1:38011/v1` | |
| `OMLX_API_KEY` | engine (omlx provider) | `omlx-local` | Optional. Local server doesn't validate. |
| `OMLX_BASE_URL` | engine (omlx provider) | `http://127.0.0.1:38010/v1` | |
| `ENGINE_MAX_LOOPS` | engine | `50` | Agent-loop iteration cap. |
| `ENGINE_EVALUATOR_MAX_LOOPS` | engine | `20` | Evaluator-specific cap. |

### Provider matrix

| `AF_ENGINE_KIND` / `engine.kind` | Internal provider | Auth required | Notes |
|---|---|---|---|
| `claude-sdk` | `anthropic` | yes (`ANTHROPIC_API_KEY`) | Default. Anthropic cloud. |
| `openrouter` | `openrouter` | yes (`OPENROUTER_API_KEY`) | OpenRouter cloud. |
| `generic-llm` | `openrouter` | yes | Alias — operator-friendly name for an OpenAI-compatible HTTP endpoint. |
| `private-llm` | `openrouter` | yes | Alias — same as `generic-llm`. |
| `ds4` | `ds4` | no | Local DeepSeek-V4-Flash on `127.0.0.1`. |
| `omlx` | `omlx` | no | Local MLX multi-model server on `127.0.0.1`. |

The chart's `engine.authSecret` block is required for the cloud kinds
and ignored for the local kinds (`ds4`, `omlx`). For local kinds, leave
`engine.authSecret.name` empty; the chart will skip the secret mount
rather than fail with `secretKeyRef.name=""`.

## Bot identity (auto-PR author)

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `AGENT_FACTORY_BOT_NAME` | run-to-pr | — | Commit author / committer name. |
| `AGENT_FACTORY_BOT_EMAIL` | run-to-pr | — | Commit author / committer email. |
| `AGENT_FACTORY_BOT_AUTHOR_NAME` | run-to-pr | `AGENT_FACTORY_BOT_NAME` | Override just the author. |
| `AGENT_FACTORY_BOT_AUTHOR_EMAIL` | run-to-pr | `AGENT_FACTORY_BOT_EMAIL` | |
| `AGENT_FACTORY_BOT_COMMITTER_NAME` | run-to-pr | `AGENT_FACTORY_BOT_NAME` | |
| `AGENT_FACTORY_BOT_COMMITTER_EMAIL` | run-to-pr | `AGENT_FACTORY_BOT_EMAIL` | |
| `AGENT_FACTORY_PROXYMOCK_MODE` | bot | — | `record` / `mock` / `replay`. |

## HTTP server

| Var | Consumer | Default | Notes |
|---|---|---|---|
| `PORT` | intake-api | `8080` | HTTP listen port. |

## Metrics

Both `intake-api` and `worker` expose Prometheus metrics. `/metrics` returns text/plain exposition format (Prometheus 0.0.4) and `/metrics.json` preserves the legacy JSON shape for non-Prometheus consumers. **Neither requires `INTAKE_API_TOKEN`** — they're read-only and meant for in-cluster scrape configs.

| Endpoint | Format | Notes |
|---|---|---|
| `GET /metrics` (intake-api `:8080`) | text/plain | Prometheus exposition |
| `GET /metrics.json` (intake-api `:8080`) | application/json | Legacy snapshot — `runTotals`, `queue` |
| `GET /metrics` (worker, when `WORKER_METRICS_PORT` set) | text/plain | Prometheus exposition |
| `GET /metrics.json` (worker, when `WORKER_METRICS_PORT` set) | application/json | Legacy `WorkerMetrics` JSON |

Every metric carries an `instance` label sourced from `AF_INSTANCE`.

### Metric inventory

| Metric | Type | Labels | Surface | Notes |
|---|---|---|---|---|
| `agent_factory_runs_total` | gauge | `phase`, `instance` | intake-api | Run count by lifecycle phase. Pre-seeded with all six phases at 0. |
| `agent_factory_queue_depth` | gauge | `backend`, `instance` | intake-api | Pending runs in the queue. |
| `agent_factory_worker_loops_total` | counter | `instance` | worker | Queue-poll iterations since startup. |
| `agent_factory_worker_runs_processed_total` | counter | `result` (`succeeded`/`failed`), `instance` | worker | Runs the worker took to a terminal state. |
| `agent_factory_worker_run_claims_skipped_total` | counter | `instance` | worker | Runs the worker skipped because another worker held the claim file. |
| `agent_factory_worker_stale_runs_failed_total` | counter | `instance` | worker | Active runs failed by the stale-claim sweep. |
| `agent_factory_worker_queue_depth` | gauge | `backend`, `instance` | worker | Most recently observed pending-run count from the worker's perspective. |

### Helm: ServiceMonitor for Prometheus Operator

```yaml
# values.yaml
serviceMonitor:
  enabled: true
  interval: 30s
  scrapeTimeout: 10s
  namespace: ""   # empty = release namespace
  labels:
    release: kube-prometheus-stack   # match your Prometheus' serviceMonitorSelector
```

Renders a `ServiceMonitor` CR scoped to the intake-api `Service` on its `http` port. The worker's `/metrics` is not yet fronted by a `Service` — separate follow-up if you want to scrape it too.

### Helm: Grafana dashboard

The chart ships a starter Grafana dashboard at `charts/agent-factory/dashboards/agent-factory.json`. Enable it to render a ConfigMap discoverable by kube-prometheus-stack's Grafana sidecar:

```yaml
# values.yaml
dashboards:
  enabled: true
  namespace: ""   # empty = release namespace
  labels:
    grafana_dashboard: "1"   # default; matches kube-prometheus-stack sidecar
```

Panels: stat-per-phase (queued/planned/building/validating/succeeded/failed), queue depth + time-series, worker activity (loop rate, runs-processed rate, claim-skip + stale-fail rate). Variables: datasource (Prometheus type) + instance (`exported_instance` label, picks up multi-instance deployments).

For Grafana setups without the sidecar, import the JSON via the Grafana UI (Dashboards → Import → Upload JSON) or HTTP API (`POST /api/dashboards/db`). The dashboard's `uid` is `agent-factory` — reimporting upgrades in place.

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

Full usage: `npm run llm-run -- --help` (or read the doc comment at the top of `src/bin/llm-run.ts`).

## Roadmap

- **Linear intake path** — `AF_LINEAR_QUERY` declared above is wired through `getInstanceConfig()` but not yet consumed by any poller. Tracked as a separate `factory` ticket.
- **Per-instance metrics labels** — Prometheus exports currently expose `AF_INSTANCE` only via stdout banners; need to flow into the `WORKER_METRICS_PORT` exporter labels as well.

## Reference config bundles

See [speedstack `instances/agent-factory/`](https://gitlab.com/speedscale/skunkworks/speedstack/-/tree/main/instances/agent-factory) for working `.env` files and chart values overrides per consumer (`ken-local-cli`, `minikube-local`, `do-nyc1-staging-decoy`). The `env-vars.md` index there links back to this doc.
