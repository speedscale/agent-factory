import type { AgentRun } from "../../contracts/index.js";
import { dispatchAgentRun, type DispatcherOptions } from "./agent-dispatcher.js";
import { AGENTS_API_VERSION, type K8sClients, watchPath } from "./k8s.js";
import { isInProgressPhase, isTerminalPhase } from "./status-updater.js";

export interface WatcherOptions extends DispatcherOptions {
  namespace?: string;
  /**
   * How often to run a full LIST as a safety net for events the watch
   * stream may have silently dropped. Default 30s; matches typical
   * informer-pattern resync cadences.
   */
  resyncIntervalMs?: number;
}

type AbortableRequest = { abort: () => void };

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;

export class AgentRunWatcher {
  private aborter: AbortableRequest | null = null;
  private stopping = false;
  private resyncTimer: NodeJS.Timeout | null = null;
  private readonly opts: WatcherOptions;
  private readonly active = new Set<string>();

  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // Kick off the LIST-based safety net immediately and on an interval.
    // This catches any AgentRun the watch stream missed (the v1
    // @kubernetes/client-node Watch class has been observed to deliver
    // zero events on long-lived streams against minikube). Resync runs
    // independently of the watch loop, so even if the watch stays broken
    // the system still makes progress.
    void this.resyncOnce();
    const intervalMs = this.opts.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.resyncTimer = setInterval(() => {
      void this.resyncOnce();
    }, intervalMs);
    console.log(`[watcher] resync every ${intervalMs}ms`);

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
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
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
            // Diagnostic: surface every callback invocation so a silent
            // watch is distinguishable from a silent handler.
            console.log(
              `[watcher] event: ${phase} ${run.metadata?.name ?? "<unknown>"} (rv=${run.metadata?.resourceVersion ?? "?"})`,
            );
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

  /**
   * Safety-net resync: LIST every AgentRun and synthesize an ADDED event
   * for any that's not in-progress or terminal. Idempotent — the in-flight
   * `active` set prevents duplicate dispatches if the watch and the resync
   * both surface the same run.
   */
  private async resyncOnce(): Promise<void> {
    try {
      const result = await this.opts.clients.objects.list<AgentRun>(
        AGENTS_API_VERSION,
        "AgentRun",
        this.opts.namespace,
      );
      const items = result.items ?? [];
      if (items.length > 0) {
        console.log(`[watcher] resync: ${items.length} AgentRun(s) found`);
      }
      for (const run of items) {
        await this.handleEvent("ADDED", run).catch((err) => {
          console.error(`[watcher] resync handler error for ${run.metadata?.name}:`, err);
        });
      }
    } catch (err) {
      console.error("[watcher] resync failed:", err);
    }
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
