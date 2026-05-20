import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBaselineEvidence } from "./source-mode-validation.js";

test("non-zero exit code → accept (the bug reproduces)", () => {
  const r = validateBaselineEvidence({
    harnessPath: "/tmp/work/repro.sh",
    exitCode: 1,
    output: "FAIL: expected nil error, got: TEST_REPORT_ID required"
  });
  assert.equal(r.ok, true);
});

test("any non-zero, even -1, accepts", () => {
  const r = validateBaselineEvidence({ harnessPath: "/tmp/h.sh", exitCode: -1, output: "" });
  assert.equal(r.ok, true);
});

test("go-test-style exit 2 accepts", () => {
  const r = validateBaselineEvidence({ harnessPath: "/tmp/h.sh", exitCode: 2, output: "FAIL\nFAIL\texit status 2" });
  assert.equal(r.ok, true);
});

test("exit 0 → reject (the asserted bug does not exist)", () => {
  const r = validateBaselineEvidence({
    harnessPath: "/tmp/work/repro.sh",
    exitCode: 0,
    output: "PASS"
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /asserted bug does not exist/);
});

test("missing harnessPath → reject (Planner skipped the step)", () => {
  const r = validateBaselineEvidence({ exitCode: 1, output: "fail" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /missing baselineEvidence.harnessPath/);
});

test("empty harnessPath → reject", () => {
  const r = validateBaselineEvidence({ harnessPath: "   ", exitCode: 1, output: "" });
  assert.equal(r.ok, false);
});

test("non-numeric exitCode → reject", () => {
  const r = validateBaselineEvidence({ harnessPath: "/tmp/h.sh", exitCode: "1" as unknown as number, output: "" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /must be a finite number/);
});

test("NaN exitCode → reject", () => {
  const r = validateBaselineEvidence({ harnessPath: "/tmp/h.sh", exitCode: NaN, output: "" });
  assert.equal(r.ok, false);
});

test("empty output is OK as long as exit code is non-zero (grep -q semantics)", () => {
  const r = validateBaselineEvidence({ harnessPath: "/tmp/h.sh", exitCode: 1, output: "" });
  assert.equal(r.ok, true);
});

test("acceptance scenario: the failure mode this gate is designed to catch", () => {
  // Worked example: an agent fabricates a plausible-sounding bug hypothesis
  // ("phantom-UUID race in event tagging") but never actually runs a harness
  // against the unpatched code. If it had, the harness would have shown 0
  // instances of the asserted misbehavior in production traffic — exit 0,
  // bug refuted. The gate rejects the plan instead of letting the Worker
  // burn time on a non-existent issue.
  const fabricated = validateBaselineEvidence({
    harnessPath: "/tmp/work/check-phantom-uuid.sh",
    exitCode: 0,
    output: "queried clickhouse: 0 events with empty testReportId tag. No phantom UUIDs observed."
  });
  assert.equal(fabricated.ok, false);
});
