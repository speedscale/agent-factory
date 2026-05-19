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
2. For each requirement, decide whether the patch reflects it. Use read_file on the patched source and search_code to verify. The patch field in the input shows what changed, but check the file directly — agents sometimes describe a change differently than the actual diff.
3. Read the confirm harness (if a path was provided) and decide whether it actually exercises the metric named in the plan. A harness that "passes" by checking string equality on a hardcoded value, or by reading the source rather than running it, is NOT trustworthy.
4. Call emit_eval_report with your findings.

Rules:
- You have READ-ONLY tools. Do not modify any files.
- Be strict about missed requirements. If the spec says "add a --dry-run flag" and you can't find a --dry-run flag in the patch or source, that's a missed requirement, not a "minor gap."
- "pass" verdict requires ALL spec requirements addressed AND confirm harness trustworthy.
- "partial" = core fix landed but some requirements missing OR harness is weak (e.g. mocks the thing being tested).
- "fail" = the core fix doesn't address the central bug, or the patch is plainly wrong.
- Do not call emit_eval_report until you have actually read the patched source file.

STOPPING RULE:
By loop 15, emit the report with whatever findings you have. Do not keep exploring once the question is answered.
`;

export async function runEvaluator(
  issueSpec: { title: string; body: string },
  planResult: EmitPlanResult,
  patchResult: EmitPatchResult,
  opts: LLMRunOptions
): Promise<EmitEvalReportResult> {
  // Read-only subset of tools — no write_file, no run_script.
  const evalTools: ToolDef[] = TOOLS.filter((t) =>
    ["read_file", "search_code", "list_snapshot_dir", "read_rrpair", "emit_eval_report"].includes(t.name)
  );

  const parts = [
    `=== Original spec ===`,
    `Title: ${issueSpec.title}`,
    `Body:`,
    issueSpec.body,
    ``,
    `=== Planner output ===`,
    `Summary: ${planResult.plan.spec.summary}`,
    `Hypothesis: ${planResult.plan.spec.hypothesis}`,
    `Metric: ${planResult.metric}`,
    `Baseline: ${planResult.baseline}`,
    `Rationale: ${planResult.rationale}`,
    ``,
    `=== Worker output ===`,
    `Target file: ${patchResult.filePath}`,
    `Patch (as reported by Worker):`,
    patchResult.patch,
    `Rationale: ${patchResult.rationale}`,
    patchResult.harnessPath ? `Confirm harness path: ${patchResult.harnessPath}` : `Confirm harness path: (not provided)`,
    `Confirm result (Worker self-report):`,
    patchResult.confirmResult ?? "(none)"
  ];

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
