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
 *     --workdir /tmp/llm-run-work \
 *     [--verbose]
 *
 * Measures:
 *   - Time to first useful plan (Planner phase)
 *   - Fix produced (Worker phase)
 *   - Confirm result (Worker phase)
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runPlanner, runWorker } from "../lib/llm-engine.js";

function getArg(argv: string[], flags: string[]): string | undefined {
  const i = argv.findIndex((v) => flags.includes(v));
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], flags: string[]): boolean {
  return argv.some((v) => flags.includes(v));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const title = getArg(argv, ["--title", "-t"]) ?? "Service is returning unexpected errors";
  const body = getArg(argv, ["--body", "-b"]) ?? "Investigate and fix the root cause.";
  const snapshotDir = getArg(argv, ["--snapshot", "-s"]);
  const sourceDir = getArg(argv, ["--source"]);
  const workDir = getArg(argv, ["--workdir", "-w"]) ?? path.join(process.cwd(), ".llm-run-work");
  const verbose = hasFlag(argv, ["--verbose", "-v"]);

  if (!snapshotDir) {
    console.error("usage: llm-run --snapshot <dir> [--source <dir>] [--title <str>] [--body <str>] [--workdir <dir>] [--verbose]");
    process.exit(1);
  }

  await mkdir(workDir, { recursive: true });

  console.log(JSON.stringify({ phase: "start", title, snapshotDir, sourceDir, workDir }, null, 2));

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
    { snapshotDir, sourceDir, workDir, verbose }
  );

  const workerMs = Date.now() - workerStart;
  const patchOutput = path.join(workDir, "patch.json");
  await writeFile(patchOutput, JSON.stringify(patchResult, null, 2), "utf8");

  console.log(JSON.stringify({
    phase: "patched",
    durationMs: workerMs,
    targetFile: patchResult.filePath,
    harnessPath: patchResult.harnessPath,
    confirmResult: patchResult.confirmResult,
    patchFile: patchOutput
  }, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({
    plannerMs,
    workerMs,
    totalMs: plannerStart + plannerMs + workerMs - plannerStart,
    metric: planResult.metric,
    baseline: planResult.baseline,
    fix: patchResult.rationale,
    confirmResult: patchResult.confirmResult ?? "(not run)"
  }, null, 2));
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`llm-run failed: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
