import { resolveFromRepo } from "./io.js";
import { listRuns } from "./run-admin.js";
import { createClient } from "redis";

export type RunQueueBackend = "filesystem" | "redis";

export interface RunQueue {
  backend: RunQueueBackend;
  enqueueRun(runName: string): Promise<void>;
  listQueuedRuns(): Promise<string[]>;
  getQueueDepth(): Promise<number>;
  close(): Promise<void>;
}

class FileSystemRunQueue implements RunQueue {
  readonly backend: RunQueueBackend = "filesystem";

  constructor(private readonly artifactsRoot: string) {}

  async enqueueRun(_runName: string): Promise<void> {
    // Filesystem backend discovers queued runs from run.json phase.
  }

  async listQueuedRuns(): Promise<string[]> {
    if (!this.artifactsRoot) {
      return [];
    }

    const runs = await listRuns("queued");
    return runs.map((run) => run.metadata.name);
  }

  async getQueueDepth(): Promise<number> {
    const runs = await listRuns("queued");
    return runs.length;
  }

  async close(): Promise<void> {
    // no-op for filesystem backend
  }
}

class RedisRunQueue implements RunQueue {
  readonly backend: RunQueueBackend = "redis";
  private client?: ReturnType<typeof createClient>;

  constructor(
    private readonly redisUrl: string | undefined,
    private readonly key: string,
    private readonly batchSize: number
  ) {}

  private async getClient(): Promise<ReturnType<typeof createClient>> {
    if (this.client) {
      return this.client;
    }

    if (!this.redisUrl || this.redisUrl.trim().length === 0) {
      throw new Error("REDIS_URL must be set when RUN_QUEUE_BACKEND=redis");
    }

    const client = createClient({
      url: this.redisUrl
    });

    client.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : "redis client error";
      console.error(`redis queue error: ${message}`);
    });

    await client.connect();
    this.client = client;
    return client;
  }

  async enqueueRun(runName: string): Promise<void> {
    const client = await this.getClient();
    await client.rPush(this.key, runName);
  }

  async listQueuedRuns(): Promise<string[]> {
    const client = await this.getClient();
    const queuedRuns: string[] = [];

    for (let index = 0; index < this.batchSize; index += 1) {
      const runName = await client.lPop(this.key);
      if (!runName) {
        break;
      }

      queuedRuns.push(runName);
    }

    return queuedRuns;
  }

  async getQueueDepth(): Promise<number> {
    const client = await this.getClient();
    return await client.lLen(this.key);
  }

  async close(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.quit();
    this.client = undefined;
  }
}

export function createRunQueueFromEnv(): RunQueue {
  const backend = (process.env.RUN_QUEUE_BACKEND ?? "filesystem").toLowerCase();

  if (backend === "filesystem") {
    return new FileSystemRunQueue(resolveFromRepo("artifacts"));
  }

  if (backend === "redis") {
    const key = process.env.REDIS_QUEUE_KEY ?? "agent-factory:runs:queued";
    const batchSizeRaw = Number(process.env.RUN_QUEUE_BATCH_SIZE ?? "25");

    if (!Number.isFinite(batchSizeRaw) || batchSizeRaw <= 0) {
      throw new Error("RUN_QUEUE_BATCH_SIZE must be a positive integer");
    }

    return new RedisRunQueue(process.env.REDIS_URL, key, Math.floor(batchSizeRaw));
  }

  throw new Error(`unsupported RUN_QUEUE_BACKEND: ${backend}`);
}
