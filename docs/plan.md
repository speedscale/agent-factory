# Roadmap

Audience: Agent Factory developers and contributors.

## Goal

Ship the detect/confirm/replicate loop: Agent Factory continuously monitors production traffic, detects regressions against baselines, replays the failing traffic to confirm bugs are real, and files tickets with the evidence. No other tool can do this because nobody else has the full request/response data AND an AI agent.

## Current state (2026-06-08)

The OTLP streaming pipeline is live on staging (`do-nyc1-staging-decoy`). Six services are streaming traffic through the forwarder into intake-api. Signal detection and findings archival work end-to-end. The pipeline stops at S3 upload — nothing downstream reads the findings or acts on them.

---

## P0: Close the loop

### 1 — Baseline accumulation

The baseline store reads but never writes. `processClosedWindow` must call `baseline.append()` with the current window's endpoint stats after analysis. Without this, regression detection is impossible — every window runs against an empty or stale baseline.

Files: `src/lib/otlp-window-processor.ts`, `src/lib/baseline-store.ts`

### 2 — Archive raw traffic for replay

The `finally` block in `processClosedWindow` deletes the temp dir containing the actual RRPairs. For replay to work, the failing requests must survive. Archive the records that triggered signals (not all records — just the evidence) to S3 alongside the findings JSON, keyed by signal fingerprint.

Files: `src/lib/otlp-window-processor.ts`

### 3 — Signal to AgentRun bridge

When a signal crosses a severity threshold AND represents a regression (not present in prior baseline), enqueue an AgentRun with a new `reproduce` mode. The run carries: signal fingerprint, archived traffic path, service name, evidence.

Files: `src/lib/otlp-window-processor.ts`, `src/lib/run-store.ts`

### 4 — Reproduce worker handler

New worker handler for `mode: "reproduce"`:

1. Fetch archived traffic from S3
2. Start proxymock mock for downstream deps
3. Replay the failing requests via `proxymock replay`
4. Run `analyzeSnapshot` on the replay output
5. If the signal reproduces, confirm the bug is real
6. File a Linear ticket with: signal description, traffic evidence, replay confirmation

Files: new handler in worker, `src/lib/traffic-worker.ts`

---

## P1: Clean house

### Dead code removal

~14 files from the CRD-era controller architecture and prior refactors:

| Category | Files |
|---|---|
| CRD controller | `src/lib/controller/` (5 files), `src/lib/k8s-runs.ts`, `src/lib/k8s-worker-job.ts` |
| Orphaned tests | `src/lib/traffic-fingerprint.test.ts`, `src/lib/engine-tools.test.ts` |
| Dead bins | `src/bin/archive-snapshot.ts`, `src/bin/traffic-scan.ts` |
| Shadowed module | `src/lib/traffic/` (3 files) |

### Grafana dashboard

The OTLP streaming metrics exist in Prometheus format but there's no dashboard. Build one using the existing `dashboards.enabled` chart flag:

- Records received rate by service
- Windows processed rate by service
- Signals found rate by service (the money metric)
- Buffer depth per service
- Export RPC rate and error rate
- Worker activity (existing metrics)

---

## P2: Productize

### LLM interpretation

Flip `noLLM: false` in the streaming path so `interpretAndFile` uses the LLM to correlate signals, generate hypotheses, and produce human-readable findings. Gate behind a feature flag — LLM calls are expensive per window.

### Suppress list management

The baseline store supports a `.suppress` file for known false-positive fingerprints. Surface this in the intake-api as `POST /suppress` so operators can mute noisy signals without redeploying.

### Multi-cluster federation

Agent Factory runs per-cluster today. For customers with multiple clusters, federate findings by pushing to a shared archive bucket and deduplicating by signal fingerprint + service + cluster.

---

## Deferred

- Review UI (React SPA) — show findings, run status, approve PRs
- `validate_candidate` proxymock MCP tool — orchestrates build/mock/replay/diff in one call
- Load mode on `replay_traffic` — load testing in Validate phase
- Cross-deploy filtering — correlate signals with deploy events
- Multi-repo app support
