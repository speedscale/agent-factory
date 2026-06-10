/**
 * Worktree write guard — enforces the "worktree per run" core rule
 * (AGENTS.md: the Worker writes all fixes into the worktree, never into the
 * operator's live checkout).
 *
 * The engine's tools accept absolute paths, and prompt-level instructions
 * ("Do NOT write to <live checkout>") proved insufficient: models sometimes
 * write through the original --source path into the operator's checkout.
 * This module is the deterministic backstop. When a run has a worktree, the
 * tool dispatcher routes every mutating tool call (write_file, run_shell,
 * run_script) through guardToolCall before execution:
 *
 *   - Writes under the worktree or the run's workDir pass through unchanged.
 *   - Writes targeting the live checkout (repoDir / original sourceDir) are
 *     REROOTED to the equivalent path inside the worktree, with a note in the
 *     tool result telling the model to use worktree paths from now on.
 *   - Writes anywhere else are rejected with an error naming the allowed
 *     roots, so the model retries inside the worktree.
 *   - run_shell commands that reference a live-checkout path are rejected
 *     (we can't tell a read from a write inside an arbitrary shell command);
 *     the error suggests the worktree-equivalent path. cwd defaults to the
 *     worktree and is confined to the allowed roots.
 *
 * Read-only tools (read_file, search_code, read_rrpair, list_snapshot_dir,
 * compare_file_declarations) are deliberately NOT guarded — reads from the
 * original --source stay allowed.
 */

import path from "node:path";
import { realpathSync } from "node:fs";

export interface RerootEntry {
  /** A root that must never be mutated (the operator's live checkout). */
  from: string;
  /** The equivalent root inside the run worktree. */
  to: string;
}

export interface WorktreeGuard {
  /** The run's worktree root — the primary allowed write root and the default run_shell cwd. */
  worktreePath: string;
  /** Roots writes may land under: the worktree plus the run's workDir (scratch). */
  allowedRoots: string[];
  /** Live-checkout roots mapped to their worktree equivalents, longest-prefix first. */
  reroots: RerootEntry[];
}

/**
 * The lexical resolution of a path plus its symlink-free physical form when
 * they differ. The guard compares paths lexically, but on macOS the standard
 * temp locations are symlinks (/tmp → /private/tmp, /var → /private/var) and
 * the model can learn the physical form at runtime (e.g. run_shell "pwd"
 * prints /private/tmp/...). Registering both forms for every root keeps
 * legitimate worktree paths from being rejected as "outside the worktree".
 * realpath requires the path to exist; roots are created before the guard is
 * built, and we fall back to the lexical form if resolution fails.
 */
