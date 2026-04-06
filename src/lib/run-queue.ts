import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentRun } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo } from "./io.js";

export type RunQueueBackend = "filesystem" | "redis";

export interface RunQueue {
  backend: RunQueueBackend;
  listQueuedRuns(): Promise<string[]>;
}

class FileSystemRunQueue implements RunQueue {
  readonly backend: RunQueueBackend = "filesystem";

  constructor(private readonly artifactsRoot: string) {}

  async listQueuedRuns(): Promise<string[]> {
    let entries: string[] = [];

    try {
      entries = await readdir(this.artifactsRoot);
    } catch {
      return [];
    }

    const queued: string[] = [];

    for (const entry of entries) {
      const runJsonPath = path.join(this.artifactsRoot, entry, "run.json");

      try {
        const run = await readJsonFile<AgentRun>(runJsonPath);
        if (run.status.phase === "queued") {
          queued.push(run.metadata.name);
        }
      } catch {
        continue;
      }
    }

    queued.sort((a, b) => a.localeCompare(b));
    return queued;
  }
}

class RedisRunQueue implements RunQueue {
  readonly backend: RunQueueBackend = "redis";

  constructor(private readonly redisUrl: string | undefined) {}

  async listQueuedRuns(): Promise<string[]> {
    const target = this.redisUrl ?? "(unset REDIS_URL)";
    throw new Error(`redis run queue backend is not implemented yet (target: ${target})`);
  }
}

export function createRunQueueFromEnv(): RunQueue {
  const backend = (process.env.RUN_QUEUE_BACKEND ?? "filesystem").toLowerCase();

  if (backend === "filesystem") {
    return new FileSystemRunQueue(resolveFromRepo("artifacts"));
  }

  if (backend === "redis") {
    return new RedisRunQueue(process.env.REDIS_URL);
  }

  throw new Error(`unsupported RUN_QUEUE_BACKEND: ${backend}`);
}
