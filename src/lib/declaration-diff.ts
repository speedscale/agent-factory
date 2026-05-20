/**
 * Top-level declaration extractor and differ.
 *
 * Used by the Evaluator's `compare_file_declarations` tool to detect when a
 * Worker has destructively rewritten a source file — i.e. dropped functions
 * unrelated to the spec'd change. The Worker uses full-file write_file, so
 * any declaration it forgets to reproduce disappears from the file and the
 * code stops compiling.
 *
 * The extractor recognises common top-level declaration patterns across the
 * languages agent-factory targets (Go, TS/JS, Python, Rust). It is intentionally
 * permissive: false positives (extra names) are harmless; false negatives
 * (missed names) leak the deletion past the gate. When in doubt, match.
 */

/** Patterns recognised, ordered by specificity. First match wins per line. */
const DECLARATION_PATTERNS: { pattern: RegExp; lang: string }[] = [
  // Go: func (r *Recv) Name(...) — receiver method
  { pattern: /^func\s+\([^)]+\)\s+(\w+)\s*\(/, lang: "go-method" },
  // Go: func Name(...)
  { pattern: /^func\s+(\w+)\s*\(/, lang: "go-func" },
  // Go: type Name struct/interface/...
  { pattern: /^type\s+(\w+)\s+/, lang: "go-type" },
  // Go: var/const declarations at column 0 (skip parenthesised groups — those wrap multiple decls)
  { pattern: /^var\s+(\w+)\s+/, lang: "go-var" },
  { pattern: /^const\s+(\w+)\s+/, lang: "go-const" },

  // TS/JS: export function NAME / export async function NAME
  { pattern: /^export\s+(?:async\s+)?function\s+(\w+)/, lang: "ts-export-func" },
  // TS/JS: function NAME / async function NAME
  { pattern: /^(?:async\s+)?function\s+(\w+)/, lang: "ts-func" },
  // TS/JS: export class NAME / class NAME
  { pattern: /^(?:export\s+)?class\s+(\w+)/, lang: "ts-class" },
  // TS/JS: export const/let/var NAME = …
  { pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/, lang: "ts-const" },
  // TS: export interface/type NAME
  { pattern: /^(?:export\s+)?interface\s+(\w+)/, lang: "ts-interface" },
  { pattern: /^(?:export\s+)?type\s+(\w+)\s*=/, lang: "ts-type-alias" },

  // Python: def name(...) / async def name(...)
  { pattern: /^(?:async\s+)?def\s+(\w+)\s*\(/, lang: "py-def" },
  // Python: class Name(...)
  { pattern: /^class\s+(\w+)\s*[(:]/, lang: "py-class" },

  // Rust: pub fn name / fn name
  { pattern: /^(?:pub(?:\([^)]+\))?\s+)?fn\s+(\w+)/, lang: "rust-fn" },
  { pattern: /^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait)\s+(\w+)/, lang: "rust-type" }
];

/**
 * Returns the set of top-level declaration names found in the file content.
 *
 * Only column-0 declarations count — nested functions inside a struct method
 * body, closures inside a function, etc. are ignored. This is deliberate: the
 * Worker is allowed to add/remove inner functions as part of a fix; what we
 * want to catch is missing TOP-level decls.
 */
export function extractTopLevelDeclarations(content: string): Set<string> {
  const found = new Set<string>();
  for (const rawLine of content.split("\n")) {
    // Strip carriage return for CRLF inputs; otherwise leave indentation alone
    // so the column-0 anchor in the patterns works.
    const line = rawLine.replace(/\r$/, "");
    for (const { pattern } of DECLARATION_PATTERNS) {
      const m = line.match(pattern);
      if (m && m[1]) {
        found.add(m[1]);
        break;
      }
    }
  }
  return found;
}

export interface DeclarationDiff {
  added: string[];
  removed: string[];
  /** Names that survived unchanged across both files. */
  preserved: string[];
}

/**
 * Computes the symmetric diff of top-level declaration names between two
 * versions of a file. `removed` is the load-bearing signal — a non-empty
 * removed list on a patch that didn't ask for deletions is a destructive
 * rewrite and should fail the Evaluator's verdict.
 */
export function diffDeclarations(originalContent: string, patchedContent: string): DeclarationDiff {
  const orig = extractTopLevelDeclarations(originalContent);
  const patched = extractTopLevelDeclarations(patchedContent);
  const added: string[] = [];
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const name of patched) {
    if (!orig.has(name)) added.push(name);
    else preserved.push(name);
  }
  for (const name of orig) {
    if (!patched.has(name)) removed.push(name);
  }
  added.sort();
  removed.sort();
  preserved.sort();
  return { added, removed, preserved };
}
