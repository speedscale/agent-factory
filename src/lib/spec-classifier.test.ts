import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySpec } from "./spec-classifier.js";

test("traffic-shaped perf ticket → traffic mode", () => {
  const result = classifySpec({
    title: "API performance — pipeline/opportunities endpoint slow",
    body: "Endpoint shows latency in the 350ms-1100ms range with high variance under normal load. Captured RRPairs show repeated full table scans.",
    labels: ["perf", "Component: api"],
    snapshotAvailable: true
  });
  assert.equal(result.mode, "traffic");
  assert.ok(result.scores.traffic > result.scores.source, `expected traffic>source, got ${JSON.stringify(result.scores)}`);
});

test("logging-pipeline ticket → source mode", () => {
  const result = classifySpec({
    title: "responder logs not present in reports",
    body: "There are 31 mock calls, the responder ran. But there are no responder logs attached to the report. Suspect TestReportID tag is empty when emitted.",
    labels: ["Component: responder", "Bug"],
    snapshotAvailable: false
  });
  assert.equal(result.mode, "source");
  assert.ok(result.scores.source > result.scores.traffic, `expected source>traffic, got ${JSON.stringify(result.scores)}`);
});

test("CLI ergonomics ticket → source mode", () => {
  const result = classifySpec({
    title: "Add --dry-run flag to speedmgmt tenant update",
    body: "The tenant update command should support a dry-run mode that prints METHOD/URL/body without making the API call.",
    labels: ["cli", "Component: speedmgmt"],
    snapshotAvailable: true
  });
  assert.equal(result.mode, "source");
  assert.ok(result.scores.source > result.scores.traffic, `expected source>traffic, got ${JSON.stringify(result.scores)}`);
});

test("mixed ticket → mixed mode", () => {
  const result = classifySpec({
    title: "Tenant update slow and needs dry-run + log message fix",
    body: "Two problems wrapped together: (1) p95 latency on the tenant update endpoint is 1100ms with 503 errors during burst — slow query and missing index in the captured RRPairs; (2) the command needs a --dry-run flag and the log line currently emits at the wrong log level, no log line for the API call.",
    labels: ["Component: speedmgmt"],
    snapshotAvailable: true
  });
  assert.equal(result.mode, "mixed", `rationale: ${result.rationale.join(" | ")}, scores: ${JSON.stringify(result.scores)}`);
});

test("empty input → source default", () => {
  const result = classifySpec({ title: "", body: "" });
  assert.equal(result.mode, "source");
});

test("snapshot availability without keywords leans traffic but doesn't force it", () => {
  // Pure-snapshot signal alone shouldn't override a clearly source-shaped body.
  const result = classifySpec({
    title: "indexer drops events with empty TestReportID tag",
    body: "Events with an empty test_report_id tag bypass the report_events insert in the indexer. No clickhouse rows means the analyzer can't find them.",
    snapshotAvailable: true
  });
  assert.equal(result.mode, "source", `rationale: ${result.rationale.join(" | ")}`);
});

test("rationale always populated", () => {
  const result = classifySpec({ title: "fix logging", body: "no logs in output" });
  assert.ok(result.rationale.length > 0);
});

test("scores never negative", () => {
  const result = classifySpec({ title: "", body: "", snapshotAvailable: false });
  assert.ok(result.scores.traffic >= 0);
  assert.ok(result.scores.source >= 0);
});
