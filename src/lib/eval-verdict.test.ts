import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalVerdict,
  formatMisses,
  verdictGloss,
  type MissedRequirement
} from "./eval-verdict.js";

// ---------- computeFinalVerdict ----------

test("no misses + trustworthy harness → pass", () => {
  assert.equal(computeFinalVerdict("pass", [], true), "pass");
});

test("model verdict 'fail' always wins (even with no misses)", () => {
  // Evaluator returns fail when the core fix is missing or the patch is
  // wrong — not a recoverable partial.
  assert.equal(computeFinalVerdict("fail", [], true), "fail");
});

test("model verdict 'fail' wins over blocker misses", () => {
  assert.equal(
    computeFinalVerdict("fail", [{ text: "x", severity: "blocker" }], true),
    "fail"
  );
});

test("only soft misses + trustworthy harness → partial-soft", () => {
  const misses: MissedRequirement[] = [
    { text: "Tests are shallow (registration only)", severity: "soft", reason: "matches sibling test pattern" },
    { text: "No doc update", severity: "soft" }
  ];
  assert.equal(computeFinalVerdict("partial", misses, true), "partial-soft");
});

test("at least one blocker miss → partial-blocker", () => {
  const misses: MissedRequirement[] = [
    { text: "Soft thing", severity: "soft" },
    { text: "Re-run the demo repro (AC#4)", severity: "blocker", reason: "load-bearing AC" }
  ];
  assert.equal(computeFinalVerdict("partial", misses, true), "partial-blocker");
});

test("untrustworthy harness alone (no misses) → partial-blocker", () => {
  // The patch may be correct but we have no way to prove it without a
  // trustworthy harness — that's a blocker.
  assert.equal(computeFinalVerdict("pass", [], false), "partial-blocker");
});

test("untrustworthy harness with soft-only misses still → partial-blocker", () => {
  const misses: MissedRequirement[] = [{ text: "shallow", severity: "soft" }];
  assert.equal(computeFinalVerdict("partial", misses, false), "partial-blocker");
});

test("model 'partial' verdict bucketed correctly via misses", () => {
  // The Evaluator's own bucket isn't trusted — we re-derive from misses so
  // the verdict stays consistent with the misses array.
  assert.equal(computeFinalVerdict("partial", [], true), "pass");
  assert.equal(computeFinalVerdict("partial", [{ text: "x", severity: "soft" }], true), "partial-soft");
  assert.equal(computeFinalVerdict("partial", [{ text: "x", severity: "blocker" }], true), "partial-blocker");
});

test("model 'pass' with blocker misses gets correctly downgraded", () => {
  // A model that grades itself "pass" but lists blocker misses is
  // contradicting itself. Trust the misses — derive partial-blocker.
  assert.equal(
    computeFinalVerdict("pass", [{ text: "x", severity: "blocker" }], true),
    "partial-blocker"
  );
});

// ---------- backfill checks against the two motivating tickets ----------
//
// The original spec called for verifying the new Evaluator produces the
// right buckets on the two real runs that motivated the work: the brotli
// responder ticket (reviewer rejected, blocker AC missed) and the export
// subcommands ticket (reviewer likely accepts, only shallow-tests miss).
//
// We can't drive the real LLM here, but we CAN assert that the bucketing
// logic produces the right verdict when fed the human-triaged miss shape
// for each. If the prompt teaches the Evaluator to tag severity correctly,
// the verdict will land in the right bucket.

test("backfill: brotli responder shape (load-bearing AC miss) → partial-blocker", () => {
  const misses: MissedRequirement[] = [
    {
      text: "Re-run the demo replay end-to-end with the recorded brotli rrpair to demonstrate the fix",
      severity: "blocker",
      reason: "AC#4 explicitly requires a real-traffic reproduction, not a synthetic unit test"
    }
  ];
  assert.equal(computeFinalVerdict("partial", misses, true), "partial-blocker");
});

test("backfill: export subcommands shape (shallow tests matching codebase pattern) → partial-soft", () => {
  const misses: MissedRequirement[] = [
    {
      text: "Tests exercise subcommand registration and flag presence only",
      severity: "soft",
      reason: "sibling test the spec told the Worker to mirror is equally shallow"
    }
  ];
  assert.equal(computeFinalVerdict("partial", misses, true), "partial-soft");
});

// ---------- formatMisses ----------

test("formatMisses sorts blockers first, then soft", () => {
  const misses: MissedRequirement[] = [
    { text: "soft thing", severity: "soft" },
    { text: "blocker thing", severity: "blocker" }
  ];
  const out = formatMisses(misses);
  const blockerLine = out.indexOf("blocker thing");
  const softLine = out.indexOf("soft thing");
  assert.ok(blockerLine >= 0 && softLine >= 0);
  assert.ok(blockerLine < softLine, "blocker must render before soft");
  assert.match(out, /\[BLOCKER\]/);
  assert.match(out, /\[soft\]/);
});

test("formatMisses on empty list says '(none)'", () => {
  assert.equal(formatMisses([]), "  (none)");
});

test("formatMisses includes reason when present", () => {
  const out = formatMisses([
    { text: "x", severity: "blocker", reason: "because Y" }
  ]);
  assert.match(out, /x — because Y/);
});

// ---------- verdictGloss ----------

test("verdictGloss returns distinct human-readable lines per verdict", () => {
  const glosses = new Set([
    verdictGloss("pass"),
    verdictGloss("partial-soft"),
    verdictGloss("partial-blocker"),
    verdictGloss("fail")
  ]);
  assert.equal(glosses.size, 4, "every verdict must produce a distinct gloss");
  assert.match(verdictGloss("partial-blocker"), /BLOCKER/);
  assert.match(verdictGloss("partial-soft"), /soft/);
});
