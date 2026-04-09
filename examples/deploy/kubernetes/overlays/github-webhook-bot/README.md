# GitHub Webhook Bot Overlay

This overlay extends `job-runtime` and configures intake for direct GitHub issue webhooks.

It also includes a `github-issue-poller` CronJob so you can start in polling mode before enabling inbound webhooks.

## What it adds

- intake env for repo allowlist and webhook-mode behavior
- mounted repo->app mapping and manifests at `/app/config`
- secret-backed webhook signature + bot token env vars
- `github-issue-poller` CronJob (`*/2 * * * *`) that polls open issues and queues eligible runs

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

If you only want polling mode initially, deploy this overlay and skip webhook setup.
