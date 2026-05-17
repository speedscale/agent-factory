/**
 * llm-run — end-to-end LLM engine spike.
 *
 * Runs the Planner → Worker loop using the Claude Agent SDK against a real
 * snapshot and source directory. This is the engine spike from §14 item 6.
 *
 * Usage:
 *   npm run llm-run -- \
 *     --title "Gmail sync getting 429 errors" \
 *     --body  "The radar service Gmail sync intermittently fails with 429 Too Many Requests from gmail.googleapis.com" \
 *     --snapshot /path/to/snapshot/inner-dir \
 *     --source  /path/to/service/src \
 *     --repo    /path/to/service           (git repo root — enables worktree isolation) \
 *     --branch  agent/s-10886-radar-perf   (branch name; derived from --title if omitted) \
 *     --workdir /tmp/llm-run-work \
 *     [--verbose]
 *
 * When --repo is provided, the Worker creates a git worktree at <workdir>/repo
 * on a new branch before writing any files. The fix is committed to that branch.
 * The main checkout is never modified.
 *
 * Measures:
 *   - Time to first useful plan (Planner phase)
 *   - Fix produced (Worker phase)
 *   - Confirm result (Worker phase)
 */

import path from "node:path";
import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runPlanner, runWorker } from "../lib/llm-engine.js";

const execAsync = promisify(exec);

const MR_CHECKLIST = `
## Checklist

Each of these checkboxes should be filled before merge.

- [ ] Security impact of change has been considered
- [ ] Code follows company security practices and guidelines
- [ ] Pull request linked to task tracker
- [ ] If this is a breaking change a story has been created and assigned to Ken
`;

function getArg(argv: string[], flags: string[]): string | undefined {
  const i = argv.findIndex((v) => flags.includes(v));
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], flags: string[]): boolean {
  return argv.some((v) => flags.includes(v));
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const title = getArg(argv, ["--title", "-t"]) ?? "Service is returning unexpected errors";
  const body = getArg(argv, ["--body", "-b"]) ?? "Investigate and fix the root cause.";
  const snapshotDir = getArg(argv, ["--snapshot", "-s"]);
  const sourceDir = getArg(argv, ["--source"]);
  const repoDir = getArg(argv, ["--repo", "-r"]);
  const branchName = getArg(argv, ["--branch"]) ?? (repoDir ? `agent/${slugify(title)}` : undefined);
  const workDir = getArg(argv, ["--workdir", "-w"]) ?? path.join(process.cwd(), ".llm-run-work");
  const verbose = hasFlag(argv, ["--verbose", "-v"]);

  if (!snapshotDir) {
    console.error("usage: llm-run --snapshot <dir> [--source <dir>] [--repo <dir>] [--branch <name>] [--title <str>] [--body <str>] [--workdir <dir>] [--verbose]");
    process.exit(1);
  }

  await mkdir(workDir, { recursive: true });

  console.log(JSON.stringify({ phase: "start", title, snapshotDir, sourceDir, repoDir, branchName, workDir }, null, 2));

  // ---- Planner phase ----
  const plannerStart = Date.now();
  console.log("\n=== PLANNER PHASE ===");

  const planResult = await runPlanner(
    { title, body },
    { snapshotDir, sourceDir, workDir, verbose }
  );

  const plannerMs = Date.now() - plannerStart;
  const planOutput = path.join(workDir, "plan.json");
  await writeFile(planOutput, JSON.stringify(planResult, null, 2), "utf8");

  console.log(JSON.stringify({
    phase: "planned",
    durationMs: plannerMs,
    summary: planResult.plan.spec.summary,
    hypothesis: planResult.plan.spec.hypothesis,
    metric: planResult.metric,
    baseline: planResult.baseline,
    planFile: planOutput
  }, null, 2));

  // ---- Worker phase ----
  const workerStart = Date.now();
  console.log("\n=== WORKER PHASE ===");

  const patchResult = await runWorker(
    planResult,
    { snapshotDir, sourceDir, workDir, verbose, repoDir, branchName }
  );

  const workerMs = Date.now() - workerStart;
  const patchOutput = path.join(workDir, "patch.json");
  await writeFile(patchOutput, JSON.stringify(patchResult, null, 2), "utf8");

  console.log(JSON.stringify({
    phase: "patched",
    durationMs: workerMs,
    targetFile: patchResult.filePath,
    worktreePath: patchResult.worktreePath,
    branchName: patchResult.branchName,
    harnessPath: patchResult.harnessPath,
    confirmResult: patchResult.confirmResult,
    patchFile: patchOutput
  }, null, 2));

  // ---- Auto MR creation ----
  let mrUrl: string | undefined;
  if (patchResult.worktreePath && patchResult.branchName && repoDir) {
    console.log("\n=== CREATING MR ===");
    try {
      const mrBody = [
        `## Summary\n\n${patchResult.rationale}`,
        `## Confirm harness\n\n\`\`\`\n${patchResult.confirmResult ?? "(not run)"}\n\`\`\``,
        `## Test plan\n\n- [ ] Review confirm harness output above\n- [ ] Deploy to staging and verify metric improvement`,
        MR_CHECKLIST,
        `🤖 Generated with [Agent Factory](https://github.com/speedscale/agent-factory)`
      ].join("\n\n");

      const mrTitle = title.length > 70 ? title.slice(0, 67) + "..." : title;
      const { stdout } = await execAsync(
        `cd ${JSON.stringify(patchResult.worktreePath)} && glab mr create --title ${JSON.stringify(mrTitle)} --description ${JSON.stringify(mrBody)} --source-branch ${JSON.stringify(patchResult.branchName)} --no-editor 2>&1 || gh pr create --title ${JSON.stringify(mrTitle)} --body ${JSON.stringify(mrBody)} --head ${JSON.stringify(patchResult.branchName)} 2>&1`
      );
      mrUrl = stdout.trim().split("\n").find(l => l.startsWith("http")) ?? stdout.trim();
      console.log(`MR created: ${mrUrl}`);
    } catch (err) {
      console.warn(`MR creation failed (create manually): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({
    plannerMs,
    workerMs,
    totalMs: plannerStart + plannerMs + workerMs - plannerStart,
    metric: planResult.metric,
    baseline: planResult.baseline,
    fix: patchResult.rationale,
    confirmResult: patchResult.confirmResult ?? "(not run)",
    mrUrl: mrUrl ?? "(not created)"
  }, null, 2));
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`llm-run failed: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
