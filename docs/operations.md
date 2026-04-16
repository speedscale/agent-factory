# Operations Runbook

Audience: Agent Factory users/operators.

This guide defines baseline checks, alert thresholds, and remediation actions for Agent Factory.

## Key metrics

From intake API (`GET /metrics`):

- `queue.depth`: current queued run count
- `runTotals.byPhase.failed`: cumulative failed runs
- `runTotals.byPhase.succeeded`: cumulative succeeded runs

From worker (`GET /metrics` when `WORKER_METRICS_PORT` is set):

- `metrics.runsProcessed`
- `metrics.runsFailed`
- `metrics.loops`
- `metrics.lastBatchSize`
- `metrics.runClaimsSkipped` (filesystem backend only)
- `metrics.staleRunsFailed` (auto-failed stale active runs)

## Dashboard query examples

### Local mode

```bash
curl -sS http://127.0.0.1:8080/metrics
curl -sS http://127.0.0.1:9090/metrics
```

If `INTAKE_API_TOKEN` is enabled, include `Authorization: Bearer <token>` on intake metrics requests.

### Kubernetes mode

```bash
kubectl -n agent-factory port-forward svc/intake-api 8080:8080
curl -sS http://127.0.0.1:8080/metrics
```

Worker metrics (per-pod):

```bash
kubectl -n agent-factory port-forward deploy/worker 9090:9090
curl -sS http://127.0.0.1:9090/metrics
```

## Baseline thresholds

- `queue.depth <= 5` for normal operation
- `queue.depth > 20` for more than 10 minutes: scale workers up
- `queue.depth > 50`: incident-level backlog
- failed-run ratio (`failed / (failed + succeeded)`) should remain under `10%`
- failed-run ratio over `25%` for 15 minutes: treat as degraded pipeline

## Remediation actions

### High queue depth

1. Confirm intake is healthy (`/healthz`) and workers are running.
2. Scale workers (`kubectl scale deploy/worker --replicas=<n>`).
3. Recheck `queue.depth` every 2-5 minutes.

### Rising failed-run ratio

1. Inspect failed runs: `GET /runs?phase=failed`.
2. Open `result.json` for representative failures.
3. Separate infrastructure failures (queue/connectivity/runtime) from app validation failures.
4. Requeue recoverable runs once root issue is mitigated.

### Worker not progressing

1. Check worker `/metrics` (`loops` increasing, `runsProcessed` static indicates idle or blocked queue).
2. Check queue backend configuration (`RUN_QUEUE_BACKEND`, `REDIS_URL`, `REDIS_QUEUE_KEY`).
3. Enable stale-run watchdog by setting `WORKER_MAX_ACTIVE_PHASE_MS` (or `--max-active-phase-ms`) so old `planned/building/validating` runs are auto-failed.
4. Restart worker deployment if metrics endpoint is stale.

## SLO starter suggestions

- 95% of runs complete within 10 minutes
- queue depth returns below 5 within 15 minutes after burst load
- failed-run ratio below 10% in steady state

These are starter values; tune by observed traffic and run duration in your environment.
