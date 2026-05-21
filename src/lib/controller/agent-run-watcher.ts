import type { AgentRun } from "../../contracts/index.js";
import { dispatchAgentRun, type DispatcherOptions } from "./agent-dispatcher.js";
import { type K8sClients, watchPath } from "./k8s.js";
import { isInProgressPhase, isTerminalPhase } from "./status-updater.js";

export interface WatcherOptions extends DispatcherOptions {
  namespace?: string;
}

type AbortableRequest = { abort: () => void };

export class AgentRunWatcher {
  private aborter: AbortableRequest | null = null;
  private stopping = false;
  private readonly opts: WatcherOptions;
  private readonly active = new Set<string>();

  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.watchOnce();
      } catch (err) {
        if (this.stopping) return;
        console.error("[watcher] watch loop error, retrying in 5s:", err);
        await sleep(5000);
      }
    }
  }

  stop(): void {
    this.stopping = true;
    this.aborter?.abort();
  }

  private async watchOnce(): Promise<void> {
    const path = watchPath("agentruns", this.opts.namespace);
    console.log(`[watcher] watching ${path}`);
    return new Promise<void>((resolve, reject) => {
      this.opts.clients.watch
        .watch(
          path,
          {},
          (phase: string, obj: unknown) => {
            const run = obj as AgentRun;
            this.handleEvent(phase, run).catch((err) => {
              console.error("[watcher] handler error:", err);
            });
          },
          (err: unknown) => {
            this.aborter = null;
            if (err) reject(err);
            else resolve();
          },
        )
        .then((req: AbortableRequest) => {
          this.aborter = req;
        })
        .catch(reject);
    });
  }

  private async handleEvent(phase: string, run: AgentRun): Promise<void> {
    if (phase !== "ADDED" && phase !== "MODIFIED") return;
    const ns = (run.metadata as { namespace?: string }).namespace ?? "default";
    const key = `${ns}/${run.metadata.name}`;

    const current = run.status?.phase;
    if (isTerminalPhase(current)) return;
    if (isInProgressPhase(current)) return;
    if (this.active.has(key)) return;

    this.active.add(key);
    try {
      await dispatchAgentRun(run, this.opts);
    } finally {
      this.active.delete(key);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
