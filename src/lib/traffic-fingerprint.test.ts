import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { computeFingerprint, findBursts, percentile } from "./traffic/fingerprint.js";
import type { RRPair } from "./traffic/types.js";

const frozenNow = () => new Date("2026-05-21T15:00:00.000Z");

function rr(
  id: string,
  method: string,
  path: string,
  status: number,
  latencyMs: number,
  occurredAt: string,
): RRPair {
  return { id, method, path, status, latencyMs, occurredAt };
}

describe("percentile (nearest-rank)", () => {
  it("returns 0 for empty input", () => {
    assert.equal(percentile([], 0.5), 0);
  });
  it("returns the only value for length 1", () => {
    assert.equal(percentile([42], 0.99), 42);
  });
  it("p50 of [10,20,30,40,50] is 30 (nearest-rank)", () => {
    assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  });
  it("p99 of 100 evenly-spaced values is the 99th", () => {
    const vs = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(vs, 0.99), 99);
  });
  it("p100 is the max element", () => {
    assert.equal(percentile([1, 2, 3], 1.0), 3);
  });
});

describe("findBursts", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(findBursts([], 1000, 3, 2), []);
  });
  it("returns [] when no window reaches minPeak", () => {
    // 3 requests spaced 2s apart, 1s window
    const ts = [0, 2000, 4000];
    assert.deepEqual(findBursts(ts, 1000, 3, 2), []);
  });
  it("detects a single burst", () => {
    const ts = [0, 100, 200, 300, 5000];  // 4 in 1s window starting at 0
    const bursts = findBursts(ts, 1000, 3, 2);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].peakRequestCount, 4);
    assert.equal(bursts[0].windowMs, 1000);
  });
  it("dedups overlapping windows", () => {
    // 5 requests within 500ms — many overlapping windows would have peak 5
    const ts = [0, 100, 200, 300, 400];
    const bursts = findBursts(ts, 1000, 5, 2);
    assert.equal(bursts.length, 1, "overlapping windows should collapse");
    assert.equal(bursts[0].peakRequestCount, 5);
  });
  it("returns top-N bursts across non-overlapping windows", () => {
    // Two clusters separated by > windowMs
    const ts = [0, 100, 200, 10_000, 10_100, 10_200, 10_300];
    const bursts = findBursts(ts, 1000, 3, 2);
    assert.equal(bursts.length, 2);
    assert.equal(bursts[0].peakRequestCount, 4);  // second cluster wins
    assert.equal(bursts[1].peakRequestCount, 3);
  });
});

