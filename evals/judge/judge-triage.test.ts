import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJudgeResponse, buildAgreementReport } from "./judge-triage.js";

test("parseJudgeResponse handles clean JSON", () => {
  const raw = JSON.stringify({ pass: "pass", confidence: "high", critique: "ok" });
  const j = parseJudgeResponse(raw, "001-x", "gpt-5.4-mini", "2026-05-23T00:00:00Z");
  assert.equal(j.pass, "pass");
  assert.equal(j.confidence, "high");
  assert.equal(j.critique, "ok");
});

test("parseJudgeResponse handles fences", () => {
  const raw = "```json\n" + JSON.stringify({ pass: "fail", confidence: "medium", critique: "x" }) + "\n```";
  const j = parseJudgeResponse(raw, "002-y", "ds4", "2026-05-23T00:00:00Z");
  assert.equal(j.pass, "fail");
  assert.equal(j.confidence, "medium");
});

test("parseJudgeResponse coerces bad values to uncertain/low", () => {
  const raw = JSON.stringify({ pass: "MAYBE", confidence: "🤷", critique: 42 });
  const j = parseJudgeResponse(raw, "003-z", "x", "t");
  assert.equal(j.pass, "uncertain");
  assert.equal(j.confidence, "low");
  assert.equal(j.critique, "");
});

test("parseJudgeResponse on empty returns uncertain", () => {
  const j = parseJudgeResponse("", "004", "x", "t");
  assert.equal(j.pass, "uncertain");
});

test("parseJudgeResponse on garbage returns uncertain", () => {
  const j = parseJudgeResponse("not json at all", "005", "x", "t");
  assert.equal(j.pass, "uncertain");
});

test("buildAgreementReport flags disagreements", () => {
  const j1 = [
    { fixture: "a", judgeModel: "g", pass: "pass" as const, confidence: "high" as const, critique: "ok", ts: "t" },
    { fixture: "b", judgeModel: "g", pass: "fail" as const, confidence: "high" as const, critique: "no", ts: "t" },
  ];
  const j2 = [
    { fixture: "a", judgeModel: "d", pass: "pass" as const, confidence: "high" as const, critique: "yep", ts: "t" },
    { fixture: "b", judgeModel: "d", pass: "pass" as const, confidence: "low" as const, critique: "looks ok", ts: "t" },
  ];
  const report = buildAgreementReport(new Map([["g", j1], ["d", j2]]));
  assert.match(report, /Disagreements/);
  assert.match(report, /### b/);
  assert.match(report, /1\/2/);
});

test("buildAgreementReport shows no disagreements section when full agreement", () => {
  const j1 = [{ fixture: "a", judgeModel: "g", pass: "pass" as const, confidence: "high" as const, critique: "ok", ts: "t" }];
  const j2 = [{ fixture: "a", judgeModel: "d", pass: "pass" as const, confidence: "high" as const, critique: "ok", ts: "t" }];
  const report = buildAgreementReport(new Map([["g", j1], ["d", j2]]));
  assert.match(report, /full agreement: 1\/1/);
  assert.match(report, /None\./);
});
