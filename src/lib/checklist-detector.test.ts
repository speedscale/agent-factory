import { test } from "node:test";
import assert from "node:assert/strict";
import { detectChecklist, formatChecklistReport } from "./checklist-detector.js";

// ---------- needs-split: title comma-and lists ----------

test("title 'Add proxymock export subcommands for Postman, k6, and Gatling' → needs-split with 3 items", () => {
  const r = detectChecklist({
    title: "Add proxymock export subcommands for Postman, k6, and Gatling",
    body: "Body intentionally light to isolate the title rule."
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "title");
  assert.deepEqual(r.subDeliverables, ["Postman", "k6", "Gatling"]);
});

test("title 'Implement A, B, C and D' (non-Oxford) → needs-split with 4 items", () => {
  const r = detectChecklist({
    title: "Implement validators for A, B, C and D",
    body: ""
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "title");
  assert.deepEqual(r.subDeliverables, ["A", "B", "C", "D"]);
});

test("backtick-quoted title items stripped cleanly", () => {
  const r = detectChecklist({
    title: "Build exporters for `postman`, `k6`, and `gatling`",
    body: ""
  });
  assert.equal(r.verdict, "needs-split");
  assert.deepEqual(r.subDeliverables, ["postman", "k6", "gatling"]);
});

// ---------- needs-split: body parallel bullets ----------

test("body with 3 parallel 'Add' bullets → needs-split with 3 items", () => {
  const r = detectChecklist({
    title: "Expand proxymock export",
    body: `## Scope

* Add \`proxymock export postman\`
* Add \`proxymock export k6\`
* Add \`proxymock export gatling\`
* Reuse existing \`lib/export\` generation logic
* Keep behavior/flags consistent`
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "body");
  assert.equal(r.subDeliverables.length, 3);
  for (const item of r.subDeliverables) {
    assert.match(item, /^Add\b/);
  }
});

test("body with 4 'Implement' numbered list items → needs-split", () => {
  const r = detectChecklist({
    title: "Customer reporting feature",
    body: `1. Implement the daily aggregator job
2. Implement the weekly aggregator job
3. Implement the monthly aggregator job
4. Implement the yearly aggregator job`
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "body");
  assert.equal(r.subDeliverables.length, 4);
});

test("body bullets with leading inline code fences are recognized", () => {
  const r = detectChecklist({
    title: "Add validators",
    body: `* \`v1/foo\` — Add length check
* \`v1/bar\` — Add range check
* \`v1/baz\` — Add enum check`
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "body");
  assert.equal(r.subDeliverables.length, 3);
});

test("checkbox-style bullets ('- [ ] Add foo') are recognized", () => {
  const r = detectChecklist({
    title: "Migration prep",
    body: `## Tasks
- [ ] Add the schema migration
- [ ] Add the rollback path
- [ ] Add the integration test`
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "body");
  assert.equal(r.subDeliverables.length, 3);
});

// ---------- dispatch: single-deliverable bug specs ----------

test("'MCP cursor base64 incompatibility' (single-bug shape) → dispatch", () => {
  const r = detectChecklist({
    title: "MCP resource cursor incompatible with mcp-go base64 pagination",
    body: `1. Context
   MCP server resource listing (speedctl/mcp/resources.go)
2. Problem
   The \`onAfterListResources\` hook sets \`NextCursor\` as a plain integer string (e.g. \`"100"\`), but mcp-go v0.45.0's \`listByPagination\` (server/server.go:985) base64-decodes cursors via \`base64.StdEncoding.DecodeString()\`. When a client paginates using the cursor from the first response, the server fails with \`illegal base64 data at input byte 0\`.

This breaks Gemini.`
  });
  assert.equal(r.verdict, "dispatch");
  assert.equal(r.signal, "none");
  assert.deepEqual(r.subDeliverables, []);
});

test("'Add the foo flag' single-feature spec → dispatch", () => {
  const r = detectChecklist({
    title: "Add a --dry-run flag to tenant set",
    body: `Today the command always hits the live endpoint, which has bitten us during staging rollouts.

Add a --dry-run option so callers can preview the API call before sending.`
  });
  assert.equal(r.verdict, "dispatch");
  assert.equal(r.signal, "none");
});

test("title with 'X and Y' (2 items only) does NOT auto-split", () => {
  // The title rule requires ≥3 items because pairs are too noisy:
  // "Add X and Y" often describes a single coupled change.
  const r = detectChecklist({
    title: "Add the foo and bar helpers",
    body: "One narrative paragraph, no parallel bullets."
  });
  assert.equal(r.verdict, "dispatch");
});

test("narrative title with commas but no build verb does NOT trigger", () => {
  const r = detectChecklist({
    title: "Postman, k6, and Gatling integrations all return 500 in dev",
    body: "Bug — investigate the shared client."
  });
  assert.equal(r.verdict, "dispatch");
  assert.equal(r.signal, "none");
});

test("body with 2 parallel bullets (under the threshold) → dispatch", () => {
  const r = detectChecklist({
    title: "Bug fix",
    body: `## Acceptance
- Add the bug fix
- Add a regression test`
  });
  assert.equal(r.verdict, "dispatch");
  assert.equal(r.signal, "none");
});

test("body bullets that are not build verbs (validation criteria) → dispatch", () => {
  const r = detectChecklist({
    title: "Bug fix for X",
    body: `## Acceptance
- All tests pass
- No lint warnings
- The X regression test fails on master and passes on the branch`
  });
  assert.equal(r.verdict, "dispatch");
  assert.equal(r.signal, "none");
});

// ---------- composite signals + ordering ----------

test("when both title list AND body bullets fire, title wins (cleaner enumeration)", () => {
  const r = detectChecklist({
    title: "Add exporters for Postman, k6, and Gatling",
    body: `## Scope
* Add postman exporter
* Add k6 exporter
* Add gatling exporter`
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "title");
  assert.deepEqual(r.subDeliverables, ["Postman", "k6", "Gatling"]);
});

test("formatChecklistReport on needs-split mentions every sub-deliverable + the bypass flag", () => {
  const r = detectChecklist({
    title: "Add proxymock export subcommands for Postman, k6, and Gatling",
    body: ""
  });
  const report = formatChecklistReport(r);
  assert.match(report, /NEEDS-SPLIT/);
  assert.match(report, /Postman/);
  assert.match(report, /k6/);
  assert.match(report, /Gatling/);
  assert.match(report, /--no-checklist-check/);
  assert.match(report, /docs\/multi-deliverable-tickets\.md/);
});

test("formatChecklistReport on dispatch is short and verdict-clear", () => {
  const r = detectChecklist({
    title: "Add a --dry-run flag to tenant set",
    body: "Body."
  });
  const report = formatChecklistReport(r);
  assert.match(report, /DISPATCH/);
});

// ---------- edge cases ----------

test("empty spec → dispatch (no signal at all)", () => {
  const r = detectChecklist({ title: "", body: "" });
  assert.equal(r.verdict, "dispatch");
});

test("'Adding/Implements' inflected forms still group together", () => {
  // "Adding" and "Adds" should both lemma-reduce to "add" so 3 mixed-inflected
  // bullets still trip the rule.
  const r = detectChecklist({
    title: "Foo",
    body: `* Adding the parser
* Adds the validator
* Add the dispatcher`
  });
  assert.equal(r.verdict, "needs-split");
  assert.equal(r.signal, "body");
});
