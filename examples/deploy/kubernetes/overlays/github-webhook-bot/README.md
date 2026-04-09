# GitHub Webhook Bot Overlay

This overlay extends `job-runtime` and configures intake for direct GitHub issue webhooks.

## What it adds

- intake env for repo allowlist and webhook-mode behavior
- mounted repo->app mapping and manifests at `/app/config`
- secret-backed webhook signature + bot token env vars

## Required edits before deploy

Update `github-webhook-secrets.env`:

- `webhookSecret`: shared secret configured in GitHub webhook settings
- `botToken`: token for posting fallback issue comments

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
