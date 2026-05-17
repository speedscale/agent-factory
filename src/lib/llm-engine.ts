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

import Anthropic from "@anthropic-ai/sdk";
import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { AgentPlan } from "../contracts/index.js";

const execAsync = promisify(exec);

// Prefer ANTHROPIC_API_KEY; fall back to the workspace's alternate var name.
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_DO_NOT_USE;
const MODEL = "claude-sonnet-4-6";
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

export interface LLMRunOptions {
  snapshotDir?: string;
  sourceDir?: string;
  workDir?: string;
  verbose?: boolean;
  /** Absolute path to the git repo root. When set, Worker creates a worktree before writing any files. */
  repoDir?: string;
  /** Branch name for the worktree, e.g. "agent/s-10886-radar-perf". Required when repoDir is set. */
  branchName?: string;
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

const client = new Anthropic({ apiKey });

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
  try {
    const { stdout } = await execAsync(
      `grep -rEn --include="*.js" --include="*.ts" --include="*.mjs" -m 50 ${JSON.stringify(pattern)} ${JSON.stringify(dir)} 2>/dev/null || true`
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

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a source file from disk. Use absolute paths.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute path to the file" } },
      required: ["path"]
    }
  },
  {
    name: "search_code",
    description: "Grep for a pattern across JS/TS source files in a directory.",
    input_schema: {
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
    input_schema: {
      type: "object" as const,
      properties: { dir: { type: "string", description: "Absolute path to the snapshot directory (the inner one containing host subdirs)" } },
      required: ["dir"]
    }
  },
  {
    name: "read_rrpair",
    description: "Read a single RRPair markdown file from a snapshot. Shows request + response.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute path to the .md RRPair file" } },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file. Use this to produce test harnesses or patch files.",
    input_schema: {
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
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute path to the .mjs or .js script to run" } },
      required: ["path"]
    }
  },
  {
    name: "emit_plan",
    description: "Terminal tool: emit the structured AgentPlan. Call this when you have identified the bug metric, confirmed it is reproducible, and have a hypothesis. This ends the Planner phase.",
    input_schema: {
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
    input_schema: {
      type: "object" as const,
      properties: {
        targetFile: { type: "string", description: "Absolute path of the file that was patched" },
        patch: { type: "string", description: "The actual code change as a unified diff or the new function body" },
        rationale: { type: "string", description: "Why this fix addresses the root cause" },
        confirmResult: { type: "string", description: "Output of running the confirm harness against the patched code" }
      },
      required: ["targetFile", "patch", "rationale"]
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
  maxLoops: number = MAX_LOOPS
): Promise<Record<string, string>> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
  let loops = 0;
  // Inject a "you must emit now" nudge when 80% of budget is used
  const nudgeAt = Math.floor(maxLoops * 0.8);
  let nudgeSent = false;

  while (loops < maxLoops) {
    loops++;
    if (verbose) console.error(`[engine] loop ${loops}/${maxLoops}`);

    // Inject a forced-emit nudge into the message stream at 80% of loop budget
    if (loops === nudgeAt && !nudgeSent) {
      nudgeSent = true;
      messages.push({
        role: "user",
        content: `[SYSTEM] You have used ${loops} of ${maxLoops} allowed loops. You MUST call ${terminalToolName} now with whatever findings you have. Do not read any more files or call any other tools first.`
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: TOOLS,
      messages
    });

    if (verbose) console.error(`[engine] stop_reason=${response.stop_reason}`);

    // Collect all tool calls in this response
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");

    if (verbose && textBlocks.length > 0) {
      console.error(`[engine] ${textBlocks.map((b) => b.text.slice(0, 200)).join(" ")}`);
    }

    // Check if the terminal tool was called
    const terminal = toolUses.find((t) => t.name === terminalToolName);
    if (terminal) {
      if (verbose) console.error(`[engine] terminal tool called: ${terminalToolName}`);
      return terminal.input as Record<string, string>;
    }

    if (response.stop_reason === "end_turn" && toolUses.length === 0) {
      // LLM finished without calling the terminal tool — shouldn't happen with good prompts
      throw new Error(`agent stopped without calling ${terminalToolName}`);
    }

    // Add assistant turn to history
    messages.push({ role: "assistant", content: response.content });

    // Execute all non-terminal tool calls and add results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === terminalToolName) continue;
      if (verbose) console.error(`[engine] tool: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await dispatchTool(toolUse.name, toolUse.input as Record<string, string>);
      if (verbose) console.error(`[engine] result: ${result.slice(0, 150)}`);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
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
  const result = await agentLoop(PLANNER_SYSTEM, parts.join("\n"), "emit_plan", opts.verbose ?? false, PLANNER_MAX_LOOPS);

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
  const result = await agentLoop(WORKER_SYSTEM, parts.join("\n"), "emit_patch", opts.verbose ?? false, WORKER_MAX_LOOPS);

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
