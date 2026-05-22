/**
 * Pre-Planner multi-deliverable detector.
 *
 * Answers: "does this spec ask for N parallel deliverables that should each
 * be dispatched separately, or is it one logical change?"
 *
 * The source-mode Planner emits ONE failingAssertion + ONE reproduce harness;
 * the Worker writes the patch that makes that one harness pass. The model
 * works well for "fix this bug" specs and breaks for "implement A, B, and C"
 * specs — the Worker may deliver only one of the asks and the Evaluator will
 * grade the run `partial`.
 *
 * Rather than widen the Planner shape (the heavier path discussed in the
 * design doc), this detector pushes multi-deliverable recognition up to the
 * same layer that does triage and repro-context checking. On `needs-split`
 * the engine refuses dispatch and prints a reviewer-ready report; the
 * operator splits the ticket in Linear and dispatches each sub-deliverable
 * independently.
 *
 * Deterministic, pattern-based, no LLM. Two signals:
 *
 *   1. Title comma+and list with ≥3 items after a build verb:
 *      "Add proxymock export subcommands for Postman, k6, and Gatling"
 *
 *   2. Body contains ≥3 markdown bullets that all start with the same build
 *      verb (Add/Implement/Create/...): a parallel-bullet checklist.
 *
 * Single-deliverable bug specs ("MCP cursor base64 incompatibility") have
 * neither signal and pass cleanly.
 */

export type ChecklistVerdict = "dispatch" | "needs-split";

export interface ChecklistResult {
  verdict: ChecklistVerdict;
  reason: string;
  /** Names of the sub-deliverables when verdict is needs-split; empty otherwise. */
  subDeliverables: string[];
  /** Which signal fired: "title" comma-list, "body" parallel bullets, or "none". */
  signal: "title" | "body" | "none";
}

const BUILD_VERB_ALTERNATION =
  "add|adds|adding|implement|implements|implementing|create|creates|creating|" +
  "build|builds|building|support|supports|supporting|introduce|introduces|" +
  "expose|exposes|generate|generates|generating|provide|provides|providing|" +
  "register|registers|wire|wires";

const BUILD_VERB_RE = new RegExp(`\\b(?:${BUILD_VERB_ALTERNATION})\\b`, "i");

/**
 * Reduce inflected forms back to a base lemma so "Add" and "Adding" group
 * together for parallel-bullet counting. Returns null for non-build verbs.
 */
function verbLemma(word: string): string | null {
  const w = word.toLowerCase();
  const bases = [
    "add", "implement", "create", "build", "support", "introduce",
    "expose", "generate", "provide", "register", "wire"
  ];
  for (const base of bases) {
    if (w === base || w === base + "s" || w === base + "d" ||
        w === base + "ed" || w === base + "ing") {
      return base;
    }
  }
  return null;
}

/**
 * Detect a comma+and list of ≥3 items in the title, anchored to a build verb
 * appearing earlier in the title. Returns the parsed item names, stripped of
 * surrounding backticks. Empty array if no list is present.
 *
 * Examples that match (return ≥3 items):
 *   "Add proxymock export subcommands for Postman, k6, and Gatling"
 *   "Implement A, B, C and D"
 *   "Build X, Y, Z exporters"  (no — no "and" connector, see note below)
 *
 * Examples that don't match:
 *   "Add the foo flag"          (no list)
 *   "Fix the X, Y, Z parsing"   (no build verb)
 *   "Add X and Y"               (only 2 items — too noisy to auto-split)
 *
 * The 2-item case is left to the body-bullet rule below; titles like
 * "Add foo and bar" can describe a single logical change and we'd rather
 * dispatch than over-split.
 *
 * The "and" connector is required so we don't accidentally split on inline
 * commas inside a single deliverable description ("Add the X, Y, Z parsing
 * step" reads as one item with sub-noun commas).
 */