function canonicalForms(p: string): string[] {
  const resolved = path.resolve(p);
  try {
    const real = realpathSync(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

export function buildWorktreeGuard(opts: {
  worktreePath: string;
  workDir?: string;
  /** Git repo root of the operator's live checkout. */
  repoDir?: string;
  /** Original --source dir inside the live checkout. */
  sourceDir?: string;
  /** sourceDir remapped into the worktree (WorktreeResult.sourceDir). */
  worktreeSourceDir?: string;
}): WorktreeGuard {
  const worktreePath = path.resolve(opts.worktreePath);
  const allowedRoots = [...canonicalForms(opts.worktreePath)];
  if (opts.workDir) allowedRoots.push(...canonicalForms(opts.workDir));

  const reroots: RerootEntry[] = [];
  if (opts.sourceDir && opts.worktreeSourceDir) {
    const to = path.resolve(opts.worktreeSourceDir);
    for (const from of canonicalForms(opts.sourceDir)) reroots.push({ from, to });
  }
  if (opts.repoDir) {
    for (const from of canonicalForms(opts.repoDir)) reroots.push({ from, to: worktreePath });
  }
  // Longest prefix first so the more specific sourceDir mapping wins over the
  // repoDir mapping when sourceDir is nested inside repoDir (the normal case).
  reroots.sort((a, b) => b.from.length - a.from.length);

  return { worktreePath, allowedRoots, reroots };
}

/** True when p is root itself or any path under it. Both must be absolute. */
function isUnder(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isAllowed(guard: WorktreeGuard, p: string): boolean {
  return guard.allowedRoots.some((root) => isUnder(root, p));
}

/** Map a live-checkout path to its worktree equivalent, or undefined if p isn't under a forbidden root. */
function rerootPath(guard: WorktreeGuard, p: string): string | undefined {
  for (const { from, to } of guard.reroots) {
    if (isUnder(from, p)) {
      return path.join(to, path.relative(from, p));
    }
  }
  return undefined;
}

/** Shell metacharacters / whitespace that terminate a path token inside a command string. */
const TOKEN_TERMINATORS = new Set([" ", "\t", "\n", "\r", '"', "'", "`", ";", "|", "&", "<", ">", "(", ")"]);

/**
 * Best-effort scan of a shell command for references to a forbidden root.
 * Returns the first offending path token plus its worktree-equivalent
 * suggestion. Tokens that resolve under an allowed root (e.g. a workDir
 * nested inside the repo) are skipped, as are prefix-collisions like
 * /repo-archive when the forbidden root is /repo.
 */
export function findForbiddenReference(
  guard: WorktreeGuard,
  command: string
): { token: string; suggestion: string } | undefined {
  for (const { from, to } of guard.reroots) {
    let idx = command.indexOf(from);
    while (idx !== -1) {
      let end = idx + from.length;
      while (end < command.length && !TOKEN_TERMINATORS.has(command[end])) end++;
      const token = command.slice(idx, end);
      const isPathUnderFrom = token === from || token.startsWith(from + path.sep);
      if (isPathUnderFrom && !isAllowed(guard, token)) {
        return { token, suggestion: path.join(to, path.relative(from, token)) };
      }
      idx = command.indexOf(from, end);
    }
  }
  return undefined;
}

/**
 * Tools guardToolCall actively confines. Every tool that can mutate the
 * filesystem or run arbitrary commands MUST be listed here and handled in
 * guardToolCall's switch.
 */
export const MUTATING_TOOLS = new Set(["write_file", "run_shell", "run_script"]);

/**
 * Tools known to be read-only or terminal (pure result emission) — safe to
 * pass through unguarded. A tool in NEITHER set is blocked while a worktree
 * is active: failing closed turns "someone added a mutating tool and forgot
 * the guard" from a silent live-checkout write into a loud dispatch error
 * plus a failing exhaustiveness test (see engine-tools.test.ts).
 */
export const PASSTHROUGH_TOOLS = new Set([
  "read_file",
  "search_code",
  "list_snapshot_dir",
  "read_rrpair",
  "compare_file_declarations",
  "emit_plan",
  "emit_patch",
  "emit_plan_source",
  "emit_eval_report"
]);

export type GuardResult =
  /** Call may proceed. `input` may have been rerooted; `note` (if set) is
   * prepended to the tool result so the model learns the corrected path. */
  | { ok: true; input: Record<string, string>; note?: string }
  /** Call is blocked. `error` tells the model how to retry inside the worktree. */
  | { ok: false; error: string };

/**
 * Apply the worktree write policy to a tool call. Only mutating tools
 * (write_file, run_shell, run_script) are checked; everything else passes
 * through untouched so reads from the original --source stay allowed.
 */
export function guardToolCall(
  guard: WorktreeGuard,
  toolName: string,
  input: Record<string, string>
): GuardResult {
  switch (toolName) {
    case "write_file": {
      const resolved = path.resolve(input.path);
      if (isAllowed(guard, resolved)) return { ok: true, input };
      const rerooted = rerootPath(guard, resolved);
      if (rerooted) {
        return {
          ok: true,
          input: { ...input, path: rerooted },
          note:
            `NOTE: ${input.path} is in the operator's live checkout, which is READ-ONLY for this run. ` +
            `The write was redirected into the run worktree: ${rerooted}. ` +
            `Use paths under ${guard.worktreePath} for all subsequent source reads and writes.`
        };
      }
      return {
        ok: false,
        error:
          `write_file blocked: ${input.path} is outside the run worktree. ` +
          `All writes must use paths under ${guard.allowedRoots.join(" or ")}. ` +
          `Retry with a path under the worktree (${guard.worktreePath}).`
      };
    }

    case "run_shell": {
      const ref = findForbiddenReference(guard, input.command ?? "");
      if (ref) {
        return {
          ok: false,
          error:
            `run_shell blocked: the command references ${ref.token}, which is in the operator's ` +
            `live checkout (READ-ONLY for this run). Use the worktree path instead: ${ref.suggestion}. ` +
            `To read original source files, use read_file or search_code.`
        };
      }
      if (input.cwd) {
        const resolvedCwd = path.resolve(input.cwd);
        if (isAllowed(guard, resolvedCwd)) return { ok: true, input };
        const rerooted = rerootPath(guard, resolvedCwd);
        if (rerooted) {
          return {
            ok: true,
            input: { ...input, cwd: rerooted },
            note:
              `NOTE: cwd ${input.cwd} is in the operator's live checkout (READ-ONLY for this run); ` +
              `the command ran in the worktree instead: ${rerooted}.`
          };
        }
        return {
          ok: false,
          error:
            `run_shell blocked: cwd ${input.cwd} is outside the run worktree. ` +
            `Use a cwd under ${guard.worktreePath}.`
        };
      }
      // No cwd given — pin the command to the worktree instead of inheriting
      // the engine process's own cwd (the operator's environment).
      return { ok: true, input: { ...input, cwd: guard.worktreePath } };
    }

    case "run_script": {
      const resolved = path.resolve(input.path);
      if (isAllowed(guard, resolved)) return { ok: true, input };
      const rerooted = rerootPath(guard, resolved);
      if (rerooted) {
        return {
          ok: true,
          input: { ...input, path: rerooted },
          note:
            `NOTE: ${input.path} is in the operator's live checkout (READ-ONLY for this run); ` +
            `the worktree copy was run instead: ${rerooted}.`
        };
      }
      // Scripts elsewhere (e.g. scratch under os.tmpdir) don't touch the live
      // checkout by virtue of their location — allow.
      return { ok: true, input };
    }

    default:
      if (PASSTHROUGH_TOOLS.has(toolName)) {
        return { ok: true, input };
      }
      // Fail closed: an unclassified tool must not run while a worktree is
      // active — it might mutate the live checkout. This is an engine bug
      // (a new tool was added without classifying it), not a model error.
      return {
        ok: false,
        error:
          `tool "${toolName}" blocked: it is not classified by the worktree guard, so it cannot ` +
          `run while a worktree is active. Engine bug — add the tool to MUTATING_TOOLS (and handle ` +
          `it in guardToolCall) or PASSTHROUGH_TOOLS in src/lib/worktree-guard.ts.`
      };
  }
}
