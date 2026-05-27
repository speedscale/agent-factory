import { test } from "node:test";
import assert from "node:assert/strict";
import { correlateSignals } from "./signal-correlator.js";
import { type Signal } from "./rrpair-stats.js";

function makeSignal(overrides: Partial<Signal> & { kind: Signal["kind"]; severity: Signal["severity"] }): Signal {
  return {
    fingerprint: Math.random().toString(16).slice(2, 10),
    title: "test signal",
    details: "details",
    evidence: {
      host: "localhost",
      pattern: "GET /api/test",
      count: 10,
      examples: [],
    },
    ...overrides,
  };
}

test("unrelated signals pass through unchanged", () => {
  const n1 = makeSignal({
    kind: "n+1", severity: "high",
    evidence: { host: "gmail.googleapis.com", pattern: "GET:/gmail/v1/{id}", count: 419, examples: [] },
  });
  const err = makeSignal({
    kind: "errors", severity: "high",
    evidence: { host: "localhost", pattern: "GET:/api/today/candidates", count: 1, examples: [] },
  });
  const result = correlateSignals([n1, err]);
  assert.equal(result.length, 2);
  assert.ok(result.some((s) => s.kind === "n+1"));
  assert.ok(result.some((s) => s.kind === "errors"));
});

test("slow-endpoint + slow-query with correlated latency → incident", () => {
  const ep = makeSignal({
    kind: "slow-endpoint", severity: "high",
    fingerprint: "ep000001",
    title: "Slow endpoint: GET /api/accounts p95=5000ms",
    evidence: {
      host: "localhost", pattern: "GET:/api/accounts", count: 42, examples: [],
      latency: { p50: 1000, p95: 5000, p99: 6000, max: 7000 },
    },
  });
  const sq = makeSignal({
    kind: "slow-query", severity: "medium",
    fingerprint: "sq000001",
    title: "Slow query: max=3000ms",
    evidence: {
      host: "postgres", pattern: "SELECT * FROM accounts WHERE id = $1", count: 42, examples: [],
      latency: { p50: 500, p95: 2000, p99: 2500, max: 3000 },
    },
  });

  const result = correlateSignals([ep, sq]);
  // Should be 1 incident (merged)
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "incident");
  assert.equal(result[0].severity, "high"); // highest severity wins
  // Should have components
  const incident = result[0] as Signal & { components: Signal[] };
  assert.ok(Array.isArray(incident.components));
  assert.equal(incident.components.length, 2);
});

test("slow-endpoint + slow-query with unrelated latency → not merged", () => {
  const ep = makeSignal({
    kind: "slow-endpoint", severity: "high",
    evidence: {
      host: "localhost", pattern: "GET:/api/accounts", count: 42, examples: [],
      latency: { p50: 100, p95: 5000, p99: 6000, max: 7000 },
    },
  });
  const sq = makeSignal({
    kind: "slow-query", severity: "medium",
    evidence: {
      host: "postgres", pattern: "SELECT * FROM users WHERE id = $1", count: 5, examples: [],
      // max=50ms — much lower than endpoint p95=5000ms, below 30% threshold
      latency: { p50: 20, p95: 40, p99: 50, max: 50 },
    },
  });

  const result = correlateSignals([ep, sq]);
  assert.equal(result.length, 2, "should not merge when latencies are unrelated");
  assert.ok(!result.some((s) => s.kind === "incident"));
});

test("two slow-query signals on same table → incident", () => {
  const q1 = makeSignal({
    kind: "slow-query", severity: "medium",
    fingerprint: "tbl00001",
    evidence: {
      host: "postgres", pattern: "SELECT id FROM touches WHERE accountId = $1", count: 10, examples: [],
      latency: { p50: 200, p95: 500, p99: 600, max: 700 },
    },
  });
  const q2 = makeSignal({
    kind: "slow-query", severity: "medium",
    fingerprint: "tbl00002",
    evidence: {
      host: "postgres", pattern: "SELECT MAX(date) FROM touches WHERE accountId = ANY($1)", count: 5, examples: [],
      latency: { p50: 300, p95: 600, p99: 700, max: 800 },
    },
  });

  const result = correlateSignals([q1, q2]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "incident");
  const incident = result[0] as Signal & { components: Signal[] };
  assert.equal(incident.components.length, 2);
});

test("single slow-query — not merged with itself", () => {
  const q = makeSignal({
    kind: "slow-query", severity: "medium",
    evidence: {
      host: "postgres", pattern: "SELECT * FROM accounts WHERE id = $1", count: 5, examples: [],
      latency: { p50: 200, p95: 500, p99: 600, max: 700 },
    },
  });

  const result = correlateSignals([q]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "slow-query", "single query should not be wrapped in incident");
});

test("incident fingerprint is stable (same components → same fp)", () => {
  const ep = makeSignal({
    kind: "slow-endpoint", severity: "high",
    fingerprint: "aabbccdd",
    evidence: {
      host: "localhost", pattern: "GET:/api/accounts", count: 10, examples: [],
      latency: { p50: 1000, p95: 4000, p99: 5000, max: 6000 },
    },
  });
  const sq = makeSignal({
    kind: "slow-query", severity: "medium",
    fingerprint: "11223344",
    evidence: {
      host: "postgres", pattern: "SELECT * FROM accounts WHERE id = $1", count: 10, examples: [],
      latency: { p50: 500, p95: 2000, p99: 3000, max: 3500 },
    },
  });

  const r1 = correlateSignals([ep, sq]);
  const r2 = correlateSignals([sq, ep]); // order reversed
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
  assert.equal(r1[0].fingerprint, r2[0].fingerprint, "fingerprint should be order-independent");
});

test("empty input returns empty output", () => {
  const result = correlateSignals([]);
  assert.equal(result.length, 0);
});
