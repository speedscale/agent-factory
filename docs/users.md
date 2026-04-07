# Agent Factory User Guide

This guide is for operators and integrators who run Agent Factory.

## What Agent Factory Does

Agent Factory executes a repeatable run loop:

1. intake issue + app manifest
2. triage and plan
3. build patch in isolated workspace
4. validate with replay evidence
5. emit artifacts for operator decision

## Choose a Runtime Mode

- **Local demo:** fastest way to verify installation
- **Server mode (API + worker):** long-running local/VM process model
- **Docker Compose always-on:** easiest persistent setup
- **Kubernetes:** multi-worker cluster deployment

## Fast Start

### Local demo

```bash
npm install
npm run demo
```

### Always-on Docker Compose

```bash
cp .env.server.example .env.server
docker compose --env-file .env.server -f docker-compose.server.yml up -d
docker compose --env-file .env.server -f docker-compose.server.yml ps
```

### Kubernetes

```bash
kubectl apply -k examples/deploy/kubernetes/base
kubectl apply -k examples/deploy/kubernetes/overlays/redis
```

## Submit and Track Runs

Submit:

```bash
curl -sS -X POST http://127.0.0.1:8080/runs \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

List/query:

```bash
curl -sS "http://127.0.0.1:8080/runs?phase=queued&limit=20&offset=0"
curl -sS "http://127.0.0.1:8080/runs/<run-name>"
curl -sS "http://127.0.0.1:8080/metrics"
```

## Required Evidence Quality

For real tickets, treat successful command execution as necessary but not sufficient.

- include logs/capture/repro context in intake `evidence`
- keep environment scope explicit (local vs staging/cluster)
- provide endpoint-level replay outcomes when performance is in scope
- keep `build.test` and `validate.proxymock.command` meaningful (no no-op placeholders)

## Operational Baselines

- queue depth should stay near 0 in steady state
- failed-run ratio should stay below 10%
- rising queue depth or persistent failures means scale/tune workers and inspect `result.json`

## Where to Go Deeper

- detailed server steps: `docs/server.md`
- Kubernetes specifics: `docs/kubernetes.md`
- metrics/remediation playbook: `docs/operations.md`
- microsvc walkthrough: `docs/microsvc.md`
