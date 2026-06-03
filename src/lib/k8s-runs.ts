/**
 * intake-api / metrics view of AgentRun custom resources.
 *
 * The HTTP intake path (`POST /qa/runs`) writes run.json to the
 * filesystem; the CRD intake path (`kubectl apply AgentRun`) writes to
 * etcd via the controller. The metrics handler must see both, or the
 * dashboard reads 0 for any CRD-driven run.
 *
 * This helper is read-only: it LISTs AgentRuns from the cluster the
 * intake-api pod is running in. When intake-api runs outside a cluster
 * (local dev, unit tests) the loader returns an empty list rather than
 * throwing so the filesystem fallback alone is still surfaced.
 *
 * Results are cached briefly (`CACHE_TTL_MS`) so a high Prometheus
 * scrape rate doesn't translate 1:1 into kube-apiserver LIST calls.
 */

import * as k8s from "@kubernetes/client-node";
import type { AgentRun, AgentRunPhase } from "../contracts/index.js";
import { AGENTS_API_VERSION } from "./controller/k8s.js";

const CACHE_TTL_MS = 2000;

export interface K8sRunsLoader {
  /**
   * Return all AgentRuns visible to the configured ServiceAccount. Empty
   * array if no cluster connection or no resources found. Never throws —
   * unexpected errors are logged and treated as "no runs visible right now".
   */
  list(): Promise<AgentRun[]>;
  /** True when a kube client could be loaded — for diagnostics in /metrics.json. */
  isConfigured(): boolean;
}

export interface CreateK8sRunsLoaderOptions {
  /** Namespace to scope the LIST. Empty / undefined = all namespaces. */
  namespace?: string;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  loader?: () => Promise<AgentRun[]>;
}

function tryLoadKubeConfig(): k8s.KubeConfig | undefined {
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      // Local dev: only attempt loadFromDefault when a kubeconfig is
      // reachable. Otherwise we'd noisily warn on every metrics scrape.
      if (!process.env.KUBECONFIG && !process.env.HOME) return undefined;
      kc.loadFromDefault();
    }
    return kc;
  } catch (err) {
    console.warn(
      `[metrics] kubeconfig unavailable, falling back to filesystem-only run view: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

export function createK8sRunsLoader(
  opts: CreateK8sRunsLoaderOptions = {},
): K8sRunsLoader {
  const now = opts.now ?? Date.now;
  const namespace = opts.namespace && opts.namespace.length > 0 ? opts.namespace : undefined;

  let cachedAt = 0;
  let cached: AgentRun[] = [];

  let injectedLoader = opts.loader;
  let objects: k8s.KubernetesObjectApi | undefined;
  let configured = injectedLoader !== undefined;

  if (!injectedLoader) {
    const kc = tryLoadKubeConfig();
    if (kc) {
      try {
        objects = k8s.KubernetesObjectApi.makeApiClient(kc);
        configured = true;
      } catch (err) {
        console.warn(
          `[metrics] k8s client init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async function fetchOnce(): Promise<AgentRun[]> {
    if (injectedLoader) return injectedLoader();
    if (!objects) return [];
    try {
      const result = await objects.list<AgentRun>(
        AGENTS_API_VERSION,
        "AgentRun",
        namespace,
      );
      return result.items ?? [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[metrics] AgentRun LIST failed: ${message}`);
      return [];
    }
  }

  return {
    isConfigured: () => configured,
    list: async () => {
      const elapsed = now() - cachedAt;
      if (elapsed < CACHE_TTL_MS) {
        return cached;
      }
      cached = await fetchOnce();
      cachedAt = now();
      return cached;
    },
  };
}

/**
 * Merge filesystem-sourced runs and k8s-sourced runs, deduping by
 * `metadata.name`. The two intake paths never write to the same store,
 * but defensive dedup means a future change that double-writes won't
 * break the count.
 *
 * Exported for unit tests.
 */
export function mergeRuns(fsRuns: AgentRun[], k8sRuns: AgentRun[]): AgentRun[] {
  const byName = new Map<string, AgentRun>();
  for (const r of fsRuns) byName.set(r.metadata.name, r);
  // k8s wins on conflict: it's the source of truth for status.
  for (const r of k8sRuns) byName.set(r.metadata.name, r);
  return Array.from(byName.values());
}

export function countByPhase(runs: AgentRun[]): Record<AgentRunPhase, number> {
  const counts: Record<AgentRunPhase, number> = {
    queued: 0,
    planned: 0,
    building: 0,
    scanning: 0,
    generating: 0,
    validating: 0,
    deploying: 0,
    reporting: 0,
    succeeded: 0,
    failed: 0,
  };
  for (const r of runs) {
    const phase = r.status?.phase;
    if (phase && phase in counts) {
      counts[phase] = (counts[phase] ?? 0) + 1;
    }
  }
  return counts;
}
