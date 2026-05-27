import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BaselineStore, buildWindowStats } from "./baseline-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "af-baseline-test-"));
}

test("getBaseline returns null when no data loaded", async () => {
  const dir = await makeTempDir();
  const store = new BaselineStore(dir);
  await store.load("radar");
  assert.equal(store.getBaseline("GET /api/accounts"), null);
});

test("getBaseline returns null when fewer than 7 sample windows", async () => {
  const dir = await makeTempDir();
  const store = new BaselineStore(dir);

  // Append 6 windows (below MIN_WINDOWS_FOR_RELATIVE)
  for (let i = 0; i < 6; i++) {
    await store.append("radar", [{
      ts: new Date(Date.now() - i * 3_600_000).toISOString(),
      service: "radar",
      endpoint: "GET /api/accounts",
      p50: 100, p95: 300, p99: 400,
      count: 10, errorRate: 0,
    }]);
  }

  // Reload to pick up the appended data
  const store2 = new BaselineStore(dir);
  await store2.load("radar");
  assert.equal(store2.getBaseline("GET /api/accounts"), null, "should be null with only 6 windows");
});

test("getBaseline returns stats after 7+ sample windows", async () => {
  const dir = await makeTempDir();
  const store = new BaselineStore(dir);

  // Append 10 windows with consistent p95=300ms
  for (let i = 0; i < 10; i++) {
    await store.append("radar", [{
      ts: new Date(Date.now() - i * 3_600_000).toISOString(),
      service: "radar",
      endpoint: "GET /api/accounts",
      p50: 100, p95: 300, p99: 400,
      count: 10, errorRate: 0,
    }]);
  }

  const store2 = new BaselineStore(dir);
  await store2.load("radar");
  const bl = store2.getBaseline("GET /api/accounts");
  assert.ok(bl !== null, "should have baseline with 10 windows");
  assert.equal(bl!.p95, 300);
  assert.equal(bl!.sampleWindows, 10);
});

test("isSuppressed returns false by default", async () => {
  const dir = await makeTempDir();
  const store = new BaselineStore(dir);
  await store.load("radar");
  assert.equal(store.isSuppressed("deadbeef"), false);
});

test("addSuppress + reload → isSuppressed returns true", async () => {
  const dir = await makeTempDir();
  const store = new BaselineStore(dir);
  await store.load("radar");
  await store.addSuppress("deadbeef");

  const store2 = new BaselineStore(dir);
  await store2.load("radar");
  assert.equal(store2.isSuppressed("deadbeef"), true);
  assert.equal(store2.isSuppressed("cafebabe"), false);
});

test("buildWindowStats produces correct records from endpoint arrays", () => {
  const ts = "2026-05-27T00:00:00Z";
  const records = buildWindowStats(
    "radar", ts,
    [{ key: "GET /api/accounts", p50: 100, p95: 300, p99: 400, count: 42, errorRate: 0.02 }],
    [{ key: "SELECT * FROM accounts WHERE id = $1", p50: 5, p95: 50, p99: 100, count: 200 }],
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].endpoint, "GET /api/accounts");
  assert.equal(records[0].p95, 300);
  assert.equal(records[0].errorRate, 0.02);
  assert.equal(records[1].endpoint, "sql:SELECT * FROM accounts WHERE id = $1");
  assert.equal(records[1].count, 200);
});

test("median baseline is computed correctly across varying windows", async () => {
  const dir = await makeTempDir();
  const store = new BaselineStore(dir);

  // 7 windows: p95 values are [100, 200, 300, 400, 500, 600, 700] → median = 400
  const p95Values = [100, 200, 300, 400, 500, 600, 700];
  for (const p95 of p95Values) {
    await store.append("radar", [{
      ts: new Date().toISOString(),
      service: "radar",
      endpoint: "POST /api/content/ideate/chat",
      p50: 50, p95, p99: p95 + 100,
      count: 5, errorRate: 0,
    }]);
  }

  const store2 = new BaselineStore(dir);
  await store2.load("radar");
  const bl = store2.getBaseline("POST /api/content/ideate/chat");
  assert.ok(bl !== null);
  assert.equal(bl!.p95, 400, "median of [100..700] should be 400");
  assert.equal(bl!.sampleWindows, 7);
});
