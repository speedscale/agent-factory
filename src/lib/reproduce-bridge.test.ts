import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import {
  isRegression,
  isReproducibleSignal,
  enqueueReproduceRun,
} from "./reproduce-bridge.js";
import type { Signal } from "./rrpair-stats.js";
import type { BaselineStore, EndpointBaseline } from "./baseline-store.js";
import { resolveFromRepo } from "./io.js";

// ── Minimal BaselineStore stub — isReproducibleSignal only calls these two ──
function stubBaseline(opts: {
  baselines?: Record<string, EndpointBaseline>;
  suppressed?: Set<string>;
} = {}): BaselineStore {
  return {
    getBaseline: (key: string) => opts.baselines?.[key] ?? null,
    isSuppressed: (fp: string) => opts.suppressed?.has(fp) ?? false,
  } as unknown as BaselineStore;
}

function slowEndpointSignal(over: Partial<Signal> = {}): Signal {
  return {
    kind: "slow-endpoint",
    severity: "high",
    fingerprint: "fp-slow",
    title: "Slow endpoint: GET /api/x p95=4000ms",
    details: "",
    evidence: { host: "h", pattern: "GET:/api/x", count: 50, latency: { p50: 100, p95: 4000, p99: 5000, max: 6000 }, examples: [] },
    ...over,
  };
}

function errorSignal(errorRate: number, severity: Signal["severity"] = "high"): Signal {
  return {
    kind: "errors",
    severity,
    fingerprint: "fp-err",
    title: "Errors: GET /api/sync",
    details: "",
    evidence: { host: "h", pattern: "GET:/api/sync", count: 100, errorRate, examples: [] },
  };
}

test("isRegression: slow-endpoint with baseline snapshot is a regression", () => {
  const s = slowEndpointSignal({ evidence: { host: "h", pattern: "GET:/api/x", count: 50, latency: { p50: 100, p95: 4000, p99: 5000, max: 6000 }, examples: [], baseline: { p95: 800, sampleWindows: 10 } } });
  assert.equal(isRegression(s, stubBaseline()), true);
});

test("isRegression: slow-endpoint without baseline snapshot is NOT a regression", () => {
  // Static detection fired (always-slow endpoint) — no evidence.baseline.
  assert.equal(isRegression(slowEndpointSignal(), stubBaseline()), false);
});

test("isRegression: error rate doubling over a healthy baseline is a regression", () => {
  const bl = stubBaseline({ baselines: { "GET /api/sync": { p95: 100, p50: 50, errorRate: 0.01, sampleWindows: 10 } } });
  assert.equal(isRegression(errorSignal(0.2), bl), true);
});

test("isRegression: error rate matching its baseline is NOT a regression", () => {
  const bl = stubBaseline({ baselines: { "GET /api/sync": { p95: 100, p50: 50, errorRate: 0.2, sampleWindows: 10 } } });
  assert.equal(isRegression(errorSignal(0.2), bl), false);
});

test("isRegression: errors with no baseline history is NOT a regression", () => {
  assert.equal(isRegression(errorSignal(0.5), stubBaseline()), false);
});

test("isReproducibleSignal: medium severity is filtered out by default", () => {
  const s = slowEndpointSignal({ severity: "medium", evidence: { host: "h", pattern: "GET:/api/x", count: 50, examples: [], baseline: { p95: 800, sampleWindows: 10 } } });
  assert.equal(isReproducibleSignal(s, stubBaseline()), false);
});

test("isReproducibleSignal: suppressed fingerprint is filtered out", () => {
  const s = slowEndpointSignal({ evidence: { host: "h", pattern: "GET:/api/x", count: 50, examples: [], baseline: { p95: 800, sampleWindows: 10 } } });
  const bl = stubBaseline({ suppressed: new Set(["fp-slow"]) });
  assert.equal(isReproducibleSignal(s, bl), false);
});

test("isReproducibleSignal: high-severity regression qualifies", () => {
  const s = slowEndpointSignal({ evidence: { host: "h", pattern: "GET:/api/x", count: 50, examples: [], baseline: { p95: 800, sampleWindows: 10 } } });
  assert.equal(isReproducibleSignal(s, stubBaseline()), true);
});

test("enqueueReproduceRun writes a valid queued reproduce run.json", async () => {
  const ts = "20260608T000000Ztest";
  const signal = slowEndpointSignal();
  let runName = "";
  try {
    runName = await enqueueReproduceRun({
      service: "radar",
      signal,
      evidence: { fingerprint: signal.fingerprint, fileCount: 2, key: "k/abc.tgz", uri: "s3://b/k/abc.tgz" },
      windowStart: "2026-06-08T00:00:00Z",
      windowEnd: "2026-06-08T00:01:00Z",
      ts,
    });

    const run = JSON.parse(await readFile(resolveFromRepo("artifacts", runName, "run.json"), "utf8"));
    assert.equal(run.spec.agent, "reproduce");
    assert.equal(run.status.phase, "queued");
    assert.equal(run.spec.appRef.name, "radar");
    assert.equal(run.spec.input.fingerprint, "fp-slow");
    assert.equal(run.spec.input.evidenceKey, "k/abc.tgz");
    assert.equal(run.spec.input.evidenceFileCount, 2);
    assert.equal(run.spec.issue.id, "fp-slow");
  } finally {
    if (runName) await rm(resolveFromRepo("artifacts", runName), { recursive: true, force: true });
  }
});