describe("computeFingerprint", () => {
  it("handles empty input", () => {
    const fp = computeFingerprint([], { sliceName: "empty", now: frozenNow });
    assert.equal(fp.spec.sampleCount, 0);
    assert.equal(fp.spec.overallErrorRate, 0);
    assert.deepEqual(fp.spec.endpoints, []);
    assert.equal(fp.spec.sliceRef.name, "empty");
    assert.equal(fp.spec.generatedAt, "2026-05-21T15:00:00.000Z");
  });

  it("groups by (method, path) and produces one endpoint per group", () => {
    const fp = computeFingerprint(
      [
        rr("a", "GET", "/api/x", 200, 10, "2026-05-21T15:00:00Z"),
        rr("b", "GET", "/api/x", 200, 20, "2026-05-21T15:00:01Z"),
        rr("c", "POST", "/api/y", 200, 30, "2026-05-21T15:00:02Z"),
      ],
      { sliceName: "s", now: frozenNow },
    );
    assert.equal(fp.spec.endpoints.length, 2);
    const xs = fp.spec.endpoints.find((e) => e.path === "/api/x");
    assert.ok(xs);
    assert.equal(xs.method, "GET");
    assert.equal(xs.requestCount, 2);
  });

  it("computes per-endpoint errorRate and statusBreakdown", () => {
    const fp = computeFingerprint(
      [
        rr("1", "GET", "/x", 200, 10, "2026-05-21T15:00:00Z"),
        rr("2", "GET", "/x", 200, 10, "2026-05-21T15:00:01Z"),
        rr("3", "GET", "/x", 500, 10, "2026-05-21T15:00:02Z"),
        rr("4", "GET", "/x", 429, 10, "2026-05-21T15:00:03Z"),
      ],
      { sliceName: "s", now: frozenNow },
    );
    const x = fp.spec.endpoints[0];
    assert.equal(x.errorRate, 0.5);
    assert.deepEqual(x.statusBreakdown, { "200": 2, "500": 1, "429": 1 });
  });

  it("sorts endpoints by requestCount descending", () => {
    const fp = computeFingerprint(
      [
        rr("1", "GET", "/rare", 200, 10, "2026-05-21T15:00:00Z"),
        rr("2", "GET", "/common", 200, 10, "2026-05-21T15:00:01Z"),
        rr("3", "GET", "/common", 200, 10, "2026-05-21T15:00:02Z"),
        rr("4", "GET", "/common", 200, 10, "2026-05-21T15:00:03Z"),
      ],
      { sliceName: "s", now: frozenNow },
    );
    assert.equal(fp.spec.endpoints[0].path, "/common");
    assert.equal(fp.spec.endpoints[1].path, "/rare");
  });

  it("computes latency percentiles per endpoint", () => {
    const rrpairs = Array.from({ length: 100 }, (_, i) =>
      rr(`x${i}`, "GET", "/x", 200, i + 1, `2026-05-21T15:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    const fp = computeFingerprint(rrpairs, { sliceName: "s", now: frozenNow });
    const x = fp.spec.endpoints[0];
    assert.equal(x.latency.p50Ms, 50);
    assert.equal(x.latency.p99Ms, 99);
    assert.equal(x.latency.maxMs, 100);
  });

  it("attaches burstPatterns when an endpoint has bursts above minPeak", () => {
    const rrpairs = [
      rr("1", "GET", "/x", 429, 10, "2026-05-21T15:00:00.000Z"),
      rr("2", "GET", "/x", 429, 10, "2026-05-21T15:00:00.100Z"),
      rr("3", "GET", "/x", 429, 10, "2026-05-21T15:00:00.200Z"),
      rr("4", "GET", "/x", 429, 10, "2026-05-21T15:00:00.300Z"),
    ];
    const fp = computeFingerprint(rrpairs, { sliceName: "s", now: frozenNow });
    const x = fp.spec.endpoints[0];
    assert.ok(x.burstPatterns);
    assert.equal(x.burstPatterns!.length, 1);
    assert.equal(x.burstPatterns![0].peakRequestCount, 4);
  });

  it("omits burstPatterns when no bursts qualify", () => {
    const rrpairs = [
      rr("1", "GET", "/x", 200, 10, "2026-05-21T15:00:00Z"),
      rr("2", "GET", "/x", 200, 10, "2026-05-21T15:00:05Z"),
    ];
    const fp = computeFingerprint(rrpairs, { sliceName: "s", now: frozenNow });
    assert.equal(fp.spec.endpoints[0].burstPatterns, undefined);
  });

  it("overallErrorRate aggregates across all endpoints", () => {
    const fp = computeFingerprint(
      [
        rr("1", "GET", "/a", 200, 10, "2026-05-21T15:00:00Z"),
        rr("2", "GET", "/a", 500, 10, "2026-05-21T15:00:01Z"),
        rr("3", "GET", "/b", 200, 10, "2026-05-21T15:00:02Z"),
        rr("4", "GET", "/b", 429, 10, "2026-05-21T15:00:03Z"),
      ],
      { sliceName: "s", now: frozenNow },
    );
    assert.equal(fp.spec.overallErrorRate, 0.5);
  });

  it("rounds errorRate to 4 decimal places", () => {
    const rrpairs = Array.from({ length: 7 }, (_, i) =>
      rr(`x${i}`, "GET", "/x", i === 0 ? 500 : 200, 10, `2026-05-21T15:00:0${i}Z`),
    );
    const fp = computeFingerprint(rrpairs, { sliceName: "s", now: frozenNow });
    // 1/7 = 0.142857... rounded to 0.1429
    assert.equal(fp.spec.endpoints[0].errorRate, 0.1429);
  });

  it("treats methods case-insensitively in grouping but uppercases on output", () => {
    const fp = computeFingerprint(
      [
        rr("1", "get", "/x", 200, 10, "2026-05-21T15:00:00Z"),
        rr("2", "GET", "/x", 200, 10, "2026-05-21T15:00:01Z"),
      ],
      { sliceName: "s", now: frozenNow },
    );
    assert.equal(fp.spec.endpoints.length, 1);
    assert.equal(fp.spec.endpoints[0].method, "GET");
    assert.equal(fp.spec.endpoints[0].requestCount, 2);
  });
});
