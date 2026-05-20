/**
 * LLM engine — Claude API tool-use agent loop.
 *
 * Implements the Engine interface from §8 of the design doc using the
 * Claude Agent SDK (Option 1). The engine runs a tool-use agentic loop:
 * Claude calls read/search/write tools until it emits a terminal tool
 * (emit_plan for the Planner phase, emit_patch for the Worker phase).
 *
 * Tools available to the agent:
 *   read_file          — read a source file
 *   search_code        — grep for a pattern in a directory
 *   list_snapshot_dir  — list RRPair files in a snapshot directory by host
 *   read_rrpair        — read a single RRPair markdown file
 *   write_file         — write generated content to a path
 *   emit_plan          — terminal: agent has finished the Planner phase
 *   emit_patch         — terminal: agent has finished the Worker phase
 */

import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { AgentPlan } from "../contracts/index.js";
import {
  callLLM,
  defaultModelFor,
  type AssistantTurn,
  type ConvMessage,
  type LLMProvider,
  type ToolDef
} from "./llm-providers.js";
import { validateBaselineEvidence, type BaselineEvidence } from "./source-mode-validation.js";
import { diffDeclarations } from "./declaration-diff.js";

const execAsync = promisify(exec);

const MAX_TOKENS = 8192;
const MAX_LOOPS = parseInt(process.env.ENGINE_MAX_LOOPS ?? "50", 10);

export interface EmitPlanResult {
  plan: AgentPlan;
  metric: string;
  baseline: string;
  rationale: string;
}

export interface EmitPatchResult {
  filePath: string;
  patch: string;
  rationale: string;
  harnessPath?: string;
  confirmResult?: string;
  /** Set when a worktree was created for this run. */
  worktreePath?: string;
  branchName?: string;
}

/**
 * Source-mode plan result. Unlike traffic mode, there's no wire metric — the
 * Planner names an assertion that is false today and must be true after the fix.
 *
 * baselineEvidence is mandatory: the Planner must have written a harness and
 * run it against the unpatched worktree, observing a non-zero exit. Without
 * that proof, the run aborts before the Worker phase starts.
 */
export interface EmitPlanSourceResult {
  plan: AgentPlan;
  failingAssertion: string;
  assertionShape: "unit-test" | "source-grep" | "log-line" | "behavior-check";
  rationale: string;
  baselineEvidence: BaselineEvidence;
}

export interface EmitEvalReportResult {
  addressedRequirements: string[];
  missedRequirements: string[];
  confirmHarnessTrustworthy: boolean;
  confirmHarnessNotes: string;
  /** "pass" | "partial" | "fail" */
  overallVerdict: string;
  summary: string;
}

export interface LLMRunOptions {
  snapshotDir?: string;
  sourceDir?: string;
  workDir?: string;
  verbose?: boolean;
  /** Absolute path to the git repo root. When set, Worker creates a worktree before writing any files. */
  repoDir?: string;
  /** Branch name for the worktree, e.g. "agent/s-10886-radar-perf". Required when repoDir is set. */
  branchName?: string;
  /** LLM provider for both Planner and Worker. Defaults to "anthropic". */
  provider?: LLMProvider;
  /** Model identifier for the chosen provider. Defaults to defaultModelFor(provider). */
  model?: string;
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
  /** sourceDir remapped into the worktree (replaces opts.sourceDir for the Worker) */
  sourceDir: string;
}

/**
 * Creates a git worktree at <workDir>/repo on a new branch from main.
 * Returns the worktree path and the remapped sourceDir.
 */
