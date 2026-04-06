import { open, stat, unlink } from "node:fs/promises";
import { buildPlan, loadPlannerContext, writePlanArtifact } from "../lib/planner.js";
import { loadRunnerContext, runBuildStage } from "../lib/runner.js";
import { loadValidatorContext, runValidationStage } from "../lib/validator.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "../lib/io.js";
import { createRunQueueFromEnv, type RunQueue } from "../lib/run-queue.js";
import { RUN_CLAIM_FILENAME } from "../lib/run-admin.js";
import type { AgentRun } from "../contracts/index.js";

interface WorkerOptions {
  sourceDir?: string;
  once: boolean;
  pollMs: number;
  claimTtlMs: number;
}

function getArg(argv: string[], flagNames: string[]): string | undefined {
  const index = argv.findIndex((value) => flagNames.includes(value));
  if (index >= 0 && typeof argv[index + 1] === "string") {
    return argv[index + 1];
  }

  return undefined;
}

function hasFlag(argv: string[], flagNames: string[]): boolean {
  return argv.some((value) => flagNames.includes(value));
}

function resolveRunJsonPath(runName: string): string {
  return resolveFromRepo("artifacts", runName, "run.json");
}

function resolveRunClaimPath(runName: string): string {
  return resolveFromRepo("artifacts", runName, RUN_CLAIM_FILENAME);
}

async function updateRun(runName: string, phase: AgentRun["status"]["phase"], summary: string): Promise<void> {
  const runJsonPath = resolveRunJsonPath(runName);
  const run = await readJsonFile<AgentRun>(runJsonPath);

  await writeJsonFile(runJsonPath, {
    ...run,
    status: {
      ...run.status,
      phase,
      summary
    }
  });
}

async function processRun(runName: string, sourceDir?: string): Promise<void> {
  const plannerContext = await loadPlannerContext(runName);
  const plan = buildPlan(plannerContext);

  await Promise.all([
    writePlanArtifact(plannerContext.runDir, plan),
    updateRun(runName, "planned", plan.spec.summary)
  ]);

  const runnerContext = await loadRunnerContext(runName, sourceDir);
  await updateRun(runName, "building", "Preparing isolated workspace and executing build commands.");
  const buildResult = await runBuildStage(runnerContext);

  if (buildResult.run.status.phase !== "validating") {
    return;
  }

  const validatorContext = await loadValidatorContext(runName);
  await updateRun(runName, "validating", "Running proxymock validation command.");
  await runValidationStage(validatorContext);
}

async function tryClaimRun(runName: string, claimTtlMs: number): Promise<boolean> {
  const claimPath = resolveRunClaimPath(runName);
  const payload = {
    workerPid: process.pid,
    claimedAt: new Date().toISOString()
  };

  try {
    const handle = await open(claimPath, "wx");
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    const maybeFsError = error as NodeJS.ErrnoException;
    if (maybeFsError.code !== "EEXIST") {
      throw error;
    }

    if (claimTtlMs <= 0) {
      return false;
    }

    try {
      const current = await stat(claimPath);
      const ageMs = Date.now() - current.mtimeMs;
      if (ageMs < claimTtlMs) {
        return false;
      }

      await unlink(claimPath);
    } catch {
      return false;
    }

    try {
      const retryHandle = await open(claimPath, "wx");
      await retryHandle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await retryHandle.close();
      return true;
    } catch {
      return false;
    }
  }
}

async function releaseClaim(runName: string): Promise<void> {
  try {
    await unlink(resolveRunClaimPath(runName));
  } catch {
    // no-op
  }
}

function parseOptions(argv: string[]): WorkerOptions {
  const sourceDir = getArg(argv, ["--source", "-s"]);
  const once = hasFlag(argv, ["--once"]);
  const pollArg = getArg(argv, ["--poll-ms", "-p"]);
  const claimTtlArg = getArg(argv, ["--claim-ttl-ms"]);
  const pollMs = Number(pollArg ?? "2000");
  const claimTtlMs = Number(claimTtlArg ?? "900000");

  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("--poll-ms must be a positive integer");
  }

  if (!Number.isFinite(claimTtlMs) || claimTtlMs < 0) {
    throw new Error("--claim-ttl-ms must be a non-negative integer");
  }

  return {
    sourceDir,
    once,
    pollMs: Math.floor(pollMs),
    claimTtlMs: Math.floor(claimTtlMs)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker(queue: RunQueue, options: WorkerOptions): Promise<void> {
  console.log(JSON.stringify({ message: "worker started", queueBackend: queue.backend }, null, 2));

  while (true) {
    const queuedRuns = await queue.listQueuedRuns();

    if (queuedRuns.length === 0) {
      if (options.once) {
        console.log(JSON.stringify({ message: "no queued runs found" }, null, 2));
        return;
      }

      await sleep(options.pollMs);
      continue;
    }

    for (const runName of queuedRuns) {
      const claimed = await tryClaimRun(runName, options.claimTtlMs);
      if (!claimed) {
        continue;
      }

      try {
        await processRun(runName, options.sourceDir);
        console.log(JSON.stringify({ message: "run processed", run: runName }, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : "run processing failed";
        await updateRun(runName, "failed", message);
        console.error(JSON.stringify({ message: "run failed", run: runName, error: message }, null, 2));
      } finally {
        await releaseClaim(runName);
      }
    }

    if (options.once) {
      return;
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const queue = createRunQueueFromEnv();
  await runWorker(queue, options);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "worker failed";
  console.error(message);
  process.exitCode = 1;
});
