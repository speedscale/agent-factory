# Kubernetes Deployment Guide

Audience: Agent Factory users/operators.

This guide shows how to run Agent Factory on Kubernetes using the same intake/worker split used locally.

## What this deployment includes

- `intake-api` deployment and service
- `worker` deployment
- shared PVC for `artifacts/` and `.work/`
- Kustomize base at `examples/deploy/kubernetes/base`

## Prerequisites

- Kubernetes cluster access
- `kubectl`
- image available at `ghcr.io/speedscale/agent-factory:latest`

If you are building locally and using kind/minikube, load the image into your cluster runtime.

## Deploy

The base kustomization pins the Agent Factory image tag via `examples/deploy/kubernetes/base/kustomization.yaml` `images.newTag`.
Update that tag for each release.

### Base profile (filesystem queue)

```bash
kubectl apply -k examples/deploy/kubernetes/base
```

### Redis scaling profile

```bash
kubectl apply -k examples/deploy/kubernetes/overlays/redis
```

### Job runtime profile (queue-drain Jobs)

```bash
kubectl apply -k examples/deploy/kubernetes/overlays/job-runtime
```

### GitHub webhook bot profile

```bash
kubectl apply -k examples/deploy/kubernetes/overlays/github-webhook-bot
```

This profile extends `job-runtime` and adds intake webhook wiring:

- repo allowlist for target repositories
- repo-to-manifest mapping mounted into intake container
- `GITHUB_WEBHOOK_SECRET` + `GITHUB_BOT_TOKEN` env from Kubernetes secret
- fallback issue comments for skipped/non-onboarded issues

Before apply in non-demo environments, update:

- `examples/deploy/kubernetes/overlays/github-webhook-bot/github-webhook-secrets.env`
  - preferred auth: `appId` + `appPrivateKey`
  - fallback auth: `botToken`

### Auth-token profile

```bash
kubectl apply -k examples/deploy/kubernetes/overlays/auth-token
```

Update the token value before production use:

```bash
kubectl -n agent-factory create secret generic intake-api-auth \
  --from-literal=INTAKE_API_TOKEN=<strong-token> \
  --dry-run=client -o yaml | kubectl apply -f -
```

The Redis profile adds:

- in-cluster Redis (`StatefulSet` + `Service`)
- Redis queue env wiring for intake and worker
- worker replicas scaled to `3` by default

The job-runtime profile adds:

- Redis queue profile
- disables the long-lived `worker` deployment (`replicas: 0`)
- a CronJob that spawns short-lived worker Jobs (`--once`) every 2 minutes
- Job retention controls (`ttlSecondsAfterFinished`, history limits)

Check status:

```bash
kubectl -n agent-factory get deploy,pods,svc,pvc
```

For Redis profile, also check:

```bash
kubectl -n agent-factory get statefulset redis
```

## Submit a run

Port-forward intake API:

```bash
kubectl -n agent-factory port-forward svc/intake-api 8080:8080
```

Submit sample intake payload:

```bash
curl -sS -X POST http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer <token-if-enabled>" \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

Query run status from intake API:

```bash
curl -sS "http://127.0.0.1:8080/runs?phase=queued&limit=20&offset=0"
curl -sS "http://127.0.0.1:8080/runs/<run-name>"
```

If auth-token overlay is enabled, include the authorization header for run and metrics endpoints.

Queue/run metrics from intake API:

```bash
curl -sS "http://127.0.0.1:8080/metrics"
```

Watch worker logs:

```bash
kubectl -n agent-factory logs deploy/worker -f
```

Optional: enable worker metrics endpoint by adding `WORKER_METRICS_PORT` env in deployment and querying `/metrics` via pod port-forward.

Inspect terminal summary artifact in the shared volume-backed run directory:

```bash
kubectl -n agent-factory exec deploy/worker -- ls /app/artifacts/<run-name>
kubectl -n agent-factory exec deploy/worker -- cat /app/artifacts/<run-name>/result.json
```

## Current limits of this deployment

- worker is wired to the local demo fixture source (`/app/.work/demo-fixture`)
- shared PVC still backs artifacts/workspace state
- Redis profile is single-Redis-instance for reference architecture (no HA)
- webhook relay and Slack command adapter are expected as external intake adapters that call `POST /qa/runs`

The `github-webhook-bot` overlay runs polling mode inside `intake-api` (no separate poller CronJob), and intake triggers one worker Job when runs are queued.

This is sufficient to prove service-mode architecture on cluster, including Redis-backed multi-worker queue consumption.

For bot identity and webhook/slack operating model, see `docs/cluster-bot-runtime.md`.

## Scaling guidance

- Start with overlay default `worker.replicas=3` and observe queue drain behavior.
- Increase `RUN_QUEUE_BATCH_SIZE` only after confirming worker CPU/memory headroom.
- Keep intake at 1 replica initially; scale intake only if run submission rate requires it.

See `docs/operations.md` for queue lag thresholds, failed-run ratio targets, and remediation steps.