export async function setupWorktree(
  repoDir: string,
  workDir: string,
  branchName: string,
  originalSourceDir: string
): Promise<WorktreeResult> {
  const worktreePath = path.join(workDir, "repo");
  // Detect default branch (main or master)
  const { stdout: branchOut } = await execAsync(`git -C ${JSON.stringify(repoDir)} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || git -C ${JSON.stringify(repoDir)} rev-parse --abbrev-ref HEAD`);
  const defaultBranch = branchOut.trim().replace(/^.*\//, '') || "main";
  await execAsync(`git -C ${JSON.stringify(repoDir)} worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreePath)} ${defaultBranch}`);
  // Remap sourceDir: replace the repoDir prefix with the worktree path
  const rel = path.relative(repoDir, originalSourceDir);
  const remappedSourceDir = path.join(worktreePath, rel);
  return { worktreePath, branchName, sourceDir: remappedSourceDir };
}

/**
 * Removes a worktree and deletes the branch. Safe to call even if worktree doesn't exist.
 */
export async function teardownWorktree(repoDir: string, worktreePath: string, branchName: string): Promise<void> {
  try {
    await execAsync(`git -C ${JSON.stringify(repoDir)} worktree remove --force ${JSON.stringify(worktreePath)}`);
  } catch { /* already gone */ }
  try {
    await execAsync(`git -C ${JSON.stringify(repoDir)} branch -D ${JSON.stringify(branchName)}`);
  } catch { /* already gone */ }
}

// ---------- tool implementations ----------

async function toolReadFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    if (lines.length > 500) {
      return `[truncated to 500 lines]\n${lines.slice(0, 500).join("\n")}`;
    }
    return content;
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

async function toolSearchCode(pattern: string, dir: string): Promise<string> {
  // Common source extensions across the languages we expect to encounter as
  // Agent Factory targets. Without --include, grep -r matches binaries and
  // node_modules; with too narrow a list, Go/Python/Java targets return zero
  // matches and weaker models give up.
  const includes = [
    "*.js", "*.ts", "*.mjs", "*.tsx", "*.jsx",
    "*.go", "*.py", "*.java", "*.kt", "*.rb",
    "*.c", "*.h", "*.cpp", "*.hpp", "*.cc",
    "*.rs", "*.cs", "*.swift", "*.php",
    "*.sh", "*.yaml", "*.yml", "*.toml", "*.json"
  ].map((g) => `--include=${JSON.stringify(g)}`).join(" ");
  const excludes = `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=vendor --exclude-dir=dist --exclude-dir=build`;
  try {
    const { stdout } = await execAsync(
      `grep -rEn ${includes} ${excludes} -m 50 ${JSON.stringify(pattern)} ${JSON.stringify(dir)} 2>/dev/null || true`
    );
    return stdout.trim() || "(no matches)";
  } catch {
    return "(search failed)";
  }
}

async function toolListSnapshotDir(snapshotDir: string): Promise<string> {
  try {
    const hosts = await readdir(snapshotDir);
    const lines: string[] = [];
    for (const host of hosts) {
      try {
        const files = await readdir(path.join(snapshotDir, host));
        const statusCounts: Record<string, number> = {};
        for (const f of files) {
          // Status embedded in filename is not reliable — summarise by count
          statusCounts["total"] = (statusCounts["total"] ?? 0) + 1;
        }
        lines.push(`${host}: ${files.length} RRPairs`);
        // Show first 3 filenames so agent can pick ones to read
        lines.push(...files.slice(0, 3).map((f) => `  ${path.join(snapshotDir, host, f)}`));
        if (files.length > 3) lines.push(`  ... and ${files.length - 3} more`);
      } catch {
        lines.push(`${host}: (unreadable)`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

async function toolReadRRPair(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    // RRPairs are markdown — return up to 200 lines
    const lines = content.split("\n");
    if (lines.length > 200) {
      return `[truncated to 200 lines]\n${lines.slice(0, 200).join("\n")}`;
    }
    return content;
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

async function toolWriteFile(filePath: string, content: string): Promise<string> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `wrote ${filePath} (${content.length} bytes)`;
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

async function toolRunScript(scriptPath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`node ${JSON.stringify(scriptPath)}`, { timeout: 30_000 });
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
  }
}

/**
 * Compare top-level declarations in a file vs. its pre-patch version on the
 * base branch. Used by the Evaluator to detect destructive Worker rewrites
 * (functions silently dropped during a full-file write_file overwrite).
 *
 * Input: an absolute path to a file in the post-patch worktree.
 *
 * The tool resolves the git worktree root from the path, determines the base
 * branch (origin/HEAD, falling back to master then main), and runs
 * `git show <base>:<rel-path>` to obtain the pre-patch content. It then
 * diffs the two sets of top-level declarations.
 *
 * Returns a JSON blob the Evaluator can read directly:
 *   { added: [...], removed: [...], preserved_count: N }
 *
 * `removed` is the load-bearing signal — non-empty on a patch that didn't
 * ask for deletions = destructive rewrite. The Evaluator's prompt instructs
 * it to fail-verdict in that case.
 */
async function toolCompareFileDeclarations(filePath: string): Promise<string> {
  try {
    const { stdout: rootOut } = await execAsync(
      `git -C ${JSON.stringify(path.dirname(filePath))} rev-parse --show-toplevel`
    );
    const repoRoot = rootOut.trim();
    const relPath = path.relative(repoRoot, filePath);

    // Detect base branch — try origin/HEAD first, then master, then main.
    let baseRef = "";
    try {
      const { stdout } = await execAsync(
        `git -C ${JSON.stringify(repoRoot)} symbolic-ref --short refs/remotes/origin/HEAD`
      );
      baseRef = stdout.trim().split("/").pop() ?? "";
    } catch { /* fall through */ }
    if (!baseRef) {
      for (const candidate of ["master", "main"]) {
        try {
          await execAsync(`git -C ${JSON.stringify(repoRoot)} rev-parse --verify ${candidate}`);
          baseRef = candidate;
          break;
        } catch { /* try next */ }
      }
    }
    if (!baseRef) {
      return `error: could not determine base branch for ${filePath}`;
    }

    let originalContent: string;
    try {
      const { stdout } = await execAsync(
        `git -C ${JSON.stringify(repoRoot)} show ${JSON.stringify(baseRef + ":" + relPath)}`,
        { maxBuffer: 8 * 1024 * 1024 }
      );
      originalContent = stdout;
    } catch (err) {
      // File didn't exist on the base branch — it's a new file. Report this
      // as added=<all>, removed=[].
      const e = err as { stderr?: string };
      if (e.stderr && /exists on disk, but not in|does not exist/.test(e.stderr)) {
        const patchedContent = await readFile(filePath, "utf8");
        const diff = diffDeclarations("", patchedContent);
        return JSON.stringify({
          file: relPath,
          baseRef,
          note: "file is new — not present on base branch",
          added: diff.added,
          removed: diff.removed,
          preserved_count: diff.preserved.length
        });
      }
      return `error: failed to read ${baseRef}:${relPath} — ${e.stderr ?? String(err)}`;
    }

    const patchedContent = await readFile(filePath, "utf8");
    const diff = diffDeclarations(originalContent, patchedContent);
    return JSON.stringify({
      file: relPath,
      baseRef,
      added: diff.added,
      removed: diff.removed,
      preserved_count: diff.preserved.length
    });
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run an arbitrary shell command. Used in source mode where the confirm
 * harness is a native unit test runner (`go test`, `npm test`, `pytest`).
 * 90s timeout — short enough that the model has to write focused tests, long
 * enough for go test compilation. Output is truncated to keep prompts small.
 */
async function toolRunShell(command: string, cwd?: string): Promise<string> {
  const opts: { timeout: number; cwd?: string } = { timeout: 90_000 };
  if (cwd) opts.cwd = cwd;
  try {
    const { stdout, stderr } = await execAsync(command, opts);
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return out.length > 8000 ? `[truncated to 8000 chars]\n${out.slice(0, 8000)}` : out;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    return out.length > 8000 ? `[truncated to 8000 chars]\n${out.slice(0, 8000)}` : out;
  }
}

// ---------- tool definitions for the API ----------

const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a source file from disk. Use absolute paths.",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute path to the file" } },
      required: ["path"]
    }
  },
  {
    name: "search_code",
    description: "Grep for a pattern across JS/TS source files in a directory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Grep pattern (ERE)" },
        dir: { type: "string", description: "Absolute path to the directory to search" }
      },
      required: ["pattern", "dir"]
    }
  },
  {
    name: "list_snapshot_dir",
    description: "List RRPair files in a snapshot directory, grouped by host. Returns file paths you can pass to read_rrpair.",
    inputSchema: {
      type: "object" as const,
      properties: { dir: { type: "string", description: "Absolute path to the snapshot directory (the inner one containing host subdirs)" } },
      required: ["dir"]
    }
  },
  {
    name: "read_rrpair",
    description: "Read a single RRPair markdown file from a snapshot. Shows request + response.",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute path to the .md RRPair file" } },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file. Use this to produce test harnesses or patch files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute path to write" },
        content: { type: "string", description: "File content" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "run_script",
    description: "Execute a Node.js script and return its stdout/stderr. Use this to run a reproduce or confirm harness.",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute path to the .mjs or .js script to run" } },
      required: ["path"]
    }
  },
  {
    name: "compare_file_declarations",
    description: "Diff the top-level declarations (functions, types, classes, exports) of a file against its pre-patch version on the git base branch. Returns JSON with added[] and removed[] lists. Use this in the Evaluator phase to detect destructive Worker rewrites: a non-empty `removed` list on a patch that didn't explicitly ask for deletions means the Worker silently dropped functions during a full-file overwrite. Call this on every file the Worker modified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute path to the patched file (in the Worker's worktree)" }
      },
      required: ["path"]
    }
  },
  {
    name: "run_shell",
    description: "Execute an arbitrary shell command (e.g. `go test ./internal/foo/...`, `npm test`, `pytest -k mytest`). 90s timeout. Use this in source mode to run native unit tests as the confirm harness.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory. Defaults to the workDir." }
      },
      required: ["command"]
    }
  },
  {
    name: "emit_plan",
    description: "Terminal tool: emit the structured AgentPlan. Call this when you have identified the bug metric, confirmed it is reproducible, and have a hypothesis. This ends the Planner phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One-sentence summary of the issue" },
        hypothesis: { type: "string", description: "Root cause hypothesis" },
        metric: { type: "string", description: "The specific measurable metric the bug violates (e.g. 'peak concurrent calls > 10')" },
        baseline: { type: "string", description: "The measured baseline value from running against unpatched code" },
        targetFile: { type: "string", description: "Absolute path to the source file that needs to change" },
        targetFunction: { type: "string", description: "Name of the function or code section to fix" },
        rationale: { type: "string", description: "Evidence trail — which RRPairs, line numbers, patterns led to this conclusion" }
      },
      required: ["summary", "hypothesis", "metric", "baseline", "targetFile", "targetFunction", "rationale"]
    }
  },
  {
    name: "emit_patch",
    description: "Terminal tool: emit the code fix. Call this when you have written the fix and verified it with the harness. This ends the Worker phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        targetFile: { type: "string", description: "Absolute path of the file that was patched" },
        patch: { type: "string", description: "The actual code change as a unified diff or the new function body" },
        rationale: { type: "string", description: "Why this fix addresses the root cause" },
        confirmResult: { type: "string", description: "Output of running the confirm harness against the patched code" }
      },
      required: ["targetFile", "patch", "rationale"]
    }
  },
  {
    name: "emit_plan_source",
    description: "Terminal tool (source mode): emit the structured AgentPlan when the bug has no wire signal — telemetry, CLI flags, log lines, init ordering, schema migrations, etc. The plan names a source-level assertion the Worker will satisfy AND attaches baseline evidence proving the bug reproduces today. This ends the Planner phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One-sentence summary of the issue" },
        hypothesis: { type: "string", description: "Root cause hypothesis grounded in the code you read" },
        targetFile: { type: "string", description: "Absolute path to the source file that needs to change" },
        targetFunction: { type: "string", description: "Name of the function, branch, or code section to fix" },
        failingAssertion: {
          type: "string",
          description: "A concrete, checkable assertion that is false today and must be true after the fix. Examples: 'indexer.extractEvent inserts events whose TestReportID tag is empty into report_events' (false today), 'speedmgmt tenant update --dry-run prints METHOD/URL/body and exits before calling the API' (false today)."
        },
        assertionShape: {
          type: "string",
          enum: ["unit-test", "source-grep", "log-line", "behavior-check"],
          description: "How the Worker should confirm: unit-test = run a language-native test (go test, npm test, pytest); source-grep = grep the patched file for a required token/branch; log-line = run the binary and check stdout/stderr for a specific line; behavior-check = run a small script that exercises the code path."
        },
        rationale: { type: "string", description: "Evidence trail — which files, lines, log messages, or code branches led to this conclusion" },
        baselineHarnessPath: {
          type: "string",
          description: "Absolute path to the harness script you wrote and ran against the UNPATCHED worktree. This same harness will be re-run by the Worker after the fix is applied. For unit-test shape, a *_test.go / .test.ts / test_*.py file (the test asserts the new behavior and fails on unpatched code). For source-grep, a small shell or node script. The file must already exist on disk."
        },
        baselineExitCode: {
          type: "integer",
          description: "Exit code observed when you ran the baseline harness against the unpatched worktree. MUST be non-zero — a zero exit means the bug doesn't reproduce and the run will be rejected by the reproduce gate. If you got exit 0, your assertion is wrong; re-investigate before emitting this plan."
        },
        baselineOutput: {
          type: "string",
          description: "Trimmed stdout/stderr from running the baseline harness. The Evaluator will use this to grade that the failure was of the expected kind. Paste it verbatim; truncate at ~2000 chars if needed."
        }
      },
      required: ["summary", "hypothesis", "targetFile", "targetFunction", "failingAssertion", "assertionShape", "rationale", "baselineHarnessPath", "baselineExitCode", "baselineOutput"]
    }
  },
  {
    name: "emit_eval_report",
    description: "Terminal tool: emit the evaluation report comparing the Worker's patch to the original spec and plan. Call this when you have enumerated the spec requirements, checked each against the patch, and assessed the confirm harness. This ends the Evaluator phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        addressedRequirements: {
          type: "array",
          items: { type: "string" },
          description: "Spec requirements that ARE reflected in the patch. Quote the requirement text verbatim or near-verbatim from the spec body."
        },
        missedRequirements: {
          type: "array",
          items: { type: "string" },
          description: "Spec requirements that are NOT reflected in the patch. Quote the requirement text verbatim or near-verbatim from the spec body. Empty array if everything is addressed."
        },
        confirmHarnessTrustworthy: {
          type: "boolean",
          description: "True if the confirm harness actually exercises the metric named in the plan. False if the harness asserts on something else, was skipped, or appears fabricated."
        },
        confirmHarnessNotes: {
          type: "string",
          description: "One or two sentences explaining the confirmHarnessTrustworthy assessment. What does the harness actually test? Does it match the planned metric?"
        },
        overallVerdict: {
          type: "string",
          enum: ["pass", "partial", "fail"],
          description: "pass = all requirements addressed and harness trustworthy; partial = some requirements missed or harness weak but core fix landed; fail = core fix missing or patch is wrong."
        },
        summary: {
          type: "string",
          description: "One or two sentences summarising the verdict and what (if anything) the user should do next."
        }
      },
      required: ["addressedRequirements", "missedRequirements", "confirmHarnessTrustworthy", "confirmHarnessNotes", "overallVerdict", "summary"]
    }
  }
];

