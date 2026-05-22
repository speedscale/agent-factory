import { test } from "node:test";
import assert from "node:assert/strict";
import { MR_CHECKLIST, MR_CHECKLIST_REQUIRED_LINES, validateMrBody } from "./mr-checklist.js";

// ---------- Positive: the canonical block satisfies the hook ----------

test("MR_CHECKLIST contains every required line verbatim", () => {
  // This is the single most load-bearing test in the file: if the constant
  // ever drifts from the madskillz hook's REQUIRED array, this fails and we
  // catch it locally before any MR is opened.
  for (const line of MR_CHECKLIST_REQUIRED_LINES) {
    assert.ok(
      MR_CHECKLIST.includes(line),
      `MR_CHECKLIST is missing the required line: ${JSON.stringify(line)}`
    );
  }
});

test("validateMrBody accepts MR_CHECKLIST itself", () => {
  const r = validateMrBody(MR_CHECKLIST);
  assert.deepEqual(r, { ok: true });
});

test("validateMrBody accepts a full MR body with Problem/Solution + MR_CHECKLIST appended", () => {
  const body = `# Problem\n\nSomething was broken.\n\n# Solution\n\nFixed it.\n${MR_CHECKLIST}`;
  const r = validateMrBody(body);
  assert.deepEqual(r, { ok: true });
});

// ---------- Negative: known-bad bodies must be rejected ----------

test("validateMrBody rejects an empty body", () => {
  const r = validateMrBody("");
  assert.equal(r.ok, false);
  if (r.ok === false) {
    // All 6 lines should be flagged as missing.
    assert.equal(r.missing.length, MR_CHECKLIST_REQUIRED_LINES.length);
  }
});

test("validateMrBody rejects a body that has the Problem/Solution sections but no checklist at all", () => {
  const body = "# Problem\n\nx\n\n# Solution\n\ny\n";
  const r = validateMrBody(body);
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.missing.includes("## Checklist"));
    assert.ok(r.missing.includes("- [x] Security impact of change has been considered"));
  }
});

test("validateMrBody rejects the old unchecked [ ] variant (the bug this PR fixes)", () => {
  // This is the exact shape the constant USED to be before this fix. Lock it
  // out so a future edit doesn't silently regress.
  const oldBuggyChecklist = `
## Checklist

Each of these checkboxes should be filled before merge.

- [ ] Security impact of change has been considered
- [ ] Code follows company security practices and guidelines
- [ ] Pull request linked to task tracker
- [ ] If this is a breaking change a story has been created and assigned to Ken
`;
  const r = validateMrBody(oldBuggyChecklist);
  assert.equal(r.ok, false);
  if (r.ok === false) {
    // All four item lines should be flagged. The H2 header and the
    // "Each of these checkboxes…" line still match — the rejection is purely
    // due to the [ ] vs [x] difference, which is exactly the bug.
    assert.equal(r.missing.length, 4);
    for (const m of r.missing) assert.ok(m.startsWith("- [x] "), `expected an item line, got ${JSON.stringify(m)}`);
  }
});

test("validateMrBody rejects a body where the H2 header is downgraded to H1 (the other variant I got wrong)", () => {
  const wrongHeaderChecklist = `
# Checklist

Each of these checkboxes should be filled before merge.

- [x] Security impact of change has been considered
- [x] Code follows company security practices and guidelines
- [x] Pull request linked to task tracker
- [x] If this is a breaking change a story has been created and assigned to Ken
`;
  const r = validateMrBody(wrongHeaderChecklist);
  assert.equal(r.ok, false);
  if (r.ok === false) {
    // Only "## Checklist" is missing — the H1 version doesn't contain it.
    assert.deepEqual(r.missing, ["## Checklist"]);
  }
});

test("validateMrBody rejects a body where one item is paraphrased", () => {
  // Even a small wording change breaks the literal grep. Verifies the hook
  // contract is wording-exact, not semantic.
  const paraphrased = `
## Checklist

Each of these checkboxes should be filled before merge.

- [x] Security impact considered
- [x] Code follows company security practices and guidelines
- [x] Pull request linked to task tracker
- [x] If this is a breaking change a story has been created and assigned to Ken
`;
  const r = validateMrBody(paraphrased);
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.deepEqual(r.missing, ["- [x] Security impact of change has been considered"]);
  }
});

test("validateMrBody rejects a body with the self-invented checklist I used on MR !6415 originally", () => {
  // The exact wrong-content checklist that prompted Ken's pushback on MR !6415.
  // Locking this out so I can't drift back to it.
  const selfInventedChecklist = `
# Checklist

- [ ] I have performed a self-review of my code
- [ ] If it is a core feature, I have added thorough tests
- [ ] Will this be part of a product update? If yes, please write one phrase about this update
- [ ] I have updated the documentation accordingly
`;
  const r = validateMrBody(selfInventedChecklist);
  assert.equal(r.ok, false);
  if (r.ok === false) {
    // Every single required line should be missing — nothing here matches.
    assert.equal(r.missing.length, MR_CHECKLIST_REQUIRED_LINES.length);
  }
});

test("validateMrBody rejects a body missing exactly the trailing 'breaking change' line", () => {
  const truncatedChecklist = `
## Checklist

Each of these checkboxes should be filled before merge.

- [x] Security impact of change has been considered
- [x] Code follows company security practices and guidelines
- [x] Pull request linked to task tracker
`;
  const r = validateMrBody(truncatedChecklist);
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.deepEqual(r.missing, [
      "- [x] If this is a breaking change a story has been created and assigned to Ken"
    ]);
  }
});

// ---------- Drift guard: required lines stay aligned with the hook ----------

test("MR_CHECKLIST_REQUIRED_LINES has exactly the 6 lines the madskillz hook expects", () => {
  // If the madskillz hook grows or shrinks the REQUIRED array, this test
  // forces a deliberate update here too (and via the comment in mr-checklist.ts
  // the engineer is reminded to mirror the change in the .sh file).
  assert.equal(MR_CHECKLIST_REQUIRED_LINES.length, 6);
  assert.equal(MR_CHECKLIST_REQUIRED_LINES[0], "## Checklist");
  assert.equal(MR_CHECKLIST_REQUIRED_LINES[1], "Each of these checkboxes should be filled before merge.");
  // Items 2..5 are the four checkbox lines, all using [x].
  for (let i = 2; i < 6; i++) {
    assert.ok(
      MR_CHECKLIST_REQUIRED_LINES[i].startsWith("- [x] "),
      `Item ${i} must use a pre-checked [x] box, got: ${JSON.stringify(MR_CHECKLIST_REQUIRED_LINES[i])}`
    );
  }
});
