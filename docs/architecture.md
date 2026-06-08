# Architecture

Audience: Agent Factory developers and contributors.

## Streaming pipeline

Traffic flows continuously from instrumented services through the Speedscale forwarder into Agent Factory via OTLP gRPC. No batch snapshot creation, no cloud dependency.

```
Forwarder EXPORTERS
  --> OTLP/gRPC :4317
    --> intake-api OtlpReceiver
      --> OtlpBuffer (per-service, 60s tumbling windows)
        --> [window closes]
          --> write temp .json files
          --> analyzeSnapshot()     (signal detection)
          --> correlateSignals()    (incident grouping)
          --> interpretAndFile()    (findings generation)
          --> archiveFile()         (S3/Spaces upload)
          --> cleanup temp dir
```

### How traffic gets in

The Speedscale forwarder's `EXPORTERS` env var is a JSON map enabling multi-destination fan-out with per-exporter DLP and filtering. Each exporter gets a clone of every RRPair. Agent Factory is just another entry:

```json
{
  "agent_factory": {
    "otel_endpoint": "http://agent-factory-intake-api.agent-factory.svc.cluster.local:4317",
    "dlp_config_id": "standard",
    "filter_rule": "standard"
  }
}
```

The forwarder encodes each RRPair as: `RRPair -> protojson -> map[string]any -> OTLP MapValue`. The converter in `src/lib/otlp-converter.ts` reverses this back to flat JSON objects.

### OTLP receiver

`src/lib/otlp-receiver.ts` — gRPC server implementing `LogsService/Export` using `@grpc/grpc-js` + `@grpc/proto-loader`. Vendored proto files in `src/protos/` from opentelemetry-proto v1.3.2.

The receiver walks `resourceLogs[].scopeLogs[].logRecords[]`, calls `extractRecords()` to parse each record, and pushes to the buffer. Individual record parse errors are logged and skipped without failing the RPC.

### Buffer and windows

`src/lib/otlp-buffer.ts` — per-service tumbling window buffer. Each service gets an independent buffer that accumulates records for `windowMs` (default 60s). On timer tick:

1. All non-empty windows are closed and returned as `WindowContents[]`
2. Each closed window is processed asynchronously (never blocks the receiver or next tick)
3. High-water mark (default 10k records/service) drops oldest records on overflow

### Signal detection

`src/lib/rrpair-stats.ts` — groups HTTP records by `direction:host:method:pathPattern` and SQL records by `host:operation:queryPattern`. Emits typed `Signal` objects:

| Signal kind | What it detects |
|---|---|
| `errors` | Endpoints with high non-2xx rates |
| `slow-endpoint` | Latency exceeding baseline or static threshold |
| `slow-query` | Database queries exceeding latency threshold |
| `n-plus-one` | Repeated identical queries within a request group |
| `high-freq-query` | Queries called disproportionately often |

### Baseline store

`src/lib/baseline-store.ts` — persists per-endpoint rolling stats as NDJSON at `<baselineDir>/<service>.ndjson`. When >= 7 sample windows exist for an endpoint, the slow-endpoint threshold becomes 2x baseline p95 (with 500ms floor) instead of the static 1000ms.

**Known gap**: the streaming path reads baselines but does not write back to them. `BaselineStore.append()` exists but `processClosedWindow` never calls it. This is the #1 priority fix — without it, every window runs against an empty baseline.

### Correlation

`src/lib/signal-correlator.ts` — merges related signals. Example: a `slow-endpoint` on `GET /api/accounts` paired with a `slow-query` on the downstream database call becomes a single `incident` signal.

### Findings archive

`src/lib/otlp-window-processor.ts` writes a JSON findings file containing: source metadata, window timestamps, RRPair count, all detected signals with evidence, and the scan result. Uploaded to S3-compatible storage via `src/lib/snapshot-archive.ts`.

Archive destination configured by env vars: `AF_TRAFFIC_ARCHIVE_BUCKET`, `AF_TRAFFIC_ARCHIVE_ENDPOINT`, `AF_TRAFFIC_ARCHIVE_ACCESS_KEY_ID`, `AF_TRAFFIC_ARCHIVE_SECRET_ACCESS_KEY` (the legacy `RADAR_ARCHIVE_*` names are still read as a fallback). Findings and evidence land under the `agent-factory/` key prefix.

---

## Processes

### intake-api

- HTTP server on `:8080` — run CRUD, metrics, healthz
- OTLP gRPC server on `:4317` (when `OTLP_RECEIVER_ENABLED=true`)
- Run queue management (filesystem or Redis backend)
- Prometheus metrics on `GET /metrics`
- Graceful shutdown: stops timer, flushes remaining windows, force-shuts gRPC server

### worker

- Long-running process polling the run queue
- Claims and executes `AgentRun` jobs
- Agent kinds: triage, bug-fix, perf-investigation, coverage-fill, pr-replay-check
- Per-run claim file prevents double execution

### controller (dead code)

The CRD-based k8s controller (`src/lib/controller/`, `src/bin/controller.ts`) is leftover from an earlier architecture. It watches `AgentRun` CRDs and dispatches to agents. This was superseded by the Redis queue + worker model. Pending removal — see `docs/plan.md`.

---

## Deployment

Single Helm chart at `charts/agent-factory/`. Deploys intake-api + worker as Deployments with a shared PVC.

Key chart values:

```yaml
intakeApi:
  otlp:
    enabled: true          # turn on OTLP receiver
    port: 4317
    windowMs: 60000        # tumbling window duration
    maxRecordsPerService: 10000
    archiveSecret:
      name: agent-factory-archive-s3  # k8s secret with S3 credentials
```

### Current staging

- **Cluster**: `do-nyc1-staging-decoy`
- **Namespace**: `agent-factory`
- **Image**: `ghcr.io/speedscale/agent-factory:v0.1.80`
- **Archive**: `do-nyc1-staging-decoy-radar` (DO Spaces nyc3, 3-day lifecycle)
- **Forwarder**: v2.5.617, EXPORTERS includes `agent_factory` pointing at intake-api:4317

---

## Contracts

### Signal

Output of `analyzeSnapshot()`. Typed object with:
- `kind` — errors, slow-endpoint, slow-query, n-plus-one, high-freq-query, incident
- `severity` — low, medium, high
- `fingerprint` — stable hash for dedup across windows
- `title` — human-readable summary
- `details` — description with numbers
- `evidence` — host, pattern, count, error rate, latency percentiles, example file paths

### WindowContents

Output of `OtlpBuffer.closeWindows()`:
- `service` — service name from OTLP log record attributes
- `records` — array of parsed RRPair JSON objects
- `windowStart` / `windowEnd` — ISO timestamps
- `droppedCount` — records dropped due to high-water mark

### Findings JSON (archived)

```json
{
  "source": "otlp-stream",
  "service": "banking-frontend",
  "windowStart": "2026-06-08T20:23:45.707Z",
  "windowEnd": "2026-06-08T20:24:44.407Z",
  "rrpairCount": 164,
  "droppedCount": 0,
  "stats": { "signals": [...], "endpointStats": [...] },
  "scanResult": { "hypotheses": [...] }
}
```
