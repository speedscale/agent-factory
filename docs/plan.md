# Roadmap

Audience: Agent Factory developers and contributors.

## Goal

Ship the detect/confirm/replicate loop: Agent Factory continuously monitors production traffic, detects regressions against baselines, replays the failing traffic to confirm bugs are real, and files tickets with the evidence. No other tool can do this because nobody else has the full request/response data AND an AI agent.

## Current state (2026-06-08)

The OTLP streaming pipeline is live on staging (`do-nyc1-staging-decoy`). Six services are streaming traffic through the forwarder into intake-api. Signal detection and findings archival work end-to-end.

**The detect → confirm → replicate loop is now wired end-to-end** (P0 below, all four items landed). `processClosedWindow` accumulates baselines, archives the failing RRPairs per signal, and bridges high-severity regressions to `reproduce` AgentRuns; the worker's reproduce handler fetches the evidence, replays it, confirms the signal reappears, and files a ticket. What remains for production is exercising it against live infrastructure (set `REPRODUCE_REPLAY_TARGET`, `LINEAR_API_KEY`, `LINEAR_REPRODUCE_TEAM_ID`) and tuning thresholds.

---

## P0: Close the loop — ✅ DONE

### 1 — Baseline accumulation ✅

`processClosedWindow` now loads the service baseline before analysis (so relative regression detection fires) and calls `baseline.append()` with every window's endpoint stats afterward — including clean windows, since clean windows are the baseline.

Files: `src/lib/otlp-window-processor.ts`, `src/lib/baseline-store.ts`

### 2 — Archive raw traffic for replay ✅

Before the `finally` block deletes the temp dir, each signal's example RRPairs are tarred and uploaded to S3 keyed by signal fingerprint (`radar-monitor/stream-evidence/<service>/<fingerprint>-<ts>.tgz`). The tarball mirrors the snapshot's host-subdir layout so `proxymock replay` consumes it directly.

Files: `src/lib/evidence-archive.ts`, `src/lib/otlp-window-processor.ts`

### 3 — Signal to AgentRun bridge ✅

When a signal is high-severity AND a regression (relative-latency detection fired, or error rate climbed materially above its baseline) and is not suppressed, a `reproduce` AgentRun is enqueued carrying the signal, its archived evidence location, service, and window bounds. A dedup guard skips fingerprints that already have a live reproduce run.

Files: `src/lib/reproduce-bridge.ts`, `src/lib/otlp-window-processor.ts`, `src/contracts/agent-kind.ts`

### 4 — Reproduce worker handler ✅

Worker handler for `spec.agent: "reproduce"`:

1. Fetch archived traffic from S3 (`fetchArchive`)
2. Extract it locally
3. Replay the failing requests via `proxymock replay --test-against $REPRODUCE_REPLAY_TARGET` (degrades to re-analysing the capture when no target is set)
4. Run `analyzeSnapshot` on the result
5. Confirm the bug is real if the original signal reappears
6. File a Linear ticket (via `createIssue`) with signal description, evidence URI, and replay confirmation

External calls (S3, proxymock, Linear) are dependency-injected so the orchestration is unit-tested without live infra.

Files: `src/lib/reproduce-worker.ts`, `src/lib/snapshot-archive.ts` (`fetchArchive`), `src/lib/linear-client.ts` (`createIssue`), `src/bin/worker.ts`

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
