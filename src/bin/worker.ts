import { open, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { buildPlan, loadPlannerContext, writePlanArtifact } from "../lib/planner.js";
import { loadRunnerContext, runBuildStage } from "../lib/runner.js";
import { loadValidatorContext, runValidationStage } from "../lib/validator.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "../lib/io.js";
import { createRunQueueFromEnv, type RunQueue } from "../lib/run-queue.js";
import { RUN_CLAIM_FILENAME } from "../lib/run-admin.js";
import { writeRunResultArtifact } from "../lib/run-result.js";
import type { AgentRun } from "../contracts/index.js";

interface WorkerOptions {
  sourceDir?: string;
  once: boolean;
  pollMs: number;
  claimTtlMs: number;
}

interface WorkerMetrics {
  queueBackend: RunQueue["backend"];
  startedAt: string;
  pollMs: number;
  loops: number;
  batchesWithRuns: number;
  lastBatchSize: number;
  runsProcessed: number;
  runsFailed: number;
  runClaimsSkipped: number;
  lastRun?: string;
  lastRunAt?: string;
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

  const nextRun: AgentRun = {
    ...run,
    status: {
      ...run.status,
      phase,
      summary
    }
  };

  await writeJsonFile(runJsonPath, nextRun);

  if (phase === "failed" || phase === "succeeded") {
    await writeRunResultArtifact(nextRun);
  }
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

function startWorkerMetricsServer(metrics: WorkerMetrics): Server | undefined {
  const metricsPortRaw = process.env.WORKER_METRICS_PORT;
  if (!metricsPortRaw) {
    return undefined;
  }

  const port = Number(metricsPortRaw);
  if (!Number.isFinite(port) || port <= 0 || !Number.isInteger(port)) {
    throw new Error("WORKER_METRICS_PORT must be a positive integer");
  }

  const server = createServer((req, res) => {
    const path = req.url ?? "/";

    if (req.method === "GET" && path === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(`${JSON.stringify({ ok: true, service: "worker" }, null, 2)}\n`);
      return;
    }

    if (req.method === "GET" && path === "/metrics") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(`${JSON.stringify({ service: "worker", generatedAt: new Date().toISOString(), metrics }, null, 2)}\n`);
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(`${JSON.stringify({ error: "not found" }, null, 2)}\n`);
  });

  server.listen(port, () => {
    console.log(`worker metrics listening on http://localhost:${port}`);
  });

  return server;
}

async function stopWorkerMetricsServer(server?: Server): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function runWorker(queue: RunQueue, options: WorkerOptions): Promise<void> {
  const metrics: WorkerMetrics = {
    queueBackend: queue.backend,
    startedAt: new Date().toISOString(),
    pollMs: options.pollMs,
    loops: 0,
    batchesWithRuns: 0,
    lastBatchSize: 0,
    runsProcessed: 0,
    runsFailed: 0,
    runClaimsSkipped: 0
  };

  const metricsServer = startWorkerMetricsServer(metrics);

  console.log(JSON.stringify({ message: "worker started", queueBackend: queue.backend }, null, 2));
  const useFilesystemClaim = queue.backend === "filesystem";

  try {
    while (true) {
      metrics.loops += 1;
      const queuedRuns = await queue.listQueuedRuns();
      metrics.lastBatchSize = queuedRuns.length;
      if (queuedRuns.length > 0) {
        metrics.batchesWithRuns += 1;
      }

      if (queuedRuns.length === 0) {
        if (options.once) {
          console.log(JSON.stringify({ message: "no queued runs found" }, null, 2));
          return;
        }

        await sleep(options.pollMs);
        continue;
      }

      for (const runName of queuedRuns) {
        if (useFilesystemClaim) {
          const claimed = await tryClaimRun(runName, options.claimTtlMs);
          if (!claimed) {
            metrics.runClaimsSkipped += 1;
            continue;
          }
        }

        try {
          await processRun(runName, options.sourceDir);
          metrics.runsProcessed += 1;
          metrics.lastRun = runName;
          metrics.lastRunAt = new Date().toISOString();
          console.log(JSON.stringify({ message: "run processed", run: runName }, null, 2));
        } catch (error) {
          metrics.runsFailed += 1;
          metrics.lastRun = runName;
          metrics.lastRunAt = new Date().toISOString();
          const message = error instanceof Error ? error.message : "run processing failed";
          await updateRun(runName, "failed", message);
          console.error(JSON.stringify({ message: "run failed", run: runName, error: message }, null, 2));
        } finally {
          if (useFilesystemClaim) {
            await releaseClaim(runName);
          }
        }
      }

      if (options.once) {
        return;
      }
    }
  } finally {
    await stopWorkerMetricsServer(metricsServer);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const queue = createRunQueueFromEnv();

  try {
    await runWorker(queue, options);
  } finally {
    await queue.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "worker failed";
  console.error(message);
  process.exitCode = 1;
});
