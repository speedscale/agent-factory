import { resolveFromRepo } from "./io.js";
import { listRuns } from "./run-admin.js";

export type RunQueueBackend = "filesystem" | "redis";

export interface RunQueue {
  backend: RunQueueBackend;
  listQueuedRuns(): Promise<string[]>;
}

class FileSystemRunQueue implements RunQueue {
  readonly backend: RunQueueBackend = "filesystem";

  constructor(private readonly artifactsRoot: string) {}

  async listQueuedRuns(): Promise<string[]> {
    if (!this.artifactsRoot) {
      return [];
    }

    const runs = await listRuns("queued");
    return runs.map((run) => run.metadata.name);
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
