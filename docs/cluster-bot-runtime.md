# Cluster Bot Runtime

Audience: operators moving Agent Factory from local-agent execution to a cluster service.

## Goal

Run Agent Factory as a bot-first service in Kubernetes with event-driven intake, short-lived run workers, and auditable bot identity.

## Target Shape

`GitHub webhook + Slack command -> intake relay -> queued run -> worker Job -> baseline compare + quality report`

## Required Capabilities

- **Webhook notifications**: accept GitHub PR events as intake triggers.
- **Slack reachability**: accept slash commands or workflow actions that dispatch a ticket.
- **Bot identity**: PRs/comments are authored by bot credentials, not operator personal identity.
- **Job-per-run execution**: each run executes in an isolated Kubernetes `Job`.
- **Automatic cleanup**: completed Jobs and stale work artifacts are cleaned up over time.

## Reference Components

### 1) Event Intake Relay

Use a small relay service (or workflow tool) that:

- validates GitHub webhook signatures and Slack request signatures
- maps incoming events to `QaIntakeEvent` (`schemas/qa-intake.schema.yaml`)
- posts canonical intake payload to Agent Factory `POST /qa/runs`

This keeps source-specific auth logic out of core planner/runner behavior.

For direct GitHub PR webhook mode in Kubernetes, use:

- `examples/deploy/kubernetes/overlays/github-webhook-bot`
- `scripts/configure-github-quality-webhooks.sh` to create/update PR webhooks for all target repos

For polling-first rollout, the same overlay enables polling inside `intake-api` (no separate poller workload) to discover open PRs without inbound webhooks.

### 2) Bot Identity Contract

Use dedicated bot credentials for repository mutations:

- preferred: GitHub App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`)
- fallback: PAT scoped to bot account (`GH_TOKEN`/`GITHUB_BOT_TOKEN`)
- export `GH_TOKEN` for `gh` commands
- set commit identity env vars for `run-to-pr`:
  - `AGENT_FACTORY_BOT_NAME`
  - `AGENT_FACTORY_BOT_EMAIL`
  - optional overrides:
    - `AGENT_FACTORY_BOT_AUTHOR_NAME`
    - `AGENT_FACTORY_BOT_AUTHOR_EMAIL`
    - `AGENT_FACTORY_BOT_COMMITTER_NAME`
    - `AGENT_FACTORY_BOT_COMMITTER_EMAIL`

With this, commit/PR activity appears as the bot account instead of a human operator.

### 3) Job Runner Pattern

Use queue-backed, short-lived workers:

- intake writes queued run
- dispatcher creates a worker `Job` per run (or schedules periodic queue-drain jobs)
- worker runs `node dist/bin/worker.js --once` and exits
- job sets `ttlSecondsAfterFinished` for automatic GC

The `examples/deploy/kubernetes/overlays/job-runtime` overlay shows a CronJob-driven queue drain profile that is compatible with this pattern.

### 4) Cleanup and Retention

- Kubernetes `ttlSecondsAfterFinished` handles completed Job objects.
- CronJob history limits cap retained successful/failed Job records.
- Artifact retention policy should be explicit (for example: keep 14-30 days for debugging evidence).

## "Claw" Controller Note

If you want a dedicated dispatcher/reconciler (for example, NemoClaw-like behavior), keep it as a thin control-plane component:

- watch queued runs
- create/label worker Jobs
- enforce max concurrency and retry policy
- annotate run status with scheduling metadata

Do not move planning/build/validation logic into that controller.

## Rollout Sequence

1. Deploy Redis queue overlay and bot secrets.
2. Deploy job-runtime overlay with queue-drain CronJob.
3. Wire GitHub webhook relay to `POST /runs` using app manifest mapping.
4. Wire Slack command relay to same canonical intake path.
5. Verify one full run produces baseline comparison artifacts and a bot-authored PR quality comment.

## Webhook Bootstrap Commands

Deploy webhook profile:

```bash
kubectl apply -k examples/deploy/kubernetes/overlays/github-webhook-bot
```

Configure GitHub PR webhooks:

```bash
WEBHOOK_URL=https://<intake-host>/webhooks/github/pulls \
WEBHOOK_SECRET=<same-as-GITHUB_WEBHOOK_SECRET> \
scripts/configure-github-quality-webhooks.sh
```
