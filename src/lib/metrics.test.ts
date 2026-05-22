import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIntakeRegistry,
  createWorkerRegistry,
  renderPrometheusText,
  RUN_PHASES,
  PROMETHEUS_CONTENT_TYPE
} from "./metrics.js";

// ---------- shape / format ----------

test("intake registry renders Prometheus text with HELP + TYPE + samples", async () => {
  const reg = createIntakeRegistry("test-instance");
  const text = await renderPrometheusText(reg.registry);

  // Every metric must have HELP and TYPE lines.
  assert.match(text, /# HELP agent_factory_runs_total/);
  assert.match(text, /# TYPE agent_factory_runs_total gauge/);
  assert.match(text, /# HELP agent_factory_queue_depth/);
  assert.match(text, /# TYPE agent_factory_queue_depth gauge/);
});

test("instance label appears on every sample (intake)", async () => {
  const reg = createIntakeRegistry("minikube-local");
  reg.runsTotal.set({ phase: "queued" }, 3);
  reg.queueDepth.set({ backend: "filesystem" }, 1);

  const text = await renderPrometheusText(reg.registry);
  // No sample line should be missing the instance label.
  const sampleLines = text.split("\n").filter((l) => l && !l.startsWith("#"));
  for (const line of sampleLines) {
    assert.match(line, /instance="minikube-local"/, `sample missing instance label: ${line}`);
  }
});

test("every RUN_PHASE is pre-seeded to 0 (dashboards see all label combos)", async () => {
  const reg = createIntakeRegistry("x");
  const text = await renderPrometheusText(reg.registry);
  for (const phase of RUN_PHASES) {
    const pattern = new RegExp(
      `agent_factory_runs_total\\{phase="${phase}",instance="x"\\}\\s+0`
    );
    assert.match(text, pattern, `missing seeded zero for phase=${phase}`);
  }
});

test("worker registry exposes all counters + queue-depth gauge", async () => {
  const reg = createWorkerRegistry("ken-local");
  reg.loopsTotal.inc();
  reg.loopsTotal.inc();
  reg.runsProcessedTotal.inc({ result: "succeeded" });
  reg.runClaimsSkippedTotal.inc();
  reg.staleRunsFailedTotal.inc();
  reg.queueDepth.set({ backend: "filesystem" }, 7);

  const text = await renderPrometheusText(reg.registry);

  assert.match(text, /agent_factory_worker_loops_total\{instance="ken-local"\}\s+2/);
  assert.match(text, /agent_factory_worker_runs_processed_total\{result="succeeded",instance="ken-local"\}\s+1/);
  assert.match(text, /agent_factory_worker_run_claims_skipped_total\{instance="ken-local"\}\s+1/);
  assert.match(text, /agent_factory_worker_stale_runs_failed_total\{instance="ken-local"\}\s+1/);
  assert.match(text, /agent_factory_worker_queue_depth\{backend="filesystem",instance="ken-local"\}\s+7/);
});

// ---------- counter / gauge semantics ----------

test("counters increment cumulatively across multiple inc() calls", async () => {
  const reg = createWorkerRegistry("inst");
  for (let i = 0; i < 5; i++) reg.loopsTotal.inc();
  const text = await renderPrometheusText(reg.registry);
  assert.match(text, /agent_factory_worker_loops_total\{instance="inst"\}\s+5/);
});

test("gauges overwrite (latest set value wins)", async () => {
  const reg = createIntakeRegistry("inst");
  reg.queueDepth.set({ backend: "redis" }, 10);
  reg.queueDepth.set({ backend: "redis" }, 3);
  const text = await renderPrometheusText(reg.registry);
  assert.match(text, /agent_factory_queue_depth\{backend="redis",instance="inst"\}\s+3/);
});

test("gauges support multiple label combinations independently", async () => {
  const reg = createIntakeRegistry("inst");
  reg.runsTotal.set({ phase: "queued" }, 4);
  reg.runsTotal.set({ phase: "failed" }, 2);
  const text = await renderPrometheusText(reg.registry);
  assert.match(text, /agent_factory_runs_total\{phase="queued",instance="inst"\}\s+4/);
  assert.match(text, /agent_factory_runs_total\{phase="failed",instance="inst"\}\s+2/);
});

// ---------- registry isolation ----------

test("two registries with different instance labels don't collide", async () => {
  const a = createIntakeRegistry("instance-a");
  const b = createIntakeRegistry("instance-b");
  a.runsTotal.set({ phase: "queued" }, 1);
  b.runsTotal.set({ phase: "queued" }, 99);

  const textA = await renderPrometheusText(a.registry);
  const textB = await renderPrometheusText(b.registry);

  assert.match(textA, /agent_factory_runs_total\{phase="queued",instance="instance-a"\}\s+1/);
  assert.doesNotMatch(textA, /instance="instance-b"/);
  assert.match(textB, /agent_factory_runs_total\{phase="queued",instance="instance-b"\}\s+99/);
  assert.doesNotMatch(textB, /instance="instance-a"/);
});

test("intake + worker registries can coexist in the same process", async () => {
  const intake = createIntakeRegistry("inst");
  const worker = createWorkerRegistry("inst");
  intake.runsTotal.set({ phase: "queued" }, 1);
  worker.loopsTotal.inc();

  const intakeText = await renderPrometheusText(intake.registry);
  const workerText = await renderPrometheusText(worker.registry);

  assert.match(intakeText, /agent_factory_runs_total/);
  assert.doesNotMatch(intakeText, /agent_factory_worker_loops_total/);
  assert.match(workerText, /agent_factory_worker_loops_total/);
  assert.doesNotMatch(workerText, /agent_factory_runs_total/);
});

// ---------- content-type ----------

test("PROMETHEUS_CONTENT_TYPE matches the 0.0.4 exposition spec", () => {
  assert.equal(PROMETHEUS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
});

// ---------- structural well-formedness ----------

test("rendered text passes a generic structural check (HELP/TYPE before samples per metric)", async () => {
  const reg = createIntakeRegistry("inst");
  reg.runsTotal.set({ phase: "queued" }, 1);
  reg.queueDepth.set({ backend: "filesystem" }, 0);
  const text = await renderPrometheusText(reg.registry);

  // For each metric we expose, the HELP line should precede the first sample.
  const metricNames = ["agent_factory_runs_total", "agent_factory_queue_depth"];
  for (const name of metricNames) {
    const helpIdx = text.indexOf(`# HELP ${name}`);
    const sampleIdx = text.indexOf(`\n${name}{`);
    assert.ok(helpIdx >= 0, `missing HELP for ${name}`);
    assert.ok(sampleIdx >= 0, `missing sample for ${name}`);
    assert.ok(helpIdx < sampleIdx, `HELP must precede sample for ${name}`);
  }
});
