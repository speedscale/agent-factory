# GitHub Webhook Bot Overlay

This overlay extends `job-runtime` and configures intake for direct GitHub issue webhooks.

Polling is embedded inside `intake-api` so there is no separate poller workload.

## What it adds

- intake env for repo allowlist and webhook-mode behavior
- embedded issue polling loop inside intake (`INTAKE_ENABLE_EMBEDDED_POLLER=true`)
- per-run worker Job trigger from intake (`INTAKE_TRIGGER_WORKER_JOB=true`)
- mounted repo->app mapping and manifests at `/app/config`
- secret-backed webhook signature + bot token env vars
- namespace-scoped RBAC so intake can create worker Jobs

## Required edits before deploy

Update `github-webhook-secrets.env`:

- `webhookSecret`: shared secret configured in GitHub webhook settings
- `botToken`: token for posting comments and polling (temporary PAT-style auth)
- `appId`: GitHub App id (preferred)
- `appPrivateKey`: GitHub App private key PEM (multiline or `\\n` escaped)

Auth precedence in runtime:

1. GitHub App (`appId` + `appPrivateKey`)
2. static token (`botToken`)

## Deploy

```bash
kubectl apply -k examples/deploy/kubernetes/overlays/github-webhook-bot
```

## Configure webhooks

```bash
WEBHOOK_URL=https://<intake-host>/webhooks/github/issues \
WEBHOOK_SECRET=<same-secret> \
scripts/configure-github-issue-webhooks.sh
```

If you only want polling mode initially, deploy this overlay and skip webhook setup.
