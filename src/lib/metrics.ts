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

// Phase names match `AgentRun.status.phase`. Kept as a const so the
// `runs_total` gauge labels can be enumerated up-front (Prometheus best
// practice: every label combination should be observable, not just the
// ones that happen to have non-zero values).
export const RUN_PHASES = [
  "queued",
  "planned",
  "building",
  "validating",
  "succeeded",
  "failed"
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

// ---------- intake-api registry ----------

export interface IntakeRegistry {
  registry: Registry;
  /** Gauge by phase. Recomputed on every scrape from listRuns(). */
  runsTotal: Gauge<"phase">;
  /** Gauge by queue backend. Recomputed on every scrape. */
  queueDepth: Gauge<"backend">;
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

  return {
    registry,
    loopsTotal,
    runsProcessedTotal,
    runClaimsSkippedTotal,
    staleRunsFailedTotal,
    queueDepth
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
