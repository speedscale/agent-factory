import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Registry } from "prom-client";
import { processClosedWindow } from "./otlp-window-processor.js";
import { createOtlpMetrics } from "./metrics.js";
import type { WindowContents } from "./otlp-buffer.js";

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function httpRecord(url: string, statusCode: number, duration: number): Record<string, unknown> {
  return {
    l7protocol: "http",
    direction: "IN",
    duration,
    service: "radar",
    http: {
      request: { method: "GET", url },
      response: { statusCode },
    },
  };
}

function makeWindow(records: Record<string, unknown>[]): WindowContents {
  const now = new Date().toISOString();
  return {
    service: "radar",
    records,
    windowStart: now,
    windowEnd: now,
    droppedCount: 0,
  };
}

test("processClosedWindow appends endpoint stats to the baseline even with no signals", async () => {
  const baselineDir = await mkdtemp(path.join(os.tmpdir(), "af-wp-test-"));
  const metrics = createOtlpMetrics(new Registry());

  // Fast, healthy traffic — well under the static slow-endpoint threshold, so
  // no signals should fire, but the endpoint stats must still be recorded.
  const records = Array.from({ length: 10 }, () =>
    httpRecord("http://radar.speedscale.com/api/accounts", 200, 50),
  );

  await processClosedWindow(makeWindow(records), {
    baselineDir,
    logger: silentLogger(),
    metrics,
  });

  const ndjson = await readFile(path.join(baselineDir, "radar.ndjson"), "utf8");
  const lines = ndjson.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "expected at least one baseline record written");

  const rec = JSON.parse(lines[0]);
  assert.equal(rec.service, "radar");
  assert.equal(rec.endpoint, "GET /api/accounts");
  assert.equal(rec.count, 10);
  assert.equal(rec.errorRate, 0);
});

test("processClosedWindow records errorRate in the baseline", async () => {
  const baselineDir = await mkdtemp(path.join(os.tmpdir(), "af-wp-test-"));
  const metrics = createOtlpMetrics(new Registry());

  // 8 ok + 2 errors → errorRate 0.2
  const records = [
    ...Array.from({ length: 8 }, () => httpRecord("http://radar.speedscale.com/api/sync", 200, 40)),
    ...Array.from({ length: 2 }, () => httpRecord("http://radar.speedscale.com/api/sync", 500, 40)),
  ];

  await processClosedWindow(makeWindow(records), {
    baselineDir,
    logger: silentLogger(),
    metrics,
  });

  const ndjson = await readFile(path.join(baselineDir, "radar.ndjson"), "utf8");
  const rec = JSON.parse(ndjson.trim().split("\n")[0]);
  assert.equal(rec.endpoint, "GET /api/sync");
  assert.ok(Math.abs(rec.errorRate - 0.2) < 1e-9, `errorRate ${rec.errorRate} ≈ 0.2`);
});