// ---------- tool dispatch ----------

async function dispatchTool(name: string, input: Record<string, string>): Promise<string> {
  switch (name) {
    case "read_file": return toolReadFile(input.path);
    case "search_code": return toolSearchCode(input.pattern, input.dir);
    case "list_snapshot_dir": return toolListSnapshotDir(input.dir);
    case "read_rrpair": return toolReadRRPair(input.path);
    case "write_file": return toolWriteFile(input.path, input.content);
    case "run_script": return toolRunScript(input.path);
    case "run_shell": return toolRunShell(input.command, input.cwd);
    case "compare_file_declarations": return toolCompareFileDeclarations(input.path);
    default: return `unknown tool: ${name}`;
  }
}

// ---------- agentic loop ----------

async function agentLoop(
  systemPrompt: string,
  userMessage: string,
  terminalToolName: string,
  verbose: boolean,
  maxLoops: number = MAX_LOOPS,
  provider: LLMProvider = "anthropic",
  model: string = defaultModelFor(provider),
  tools: ToolDef[] = TOOLS
): Promise<Record<string, string>> {
  const messages: ConvMessage[] = [{ role: "user", content: userMessage }];
  let loops = 0;
  // Inject a "you must emit now" nudge when 60% of budget is used.
  // Earlier than 60% wastes budget; later (e.g. 80%) is too late for weaker
  // models that bail on end_turn before the nudge ever fires.
  const nudgeAt = Math.floor(maxLoops * 0.6);
  let nudgeSent = false;
  // When set, the next callLLM forces the terminal tool via tool_choice.
  // Weaker models ignore the inline nudge text; the API-level force does not.
  let forceNextTurn = false;

  if (verbose) console.error(`[engine] provider=${provider} model=${model}`);

  function nudgeMessage(): string {
    return `[SYSTEM] You have used ${loops} of ${maxLoops} allowed loops. You MUST call ${terminalToolName} now with whatever findings you have. Do not read any more files or call any other tools first.`;
  }

  while (loops < maxLoops) {
    loops++;
    if (verbose) console.error(`[engine] loop ${loops}/${maxLoops}`);

    // Inject a forced-emit nudge into the message stream at the scheduled budget point.
    if (loops === nudgeAt && !nudgeSent) {
      nudgeSent = true;
      forceNextTurn = true;
      messages.push({ role: "user", content: nudgeMessage() });
    }

    const turn: AssistantTurn = await callLLM({
      provider,
      model,
      system: systemPrompt,
      tools,
      messages,
      maxTokens: MAX_TOKENS,
      forceToolName: forceNextTurn ? terminalToolName : undefined
    });
    forceNextTurn = false;

    if (verbose) console.error(`[engine] stop_reason=${turn.stopReason}`);

    if (verbose && turn.textBlocks.length > 0) {
      console.error(`[engine] ${turn.textBlocks.map((b) => b.text.slice(0, 200)).join(" ")}`);
    }

    // Check if the terminal tool was called
    const terminal = turn.toolUses.find((t) => t.name === terminalToolName);
    if (terminal) {
      if (verbose) console.error(`[engine] terminal tool called: ${terminalToolName}`);
      return terminal.input;
    }

    if (turn.stopReason === "end_turn" && turn.toolUses.length === 0) {
      // Weaker models reach a hypothesis and then just stop without calling the
      // terminal tool. Don't fail — record the model's parting text, inject a
      // forced-emit nudge, and continue. If we've already nudged, we let the
      // loop budget catch this (throwing only on max-iterations).
      if (verbose) console.error(`[engine] end_turn without ${terminalToolName} — injecting forced-emit nudge`);
      if (turn.textBlocks.length > 0) {
        // Keep the assistant's reasoning in history so the next turn can build on it.
        messages.push({ role: "assistant", turn });
      }
      messages.push({ role: "user", content: nudgeMessage() });
      nudgeSent = true;
      forceNextTurn = true;
      continue;
    }

    // Add assistant turn to history
    messages.push({ role: "assistant", turn });

    // Execute all non-terminal tool calls and add results
    const toolResults: { toolUseId: string; content: string }[] = [];
    for (const toolUse of turn.toolUses) {
      if (toolUse.name === terminalToolName) continue;
      if (verbose) console.error(`[engine] tool: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await dispatchTool(toolUse.name, toolUse.input);
      if (verbose) console.error(`[engine] result: ${result.slice(0, 150)}`);
      toolResults.push({ toolUseId: toolUse.id, content: result });
    }

    messages.push({ role: "user", toolResults });
  }

  throw new Error(`agent loop exceeded ${maxLoops} iterations`);
}

// ---------- Planner phase ----------

const PLANNER_SYSTEM = `You are the Planner for the Speedscale Agent Factory.

Your job is to:
1. Analyze the snapshot RRPair files to find evidence of the bug.
2. Identify the specific, measurable metric the bug violates (e.g. "peak concurrent API calls", "error rate on endpoint X").
3. Find the relevant source code that causes the issue.
4. Optionally write and run a self-contained reproduce harness script to measure the baseline.
5. Call emit_plan with your findings.

Rules:
- Use list_snapshot_dir to survey the snapshot, then read_rrpair on individual files.
- Count error responses (4xx, 5xx) by host and endpoint. Note timestamps for burst patterns.
- Use search_code and read_file to find the code responsible.
- For algorithmic bugs (concurrency, batching), write a self-contained Node.js harness to measure the metric.
- Do NOT write any fix yet. Your job ends at emit_plan.
- The metric must be a number with a threshold (e.g. "peak concurrent gmail.googleapis.com/messages.get calls must be ≤ 10").

STOPPING RULE — CRITICAL:
By loop 20, you must have identified the root cause(s). Once you have identified a root cause and have at least one measurable baseline (from the snapshot or a harness), call emit_plan IMMEDIATELY. Do not continue reading more files, correlating more data, or writing additional harnesses after you have enough to emit a plan. Perfectionism past loop 20 is waste that causes the run to fail. When in doubt, emit what you have.
`;

export async function runPlanner(
  issueSpec: { title: string; body: string },
  opts: LLMRunOptions
): Promise<EmitPlanResult> {
  const parts = [
    `Issue: ${issueSpec.title}`,
    `Description: ${issueSpec.body}`
  ];
  if (opts.snapshotDir) parts.push(`Snapshot directory: ${opts.snapshotDir}`);
  if (opts.sourceDir) parts.push(`Source directory: ${opts.sourceDir}`);
  if (opts.workDir) parts.push(`Work directory for harness files: ${opts.workDir}`);

  const PLANNER_MAX_LOOPS = parseInt(process.env.ENGINE_PLANNER_MAX_LOOPS ?? "30", 10);
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? defaultModelFor(provider);
  const result = await agentLoop(PLANNER_SYSTEM, parts.join("\n"), "emit_plan", opts.verbose ?? false, PLANNER_MAX_LOOPS, provider, model);

  const plan: AgentPlan = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentPlan",
    metadata: { name: `plan-llm-${Date.now()}` },
    spec: {
      runRef: { name: "llm-run" },
      summary: result.summary,
      hypothesis: result.hypothesis,
      steps: [
        { id: "reproduce", action: "inspect", description: `Metric: ${result.metric} — baseline: ${result.baseline}` },
        { id: "fix", action: "edit", description: `Fix ${result.targetFunction} in ${result.targetFile}` },
        { id: "confirm", action: "validate", description: "Run confirm harness and verify metric is within bound", command: "node" },
        { id: "report", action: "inspect", description: "Emit QualityReport" }
      ],
      validation: {
        command: "node",
        successCriteria: `Metric '${result.metric}' is within acceptable bound on patched code`
      }
    }
  };

  return { plan, metric: result.metric, baseline: result.baseline, rationale: result.rationale };
}

// ---------- Worker phase ----------

const WORKER_SYSTEM = `You are the Worker for the Speedscale Agent Factory.

You have received a plan from the Planner. Your job is to:
1. Read the source file identified in the plan.
2. Write the minimal fix that addresses the root cause.
3. Write (or reuse) the reproduce harness to confirm the metric is now within bound on patched code.
4. Run the confirm harness against the patched code.
5. Call emit_patch with the fix and confirm result.

Rules:
- Use write_file to apply the fix directly to the target file. Make the minimal change.
- Use run_script to execute the confirm harness.
- The confirm harness must use identical methodology to the reproduce harness (same mock, same measurement).
- Do not refactor beyond the fix. No cleanup. No new abstractions beyond what the fix requires.
- If the confirm harness fails, read the output, fix the issue, and re-run.
`;

// ---------- Evaluator phase ----------

const EVALUATOR_SYSTEM = `You are the Evaluator for the Speedscale Agent Factory.

A Planner has produced a plan and a Worker has produced a patch with a confirm harness. Your job is to independently verify that the patch actually delivers the spec, NOT to take the Worker's self-report at face value.

Tasks:
1. Read the spec carefully. Enumerate every distinct requirement — numbered items, bulleted items, sentences with "should/must/needs to". Quote them.
2. **Destructive-rewrite check (MANDATORY).** Call compare_file_declarations on every file the Worker modified (from the patch "Target file" field). The tool returns JSON with added[] and removed[] arrays listing top-level declarations that appeared or disappeared between the base branch and the patched file. Rules:
   - removed[] MUST be empty unless the spec explicitly asked to delete those declarations. Any unexplained name in removed[] is a destructive rewrite (Worker silently dropped code while overwriting the whole file with write_file). Fail-verdict.
   - added[] is normally OK — new tests, new helpers for the fix. But check that added names belong to the fix and aren't unrelated.
3. For each spec requirement, decide whether the patch reflects it. Use read_file on the patched source and search_code to verify. The patch field in the input shows what changed, but check the file directly — agents sometimes describe a change differently than the actual diff.
4. Read the confirm harness (if a path was provided) and decide whether it actually exercises the planned signal. Grade the harness by its shape:
   - Wire harness (traffic mode): a Node script that mocks the upstream and measures a metric. Trustworthy = the metric variable is computed from observed calls, not hardcoded, and the assertion compares to the planned threshold.
   - Unit test (source mode): a *_test.go / .test.ts / test_*.py file. Trustworthy = the assertion exercises the patched code branch, fails on the unpatched code, and doesn't just assert on a constant.
   - Source-grep / log-line / behavior-check (source mode): a small shell or node script. Trustworthy = it actually invokes/reads the patched code path and the assertion fails if the fix is removed.
   - In ALL shapes, a harness that "passes" by checking string equality on a hardcoded value or by reading the source instead of running it is NOT trustworthy.
5. Call emit_eval_report with your findings.

Rules:
- You have READ-ONLY tools. Do not modify any files.
- Be strict about missed requirements. If the spec says "add a --dry-run flag" and you can't find a --dry-run flag in the patch or source, that's a missed requirement, not a "minor gap."
- "pass" verdict requires ALL spec requirements addressed AND confirm harness trustworthy AND no unjustified deletions in compare_file_declarations.
- "partial" = core fix landed but some requirements missing OR harness is weak (e.g. mocks the thing being tested).
- "fail" = the core fix doesn't address the central bug, the patch is plainly wrong, OR compare_file_declarations reports removed declarations the spec didn't authorize.
- Do not call emit_eval_report until you have actually read the patched source file AND called compare_file_declarations on every file the Worker modified.

STOPPING RULE:
By loop 15, emit the report with whatever findings you have. Do not keep exploring once the question is answered.
`;

/**
 * Polymorphic plan shape accepted by the Evaluator. The Evaluator renders
 * the plan into prompt text, so it just needs the fields it will display.
 */
export type AnyPlanResult =
  | (EmitPlanResult & { mode?: "traffic" })
  | (EmitPlanSourceResult & { mode: "source" });

export async function runEvaluator(
  issueSpec: { title: string; body: string },
  planResult: AnyPlanResult,
  patchResult: EmitPatchResult,
  opts: LLMRunOptions
): Promise<EmitEvalReportResult> {
  // Read-only subset of tools — no write_file, no run_script. Plus
  // compare_file_declarations, which is read-only (git show + regex) and
  // catches destructive Worker rewrites.
  const evalTools: ToolDef[] = TOOLS.filter((t) =>
    ["read_file", "search_code", "list_snapshot_dir", "read_rrpair", "compare_file_declarations", "emit_eval_report"].includes(t.name)
  );

  const isSource = "failingAssertion" in planResult;

  const parts = [
    `=== Original spec ===`,
    `Title: ${issueSpec.title}`,
    `Body:`,
    issueSpec.body,
    ``,
    `=== Planner output ===`,
    `Mode: ${isSource ? "source" : "traffic"}`,
    `Summary: ${planResult.plan.spec.summary}`,
    `Hypothesis: ${planResult.plan.spec.hypothesis}`,
    isSource
      ? `Failing assertion (false today, must be true after fix): ${(planResult as EmitPlanSourceResult).failingAssertion}`
      : `Metric: ${(planResult as EmitPlanResult).metric}`,
    isSource
      ? `Assertion shape: ${(planResult as EmitPlanSourceResult).assertionShape}`
      : `Baseline: ${(planResult as EmitPlanResult).baseline}`,
    `Rationale: ${planResult.rationale}`
  ];

  if (isSource) {
    const ev = (planResult as EmitPlanSourceResult).baselineEvidence;
    parts.push(
      ``,
      `=== Baseline reproduce evidence (Planner ran this against UNPATCHED code) ===`,
      `Harness path: ${ev.harnessPath}`,
      `Baseline exit code: ${ev.exitCode} (non-zero = bug reproduces)`,
      `Baseline output:`,
      ev.output.slice(0, 2000)
    );
  }

  parts.push(
    ``,
    `=== Worker output ===`,
    `Target file: ${patchResult.filePath}`,
    `Patch (as reported by Worker):`,
    patchResult.patch,
    `Rationale: ${patchResult.rationale}`,
    patchResult.harnessPath ? `Confirm harness path: ${patchResult.harnessPath}` : `Confirm harness path: (not provided)`,
    `Confirm result (Worker self-report):`,
    patchResult.confirmResult ?? "(none)"
  );

  if (isSource) {
    parts.push(
      ``,
      `=== Source-mode trustworthiness check ===`,
      `For this run, the harness path in the Worker's output MUST match the Planner's baseline harness path. If it doesn't, the Worker rewrote the harness — that's NOT trustworthy (the Worker can write a passing harness for anything). Set confirmHarnessTrustworthy=false in that case.`,
      `The Worker's confirm result MUST indicate success (exit 0, "PASS", "ok", etc. depending on harness shape). If it shows failure or the Worker skipped the run, set confirmHarnessTrustworthy=false.`
    );
  }

  if (opts.sourceDir) parts.push(``, `Source directory (read patched files from here): ${opts.sourceDir}`);
  if (opts.workDir) parts.push(`Work directory (harness scripts live here): ${opts.workDir}`);
  if (opts.snapshotDir) parts.push(`Snapshot directory (original RRPair evidence): ${opts.snapshotDir}`);

  const EVALUATOR_MAX_LOOPS = parseInt(process.env.ENGINE_EVALUATOR_MAX_LOOPS ?? "20", 10);
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? defaultModelFor(provider);
  const result = await agentLoop(
    EVALUATOR_SYSTEM,
    parts.join("\n"),
    "emit_eval_report",
    opts.verbose ?? false,
    EVALUATOR_MAX_LOOPS,
    provider,
    model,
    evalTools
  );

  return {
    addressedRequirements: Array.isArray(result.addressedRequirements) ? result.addressedRequirements as unknown as string[] : [],
    missedRequirements: Array.isArray(result.missedRequirements) ? result.missedRequirements as unknown as string[] : [],
    confirmHarnessTrustworthy: result.confirmHarnessTrustworthy as unknown as boolean,
    confirmHarnessNotes: result.confirmHarnessNotes ?? "",
    overallVerdict: result.overallVerdict ?? "partial",
    summary: result.summary ?? ""
  };
}

export async function runWorker(
  planResult: EmitPlanResult,
  opts: LLMRunOptions
): Promise<EmitPatchResult> {
  let worktree: WorktreeResult | undefined;

  // Set up an isolated worktree before touching any source files.
  if (opts.repoDir && opts.branchName && opts.sourceDir && opts.workDir) {
    worktree = await setupWorktree(opts.repoDir, opts.workDir, opts.branchName, opts.sourceDir);
    console.log(`[engine] worktree: ${worktree.worktreePath} (branch: ${worktree.branchName})`);
  }

  const effectiveSourceDir = worktree?.sourceDir ?? opts.sourceDir;

  // Remap any original sourceDir paths in plan text to the worktree sourceDir so the Worker
  // doesn't accidentally write to the operator's live checkout.
  function remapPaths(s: string): string {
    if (!worktree || !opts.sourceDir) return s;
    return s.replaceAll(opts.sourceDir, worktree.sourceDir);
  }

  const parts = [
    `Plan summary: ${remapPaths(planResult.plan.spec.summary)}`,
    `Hypothesis: ${remapPaths(planResult.plan.spec.hypothesis)}`,
    `Metric to fix: ${planResult.metric}`,
    `Baseline measurement: ${planResult.baseline}`,
    `Target file: ${remapPaths(planResult.plan.spec.steps.find((s) => s.action === "edit")?.description ?? "")}`,
    `Rationale from Planner: ${remapPaths(planResult.rationale)}`
  ];
  if (effectiveSourceDir) parts.push(`Source directory: ${effectiveSourceDir}`);
  if (opts.workDir) parts.push(`Work directory: ${opts.workDir}`);
  if (worktree) {
    parts.push(
      `WORKTREE: Source files are in an isolated worktree at ${worktree.worktreePath}. ` +
      `For ALL read_file and write_file calls that touch source code, use paths under ${worktree.sourceDir}. ` +
      `Do NOT read from or write to ${opts.sourceDir} — that directory is off-limits for this run.`
    );
  }

  const WORKER_MAX_LOOPS = parseInt(process.env.ENGINE_WORKER_MAX_LOOPS ?? "25", 10);
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? defaultModelFor(provider);
  const result = await agentLoop(WORKER_SYSTEM, parts.join("\n"), "emit_patch", opts.verbose ?? false, WORKER_MAX_LOOPS, provider, model);

  return {
    filePath: result.targetFile,
    patch: result.patch,
    rationale: result.rationale,
    harnessPath: result.harnessPath,
    confirmResult: result.confirmResult,
    worktreePath: worktree?.worktreePath,
    branchName: worktree?.branchName,
  };
}

// ---------- Source-mode Planner ----------

const PLANNER_SOURCE_SYSTEM = `You are the Planner for the Speedscale Agent Factory, running in SOURCE mode.

Source mode is for bugs that have no wire signal — telemetry/logging pipeline gaps, CLI ergonomics (--dry-run, output formatting), init/migration ordering, structural code paths not exercised by the captured snapshot. There is no RRPair evidence to grep through.

Your job is to:
1. Read the source code paths the ticket implicates (search_code first to find them, then read_file for full context).
2. Identify the smallest concrete code branch / function / line that is wrong.
3. Formulate a "failing assertion": a single sentence that is FALSE about the unpatched code today and must be TRUE after the fix. The assertion must be checkable by a unit test, a grep of the patched file, a log-line check on a run, or a small behavior probe.
4. **REPRODUCE THE BUG.** Write a harness that exercises the failing assertion. Run it via run_shell against the UNPATCHED worktree. It MUST fail (non-zero exit). This is the reproduce gate — without it, the run will be rejected.
5. Call emit_plan_source with your findings AND the baseline harness path + exit code + output.

Rules:
- Use search_code and read_file. The snapshot tools (list_snapshot_dir, read_rrpair) may have nothing useful — ignore them if so.
- The failing assertion must be concrete and falsifiable. "The code should log better" is NOT good — "responder/cmd/root.go does not abort startup when TestReportID is empty; the assertion 'when TEST_REPORT_ID is unset, runLive returns an error before constructing the firehose reporter' is false today" IS good.
- Pick an assertionShape that matches the bug: unit-test for logic in a function, source-grep for a required guard/branch presence, log-line for stdout/stderr behavior, behavior-check for a small end-to-end probe.
- The baseline harness MUST be the same script the Worker will run after the fix. Write it as the Worker would: for unit-test shape, a real *_test.go / .test.ts / test_*.py file colocated with the source; for source-grep, a small shell script; for log-line/behavior-check, a script that drives the code path. Write the harness with write_file, run it with run_shell.
- The baseline harness MUST fail on the unpatched worktree. If it passes (exit 0), your assertion is refuted — the bug does not exist. Stop and re-investigate; do not emit a plan for a bug that isn't real.
- The baseline failure must be of the asserted kind, not an unrelated error. A harness that fails with "file not found" when the asserted bug is "function returns wrong value" is NOT proof — it's noise. Read the failure output and confirm it matches your assertion before emitting.
- Do NOT write any fix. Your job ends at emit_plan_source. The Worker applies the fix.

STOPPING RULE — CRITICAL:
By loop 22, you must have the assertion AND a failing harness with the failure output captured. Call emit_plan_source IMMEDIATELY once you have those. The reproduce step expanded the loop budget — don't waste it on extra investigation after the harness fails the right way.
`;

export async function runPlannerSource(
  issueSpec: { title: string; body: string },
  opts: LLMRunOptions
): Promise<EmitPlanSourceResult> {
  const parts = [
    `Issue: ${issueSpec.title}`,
    `Description: ${issueSpec.body}`
  ];
  if (opts.sourceDir) parts.push(`Source directory: ${opts.sourceDir}`);
  if (opts.snapshotDir) parts.push(`Snapshot directory (may be empty/irrelevant in source mode): ${opts.snapshotDir}`);
  if (opts.workDir) parts.push(`Work directory: ${opts.workDir}`);

  // Source planner gets write_file + run_shell so it can write a harness and
  // run it against the unpatched worktree — required by the reproduce gate.
  const sourceTools: ToolDef[] = TOOLS.filter((t) =>
    ["read_file", "search_code", "list_snapshot_dir", "read_rrpair", "write_file", "run_shell", "emit_plan_source"].includes(t.name)
  );

  const PLANNER_MAX_LOOPS = parseInt(process.env.ENGINE_PLANNER_MAX_LOOPS ?? "30", 10);
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? defaultModelFor(provider);
  const result = await agentLoop(
    PLANNER_SOURCE_SYSTEM,
    parts.join("\n"),
    "emit_plan_source",
    opts.verbose ?? false,
    PLANNER_MAX_LOOPS,
    provider,
    model,
    sourceTools
  );

  const shape = (result.assertionShape ?? "unit-test") as EmitPlanSourceResult["assertionShape"];

  // Reproduce gate: the Planner attested that the bug reproduces today. Verify
  // the evidence is coherent (non-zero exit, harness path present) before
  // letting the Worker burn time on a non-existent bug.
  const baselineEvidence: BaselineEvidence = {
    harnessPath: (result.baselineHarnessPath ?? "") as string,
    exitCode: Number((result as unknown as { baselineExitCode: number }).baselineExitCode),
    output: (result.baselineOutput ?? "") as string
  };
  const validation = validateBaselineEvidence(baselineEvidence);
  if (!validation.ok) {
    throw new Error(
      `source-mode reproduce gate rejected the plan: ${validation.reason}\n\n` +
      `Planner's failing assertion: ${result.failingAssertion}\n` +
      `Planner's baseline harness path: ${baselineEvidence.harnessPath || "(missing)"}\n` +
      `Planner's baseline exit code: ${baselineEvidence.exitCode}\n` +
      `Planner's baseline output (truncated):\n${baselineEvidence.output.slice(0, 500)}`
    );
  }

  const plan: AgentPlan = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentPlan",
    metadata: { name: `plan-source-${Date.now()}` },
    spec: {
      runRef: { name: "llm-run" },
      summary: result.summary,
      hypothesis: result.hypothesis,
      steps: [
        { id: "reproduce", action: "inspect", description: `Reproduced: ${baselineEvidence.harnessPath} (exit ${baselineEvidence.exitCode})` },
        { id: "fix", action: "edit", description: `Fix ${result.targetFunction} in ${result.targetFile}` },
        { id: "confirm", action: "validate", description: `Re-run ${baselineEvidence.harnessPath} (must pass)` },
        { id: "report", action: "inspect", description: "Emit QualityReport" }
      ],
      validation: {
        command: baselineEvidence.harnessPath,
        successCriteria: `Harness ${baselineEvidence.harnessPath} exits 0 after the fix`
      }
    }
  };

  return {
    plan,
    failingAssertion: result.failingAssertion,
    assertionShape: shape,
    rationale: result.rationale,
    baselineEvidence
  };
}

