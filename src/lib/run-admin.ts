import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { AgentRun, AgentRunPhase } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "./io.js";

export const RUN_CLAIM_FILENAME = "worker.claim";

function resolveRunJsonPath(runName: string): string {
  return resolveFromRepo("artifacts", runName, "run.json");
}

function resolveRunClaimPath(runName: string): string {
  return resolveFromRepo("artifacts", runName, RUN_CLAIM_FILENAME);
}

export async function loadRun(runName: string): Promise<AgentRun> {
  return await readJsonFile<AgentRun>(resolveRunJsonPath(runName));
}

export async function writeRun(runName: string, run: AgentRun): Promise<void> {
  await writeJsonFile(resolveRunJsonPath(runName), run);
}

export async function listRuns(filterPhase?: AgentRunPhase): Promise<AgentRun[]> {
  const artifactsRoot = resolveFromRepo("artifacts");
  let entries: string[] = [];

  try {
    entries = await readdir(artifactsRoot);
  } catch {
    return [];
  }

  const runs: AgentRun[] = [];

  for (const entry of entries) {
    const runJsonPath = path.join(artifactsRoot, entry, "run.json");

    try {
      const run = await readJsonFile<AgentRun>(runJsonPath);
      if (!filterPhase || run.status.phase === filterPhase) {
        runs.push(run);
      }
    } catch {
      continue;
    }
  }

  runs.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return runs;
}

export async function requeueRun(runName: string, force = false): Promise<AgentRun> {
  const run = await loadRun(runName);

  if (!force && run.status.phase !== "failed") {
    throw new Error(`run ${runName} is in phase '${run.status.phase}', expected 'failed' (use --force to override)`);
  }

  const nextRun: AgentRun = {
    ...run,
    status: {
      ...run.status,
      phase: "queued",
      summary: "Manually requeued by operator."
    }
  };

  await writeRun(runName, nextRun);

  try {
    await unlink(resolveRunClaimPath(runName));
  } catch {
    // no-op
  }

  return nextRun;
}
