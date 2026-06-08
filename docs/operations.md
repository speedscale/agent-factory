# Operations Runbook

Audience: Agent Factory users/operators.

This guide defines baseline checks, alert thresholds, and remediation actions for Agent Factory.

## Key metrics

### OTLP streaming metrics (intake-api `GET /metrics`)

| Metric | Type | Labels | What it means |
|---|---|---|---|
| `af_otlp_records_received_total` | counter | `service` | RRPairs received from the forwarder |
| `af_otlp_records_dropped_total` | counter | `service` | Records dropped due to buffer high-water mark |
| `af_otlp_windows_processed_total` | counter | `service` | Tumbling windows closed and analyzed |
| `af_otlp_signals_found_total` | counter | `service` | Signals detected (the money metric) |
| `af_otlp_buffer_size` | gauge | `service` | Current record count buffered per service |
| `af_otlp_export_requests_total` | counter | — | OTLP Export RPCs received |
| `af_otlp_export_errors_total` | counter | — | OTLP Export RPCs that failed |

### Worker metrics (worker `GET /metrics`)

| Metric | Type | Labels | What it means |
|---|---|---|---|
| `agent_factory_worker_loops_total` | counter | `instance` | Queue-poll iterations since startup |
| `agent_factory_worker_runs_processed_total` | counter | `result`, `instance` | Runs taken to terminal state |
| `agent_factory_worker_run_claims_skipped_total` | counter | `instance` | Runs skipped (another worker holds claim) |
| `agent_factory_worker_stale_runs_failed_total` | counter | `instance` | Active runs failed by stale-claim sweep |
| `agent_factory_worker_queue_depth` | gauge | `backend`, `instance` | Pending run count |

### Run lifecycle metrics (intake-api `GET /metrics`)

| Metric | Type | Labels | What it means |
|---|---|---|---|
| `agent_factory_runs_total` | gauge | `phase`, `instance` | Run count by lifecycle phase |
| `agent_factory_queue_depth` | gauge | `backend`, `instance` | Pending runs in the queue |

## Dashboard query examples

### Kubernetes

```bash
kubectl -n agent-factory port-forward svc/agent-factory-intake-api 8080:8080
curl -sS http://127.0.0.1:8080/metrics
```

### Key PromQL queries

```promql
# Records received per minute by service
rate(af_otlp_records_received_total[5m]) * 60

# Signal detection rate (how fast are we finding bugs)
rate(af_otlp_signals_found_total[5m]) * 60

# Buffer pressure (approaching high-water mark?)
af_otlp_buffer_size

# Drop rate (are we losing data?)
rate(af_otlp_records_dropped_total[5m])
```

## Baseline thresholds

### Streaming pipeline

- `af_otlp_buffer_size < maxRecordsPerService (10000)` per service — if approaching, window timer may be too slow or records arriving too fast
- `af_otlp_records_dropped_total` increasing — data loss; lower `windowMs` or raise `maxRecordsPerService`
- `af_otlp_export_errors_total` increasing — forwarder can't reach intake-api; check service connectivity
- `af_otlp_records_received_total` flat — forwarder stopped sending; check EXPORTERS config and forwarder health

### Run queue

- `queue.depth <= 5` for normal operation
- `queue.depth > 20` for more than 10 minutes: scale workers up
- `queue.depth > 50`: incident-level backlog
- Failed-run ratio (`failed / (failed + succeeded)`) should remain under `10%`
- Failed-run ratio over `25%` for 15 minutes: treat as degraded pipeline

## Remediation actions

### OTLP receiver not receiving traffic

1. Verify forwarder ConfigMap has `EXPORTERS` entry pointing at `agent-factory-intake-api:4317`
2. Check intake-api pod is running and port 4317 is open: `kubectl -n agent-factory get pods`
3. Check intake-api logs for gRPC server startup: `kubectl -n agent-factory logs deploy/agent-factory-intake-api | grep -i otlp`
4. Verify `OTLP_RECEIVER_ENABLED=true` in deployment env

### Buffer overflow (records dropping)

1. Check `af_otlp_buffer_size` per service — identify which service is overflowing
2. Option A: decrease `OTLP_WINDOW_MS` (process windows faster)
3. Option B: increase `OTLP_MAX_RECORDS_PER_SERVICE` (bigger buffer)
4. Option C: add DLP filter in forwarder EXPORTERS to reduce traffic volume

### Findings not archiving

1. Check that `AF_TRAFFIC_ARCHIVE_BUCKET`, `AF_TRAFFIC_ARCHIVE_ACCESS_KEY_ID`, `AF_TRAFFIC_ARCHIVE_SECRET_ACCESS_KEY` are set (legacy `RADAR_ARCHIVE_*` also honoured)
2. Verify the k8s secret referenced by `intakeApi.otlp.archiveSecret.name` exists in the namespace
3. Check intake-api logs for S3 upload errors
4. Verify bucket exists and credentials have write access

### High queue depth

1. Confirm intake is healthy (`/healthz`) and workers are running.
2. Scale workers (`kubectl scale deploy/worker --replicas=<n>`).
3. Recheck `queue.depth` every 2-5 minutes.

### Rising failed-run ratio

1. Inspect failed runs: `GET /runs?phase=failed`.
2. Open `result.json` for representative failures.
3. Separate infrastructure failures from app validation failures.
4. Requeue recoverable runs once root issue is mitigated.

## SLO starter suggestions

- OTLP receiver uptime 99.9% (measured by `af_otlp_export_requests_total` vs `af_otlp_export_errors_total`)
- Buffer drop rate < 0.1% of received records
- 95% of agent runs complete within 10 minutes
- Queue depth returns below 5 within 15 minutes after burst load
- Failed-run ratio below 10% in steady state

## Current staging deployment

- **Cluster**: `do-nyc1-staging-decoy`
- **Namespace**: `agent-factory`
- **Image**: `ghcr.io/speedscale/agent-factory:v0.1.80`
- **OTLP**: enabled, port 4317, 60s windows, 10k records/service
- **Archive**: `do-nyc1-staging-decoy-radar` (DO Spaces nyc3, 3-day lifecycle)
- **Forwarder**: v2.5.617 in `speedscale` namespace, EXPORTERS includes `agent_factory`
- **Services streaming**: banking-accounts, banking-frontend, banking-gateway, banking-transactions, banking-notification, outerspace-server

## Grafana dashboard

**Status**: not yet built. The metrics are emitted in Prometheus format but there's no dashboard JSON. This is tracked in `docs/plan.md` under P1. When built, enable via:

```yaml
dashboards:
  enabled: true
  labels:
    grafana_dashboard: "1"
```