// ---------- Source-mode Worker ----------

const WORKER_SOURCE_SYSTEM = `You are the Worker for the Speedscale Agent Factory, running in SOURCE mode.

You have received a plan from the source-mode Planner. The plan names a "failing assertion" — a concrete statement that is FALSE about today's code and must be TRUE after your fix. The Planner has ALREADY:
- Written a harness at the path given as "Baseline harness path"
- Run that harness against the unpatched worktree, observing a non-zero exit (the bug reproduces)

Your job is to:
1. Read the target source file (use the worktree paths if the input gives them).
2. Read the Planner's baseline harness so you understand exactly what the post-fix assertion looks like. Do NOT modify it. The harness IS the contract.
3. Write the minimal fix to the target file so that re-running the SAME harness passes (exit 0).
4. Run the Planner's harness via run_shell — same path, same command. The exit code MUST be 0 after your fix.
5. Call emit_patch with the fix, the harness path (must match what the Planner wrote), and the harness output.

Rules:
- The harness was written by the Planner. Use it as-is. If you find a bug IN the harness, that means the Planner's reproduce step was bogus — abort by re-emitting a Worker note rather than silently rewriting the harness.
- Use write_file to apply the minimal fix to the TARGET file (the source file under test). No cleanup, no refactoring beyond the fix.
- Re-run the same harness command the Planner used. For unit-test shape: \`go test -run <PlannerWroteThisTest> ./<pkg>...\` or \`npx tsx --test <path>\` — whichever the Planner ran. The command is in the plan's "Baseline harness path" field; if the Planner stored only a script path, invoke that script directly.
- The confirm result must show exit 0. If the harness still fails, read the output, fix the issue in the source, re-run. Do not emit_patch until the harness passes.
- Do NOT delete unrelated code in the target file. write_file overwrites the whole file — preserve every function, import, and declaration that existed before. Only the lines your fix changes may be modified.
`;

