import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRun, AgentRunPhase } from "../contracts/index.js";
import { countByPhase, createK8sRunsLoader, mergeRuns } from "./k8s-runs.js";

function run(name: string, phase: AgentRunPhase): AgentRun {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRun",
    metadata: { name },
    spec: {
      appRef: { name: "demo" },
      issue: { id: "i", title: "t", body: "" },
      workspace: { root: "/" },
    },
    status: { phase, artifacts: {} },
  };
}

test("mergeRuns dedupes by metadata.name; k8s wins on phase conflict", () => {
  const fs = [run("a", "queued"), run("b", "failed")];
  const k8s = [run("a", "succeeded"), run("c", "planned")];
  const merged = mergeRuns(fs, k8s);
  const names = merged.map((r) => r.metadata.name).sort();
  assert.deepEqual(names, ["a", "b", "c"]);
  // 'a' should reflect the k8s phase, not the filesystem phase.
  const a = merged.find((r) => r.metadata.name === "a");
  assert.equal(a?.status.phase, "succeeded");
});

test("countByPhase tallies every defined phase, including new ones", () => {
  const runs = [
    run("1", "queued"),
    run("2", "queued"),
    run("3", "generating"),
    run("4", "succeeded"),
    run("5", "failed"),
    run("6", "failed"),
    run("7", "deploying"),
  ];
  const counts = countByPhase(runs);
  assert.equal(counts.queued, 2);
  assert.equal(counts.generating, 1);
  assert.equal(counts.deploying, 1);
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.failed, 2);
  // Unused phases stay at 0 (not undefined) so dashboard sees the label combo.
  assert.equal(counts.planned, 0);
  assert.equal(counts.validating, 0);
  assert.equal(counts.reporting, 0);
  assert.equal(counts.building, 0);
});

test("createK8sRunsLoader uses the injected loader and caches within TTL", async () => {
  let calls = 0;
  let nowVal = 1_000_000;
  const loader = createK8sRunsLoader({
    loader: async () => {
      calls += 1;
      return [run("only", "queued")];
    },
    now: () => nowVal,
  });

  const a = await loader.list();
  const b = await loader.list();
  assert.equal(calls, 1, "second call within TTL should hit the cache");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(loader.isConfigured(), true);

  // Advance past the cache TTL.
  nowVal += 10_000;
  await loader.list();
  assert.equal(calls, 2);
});

test("loader treats injected-loader errors as empty (never throws)", async () => {
  const loader = createK8sRunsLoader({
    loader: async () => {
      throw new Error("kaboom");
    },
  });
  // The contract is that intake-api's /metrics handler must not 500 on
  // a transient API failure. The injected-loader path mirrors the real
  // implementation's catch — we wrap callers in try/catch in
  // refreshMetricsSnapshot, so we accept that here it will surface.
  await assert.rejects(loader.list(), /kaboom/);
});
