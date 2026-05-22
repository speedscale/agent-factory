import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTriageResponse, formatTriageReport } from "./triage.js";

// ---------- parseTriageResponse ----------

test("parses a clean dispatch verdict", () => {
  const raw = JSON.stringify({
    verdict: "dispatch",
    reason: "Concrete bug with named file and acceptance criteria.",
    missingContext: [],
    recommendedActions: []
  });
  const r = parseTriageResponse(raw);
  assert.equal(r.verdict, "dispatch");
  assert.equal(r.reason, "Concrete bug with named file and acceptance criteria.");
  assert.deepEqual(r.missingContext, []);
  assert.deepEqual(r.recommendedActions, []);
});

test("parses a clean needs-info verdict", () => {
  const raw = JSON.stringify({
    verdict: "needs-info",
    reason: "Symptom report, no diagnostic work, fix shape ambiguous.",
    missingContext: ["Which of the three fix shapes is preferred"],
    recommendedActions: ["Pick a fix shape and add it to the acceptance criteria"]
  });
  const r = parseTriageResponse(raw);
  assert.equal(r.verdict, "needs-info");
  assert.equal(r.missingContext.length, 1);
  assert.equal(r.recommendedActions.length, 1);
});

test("tolerates ```json fences", () => {
  const raw = "```json\n" + JSON.stringify({
    verdict: "dispatch",
    reason: "ok",
    missingContext: [],
    recommendedActions: []
  }) + "\n```";
  const r = parseTriageResponse(raw);
  assert.equal(r.verdict, "dispatch");
});

test("tolerates bare ``` fences", () => {
  const raw = "```\n" + JSON.stringify({
    verdict: "needs-info",
    reason: "x",
    missingContext: ["a"],
    recommendedActions: ["b"]
  }) + "\n```";
  const r = parseTriageResponse(raw);
  assert.equal(r.verdict, "needs-info");
});

test("tolerates a leading sentence before the JSON", () => {
  const raw = `My analysis: this ticket has enough info.\n${JSON.stringify({
    verdict: "dispatch",
    reason: "ok",
    missingContext: [],
    recommendedActions: []
  })}`;
  const r = parseTriageResponse(raw);
  assert.equal(r.verdict, "dispatch");
});

test("rejects empty response", () => {
  assert.throws(() => parseTriageResponse(""), /empty/i);
  assert.throws(() => parseTriageResponse("   "), /empty/i);
});

test("rejects response with no JSON object", () => {
  assert.throws(() => parseTriageResponse("just some prose"), /JSON/);
});

test("rejects invalid JSON", () => {
  assert.throws(() => parseTriageResponse("{ not valid json"), /JSON/);
});

test("rejects unknown verdict value", () => {
  const raw = JSON.stringify({ verdict: "maybe", reason: "x", missingContext: [], recommendedActions: [] });
  assert.throws(() => parseTriageResponse(raw), /verdict/);
});

test("fills missing array fields with empty arrays", () => {
  // Models occasionally omit fields. Be defensive.
  const raw = JSON.stringify({ verdict: "dispatch", reason: "ok" });
  const r = parseTriageResponse(raw);
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.missingContext, []);
  assert.deepEqual(r.recommendedActions, []);
});

test("filters non-string entries out of arrays defensively", () => {
  const raw = JSON.stringify({
    verdict: "needs-info",
    reason: "x",
    missingContext: ["valid", 42, null, "also valid"],
    recommendedActions: [true, "yes"]
  });
  const r = parseTriageResponse(raw);
  assert.deepEqual(r.missingContext, ["valid", "also valid"]);
  assert.deepEqual(r.recommendedActions, ["yes"]);
});

// ---------- formatTriageReport ----------

test("formats a dispatch report with no extra sections", () => {
  const out = formatTriageReport({
    verdict: "dispatch",
    reason: "All fields pinned, file named.",
    missingContext: [],
    recommendedActions: []
  });
  assert.match(out, /Triage verdict: DISPATCH/);
  assert.match(out, /Reason: All fields pinned/);
  assert.doesNotMatch(out, /Missing context/);
  assert.doesNotMatch(out, /Recommended actions/);
});

test("formats a needs-info report with both missing and recommended sections", () => {
  const out = formatTriageReport({
    verdict: "needs-info",
    reason: "Fix shape ambiguous.",
    missingContext: ["Which fix shape", "How to reproduce"],
    recommendedActions: ["Pick a shape", "Attach a repro snapshot"]
  });
  assert.match(out, /Triage verdict: NEEDS-INFO/);
  assert.match(out, /Reason: Fix shape ambiguous/);
  assert.match(out, /Missing context:\n {2}- Which fix shape\n {2}- How to reproduce/);
  assert.match(out, /Recommended actions[^:]*:\n {2}- Pick a shape\n {2}- Attach a repro snapshot/);
});

test("formats correctly when only one of the array sections is populated", () => {
  const out = formatTriageReport({
    verdict: "needs-info",
    reason: "Locus unclear.",
    missingContext: ["Which component owns the bug"],
    recommendedActions: []
  });
  assert.match(out, /Missing context/);
  assert.doesNotMatch(out, /Recommended actions/);
});