export async function runWorkerSource(
  planResult: EmitPlanSourceResult,
  opts: LLMRunOptions
): Promise<EmitPatchResult> {
  let worktree: WorktreeResult | undefined;

  if (opts.repoDir && opts.branchName && opts.sourceDir && opts.workDir) {
    worktree = await setupWorktree(opts.repoDir, opts.workDir, opts.branchName, opts.sourceDir);
    console.log(`[engine] worktree: ${worktree.worktreePath} (branch: ${worktree.branchName})`);
  }

  const effectiveSourceDir = worktree?.sourceDir ?? opts.sourceDir;

  function remapPaths(s: string): string {
    if (!worktree || !opts.sourceDir) return s;
    return s.replaceAll(opts.sourceDir, worktree.sourceDir);
  }

  const parts = [
    `Plan summary: ${remapPaths(planResult.plan.spec.summary)}`,
    `Hypothesis: ${remapPaths(planResult.plan.spec.hypothesis)}`,
    `Failing assertion (FALSE today, must be TRUE after fix): ${planResult.failingAssertion}`,
    `Assertion shape: ${planResult.assertionShape}`,
    `Target file: ${remapPaths(planResult.plan.spec.steps.find((s) => s.action === "edit")?.description ?? "")}`,
    `Rationale from Planner: ${remapPaths(planResult.rationale)}`,
    ``,
    `=== Baseline reproduce evidence (from Planner) ===`,
    `Harness path: ${remapPaths(planResult.baselineEvidence.harnessPath)}`,
    `Baseline exit code (unpatched): ${planResult.baselineEvidence.exitCode} (non-zero = bug reproduces today)`,
    `Baseline output (truncated):`,
    planResult.baselineEvidence.output.slice(0, 2000),
    ``,
    `Re-run this exact harness after applying your fix. It MUST exit 0. Do not rewrite the harness — it is the contract you must satisfy.`
  ];
  if (effectiveSourceDir) parts.push(`Source directory: ${effectiveSourceDir}`);
  if (opts.workDir) parts.push(`Work directory: ${opts.workDir}`);
  if (worktree) {
    parts.push(
      `WORKTREE: Source files are in an isolated worktree at ${worktree.worktreePath}. ` +
      `For ALL read_file and write_file calls that touch source code, use paths under ${worktree.sourceDir}. ` +
      `Do NOT read from or write to ${opts.sourceDir} — that directory is off-limits for this run.`
    );
  }

  const WORKER_MAX_LOOPS = parseInt(process.env.ENGINE_WORKER_MAX_LOOPS ?? "25", 10);
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? defaultModelFor(provider);
  const result = await agentLoop(
    WORKER_SOURCE_SYSTEM,
    parts.join("\n"),
    "emit_patch",
    opts.verbose ?? false,
    WORKER_MAX_LOOPS,
    provider,
    model
  );

  return {
    filePath: result.targetFile,
    patch: result.patch,
    rationale: result.rationale,
    harnessPath: result.harnessPath,
    confirmResult: result.confirmResult,
    worktreePath: worktree?.worktreePath,
    branchName: worktree?.branchName,
  };
}