function detectTitleList(title: string): string[] {
  // Item shape: backtick-quoted token OR an alphanumeric word that can carry
  // dots, dashes, slashes, plus signs (so "k6", "v1.2", "foo/bar", "C++" all
  // survive). Multi-word items are uncommon enough at the title level that
  // we accept the false negative.
  const item = "(?:`[^`]+`|[A-Za-z][\\w./+-]*)";
  const listRe = new RegExp(
    `(${item}(?:\\s*,\\s*${item})+\\s*,?\\s+and\\s+${item})`,
    "i"
  );
  const m = title.match(listRe);
  if (!m || m.index === undefined) return [];

  // Require a build verb somewhere before the list, otherwise this is a
  // narrative title ("X, Y, and Z all broken") not a deliverable list.
  const before = title.slice(0, m.index);
  if (!BUILD_VERB_RE.test(before)) return [];

  return m[1]
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

/**
 * Detect a body checklist where ≥3 markdown bullets share the same build
 * verb. Returns the verb lemma + the matched lines; null if no such
 * checklist exists.
 *
 * Recognized bullet shapes:
 *   - foo
 *   * foo
 *   1. foo
 *   1) foo
 *   - [ ] foo
 *   - [x] foo
 *
 * The bullet text must START with a build verb (after stripping optional
 * leading inline code fence) — this is what distinguishes deliverable
 * bullets from validation bullets ("- All tests pass") or narrative
 * bullets ("- The bug appears only on macOS").
 *
 * Requires ≥3 bullets sharing one lemma rather than 2 because pairs are
 * common in bug specs ("- Add fix; - Add regression test") and don't
 * imply parallel feature work.
 */
function detectBodyBullets(body: string): { lemma: string; items: string[] } | null {
  const lines = body.split(/\r?\n/);
  const byLemma = new Map<string, string[]>();

  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
    if (!bullet) continue;
    let text = bullet[1].trim();

    // Skip an optional leading inline code fence ("`foo` — Add the bar")
    // so the actual verb is the first real word.
    text = text.replace(/^`[^`]+`\s*[-—:]?\s*/, "");

    const wordMatch = text.match(/^([A-Za-z]+)\b/);
    if (!wordMatch) continue;
    const lemma = verbLemma(wordMatch[1]);
    if (!lemma) continue;

    const existing = byLemma.get(lemma) ?? [];
    existing.push(bullet[1].trim());
    byLemma.set(lemma, existing);
  }

  let best: { lemma: string; items: string[] } | null = null;
  for (const [lemma, items] of byLemma) {
    if (items.length >= 3 && (!best || items.length > best.items.length)) {
      best = { lemma, items };
    }
  }
  return best;
}

/**
 * Decide whether to dispatch the spec as-is or refuse with `needs-split`.
 *
 * Title comma-list wins over body bullets when both fire — the title-level
 * list is generally a cleaner enumeration of the deliverables than whatever
 * the body bullets transcribed.
 */
export function detectChecklist(spec: { title: string; body: string }): ChecklistResult {
  const titleItems = detectTitleList(spec.title);
  if (titleItems.length >= 3) {
    return {
      verdict: "needs-split",
      reason: `Title names ${titleItems.length} parallel deliverables (${titleItems.join(", ")}). The engine ships one deliverable per dispatch — split into ${titleItems.length} Linear tickets and dispatch each one separately.`,
      subDeliverables: titleItems,
      signal: "title"
    };
  }

  const bodyHit = detectBodyBullets(spec.body);
  if (bodyHit) {
    return {
      verdict: "needs-split",
      reason: `Body contains ${bodyHit.items.length} parallel "${bodyHit.lemma}" bullets — independent deliverables that should be dispatched separately. The Planner emits one failing assertion per dispatch and the Worker may deliver only the first item.`,
      subDeliverables: bodyHit.items,
      signal: "body"
    };
  }

  return {
    verdict: "dispatch",
    reason: "Single-deliverable spec — no parallel checklist detected.",
    subDeliverables: [],
    signal: "none"
  };
}

/**
 * Format a checklist result as a reviewer-ready report. Safe to paste into
 * a Linear comment or echo to the operator's terminal.
 */
export function formatChecklistReport(result: ChecklistResult): string {
  if (result.verdict === "dispatch") {
    return `Checklist verdict: DISPATCH\nReason: ${result.reason}`;
  }
  const lines: string[] = [];
  lines.push("Checklist verdict: NEEDS-SPLIT");
  lines.push(`Reason: ${result.reason}`);
  lines.push("");
  lines.push("Detected sub-deliverables:");
  for (const item of result.subDeliverables) {
    lines.push(`  - ${item}`);
  }
  lines.push("");
  lines.push("Recommended action: split this ticket into one Linear ticket per sub-deliverable, then re-dispatch each one independently. See docs/multi-deliverable-tickets.md for guidance.");
  lines.push("Pass --no-checklist-check to bypass this gate if the deliverables share enough scaffolding that one dispatch can plausibly cover them all.");
  return lines.join("\n");
}
