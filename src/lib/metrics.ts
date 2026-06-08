/**
 * Prometheus metrics — text-format output for `/metrics` on every binary.
 *
 * The legacy `/metrics` endpoints returned bespoke JSON, which Prometheus
 * scrapers can't ingest. This module wires `prom-client` so the same data
 * goes out as proper exposition text (`# HELP foo` / `# TYPE foo gauge` /
 * `foo{label="x"} 42`).
 *
 * The original JSON output is preserved by callers behind a sibling
 * `/metrics.json` route so existing consumers don't break.
 *
 * One registry per process (intake-api, worker). The `instance` label is
 * applied as a default label on both registries so multi-deployment
 * dashboards can distinguish `minikube-local` from `k8s-staging` etc.
 */

import { Counter, Gauge, Registry } from "prom-client";

// Counter is imported for the worker registry below; the intake registry
// only needs Gauge today (per-request counters with bounded cardinality
// are tracked as a follow-up).

// Phase names match `AgentRun.status.phase` in src/contracts/agent-run.ts.
// Kept as a const so the `runs_total` gauge labels can be enumerated up-front
// (Prometheus best practice: every label combination should be observable,
// not just the ones that happen to have non-zero values).
//
// Keep in sync with AgentRunPhase. A run that lands in a phase missing from
// this list won't be counted on the dashboard.
export const RUN_PHASES = [
  "queued",
  "planned",
  "building",
  "scanning",
  "generating",
  "validating",
  "deploying",
  "reporting",
  "succeeded",
  "failed"
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

// Queue backends `agent_factory_queue_depth` may report against. Seeded at 0
// so the series exists from process start — previously the gauge had no
// samples until the first successful scrape, and any scrape that threw
// before reaching `queueDepth.set()` left Prometheus seeing nothing at all.
const QUEUE_BACKENDS = ["filesystem", "redis"] as const;

// ---------- intake-api registry ----------

export interface OtlpStreamingMetrics {
  recordsReceived: Counter<"service">;
  recordsDropped: Counter<"service">;
  windowsProcessed: Counter<"service">;
  signalsFound: Counter<"service">;
  bufferSize: Gauge<"service">;
  exportRequestsTotal: Counter<never>;
  exportErrorsTotal: Counter<never>;
}

export interface IntakeRegistry {
  registry: Registry;
  /** Gauge by phase. Recomputed on every scrape from listRuns(). */
  runsTotal: Gauge<"phase">;
  /** Gauge by queue backend. Recomputed on every scrape. */
  queueDepth: Gauge<"backend">;
  /** OTLP streaming metrics. Only populated when receiver is enabled. */
  otlp?: OtlpStreamingMetrics;
}

export function createIntakeRegistry(instance: string): IntakeRegistry {
  const registry = new Registry();
  registry.setDefaultLabels({ instance });

  const runsTotal = new Gauge({
    name: "agent_factory_runs_total",
    help: "Total runs grouped by lifecycle phase.",
    labelNames: ["phase"] as const,
    registers: [registry]
  });
  // Seed every phase at 0 so dashboards see all label combos even when
  // the system is idle.
  for (const phase of RUN_PHASES) {
    runsTotal.set({ phase }, 0);
  }

  const queueDepth = new Gauge({
    name: "agent_factory_queue_depth",
    help: "Pending runs in the queue, by backend.",
    labelNames: ["backend"] as const,
    registers: [registry]
  });
  // Seed every backend at 0 so the series exists from process start. The
  // gauge previously had no samples until refreshMetricsSnapshot() reached
  // `.set()` — any exception earlier in the snapshot path (e.g. queue
  // backend unreachable) left the series absent from Prometheus entirely.
  for (const backend of QUEUE_BACKENDS) {
    queueDepth.set({ backend }, 0);
  }

  return { registry, runsTotal, queueDepth };
}

// ---------- worker registry ----------

export interface WorkerRegistry {
  registry: Registry;
  loopsTotal: Counter<never>;
  runsProcessedTotal: Counter<"result">;
  runClaimsSkippedTotal: Counter<never>;
  staleRunsFailedTotal: Counter<never>;
  /** Gauge mirroring the worker's most-recently-observed queue depth. */
  queueDepth: Gauge<"backend">;
}

export function createWorkerRegistry(instance: string): WorkerRegistry {
  const registry = new Registry();
  registry.setDefaultLabels({ instance });

  const loopsTotal = new Counter({
    name: "agent_factory_worker_loops_total",
    help: "Worker queue-poll iterations since startup.",
    registers: [registry]
  });

  const runsProcessedTotal = new Counter({
    name: "agent_factory_worker_runs_processed_total",
    help: "Runs the worker processed, partitioned by terminal result.",
    labelNames: ["result"] as const,
    registers: [registry]
  });

  const runClaimsSkippedTotal = new Counter({
    name: "agent_factory_worker_run_claims_skipped_total",
    help: "Runs the worker saw queued but skipped because another worker held the claim file.",
    registers: [registry]
  });

  const staleRunsFailedTotal = new Counter({
    name: "agent_factory_worker_stale_runs_failed_total",
    help: "Active runs the worker forcibly failed because they exceeded max-active-phase-ms.",
    registers: [registry]
  });

  const queueDepth = new Gauge({
    name: "agent_factory_worker_queue_depth",
    help: "Most recently observed pending-run count from the worker's perspective.",
    labelNames: ["backend"] as const,
    registers: [registry]
  });
  for (const backend of QUEUE_BACKENDS) {
    queueDepth.set({ backend }, 0);
  }

  return {
    registry,
    loopsTotal,
    runsProcessedTotal,
    runClaimsSkippedTotal,
    staleRunsFailedTotal,
    queueDepth
  };
}

// ---------- OTLP streaming metrics (intake-api, optional) ----------

export function createOtlpMetrics(registry: Registry): OtlpStreamingMetrics {
  const recordsReceived = new Counter({
    name: "agent_factory_otlp_records_received_total",
    help: "RRPair log records received from forwarder OTLP export.",
    labelNames: ["service"] as const,
    registers: [registry],
  });

  const recordsDropped = new Counter({
    name: "agent_factory_otlp_records_dropped_total",
    help: "Records dropped due to per-service buffer high-water mark.",
    labelNames: ["service"] as const,
    registers: [registry],
  });

  const windowsProcessed = new Counter({
    name: "agent_factory_otlp_windows_processed_total",
    help: "Tumbling windows closed and processed for signal detection.",
    labelNames: ["service"] as const,
    registers: [registry],
  });

  const signalsFound = new Counter({
    name: "agent_factory_otlp_signals_found_total",
    help: "Traffic signals detected across all processed windows.",
    labelNames: ["service"] as const,
    registers: [registry],
  });

  const bufferSize = new Gauge({
    name: "agent_factory_otlp_buffer_size",
    help: "Current number of buffered records per service.",
    labelNames: ["service"] as const,
    registers: [registry],
  });

  const exportRequestsTotal = new Counter({
    name: "agent_factory_otlp_export_requests_total",
    help: "Total OTLP Export RPCs received.",
    registers: [registry],
  });

  const exportErrorsTotal = new Counter({
    name: "agent_factory_otlp_export_errors_total",
    help: "OTLP Export RPCs that encountered parse errors.",
    registers: [registry],
  });

  return {
    recordsReceived,
    recordsDropped,
    windowsProcessed,
    signalsFound,
    bufferSize,
    exportRequestsTotal,
    exportErrorsTotal,
  };
}

/**
 * Render a registry as Prometheus text. Thin wrapper so callers don't have
 * to import prom-client themselves.
 */
export async function renderPrometheusText(registry: Registry): Promise<string> {
  return registry.metrics();
}

/**
 * Content-type to set on the HTTP response when serving Prometheus text.
 * Prometheus 0.0.4 is the de-facto standard exposition format.
 */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
