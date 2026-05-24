/**
 * traffic-materializer — resolves remote TrafficSources into local snapshot dirs.
 *
 * For `store.kind === "loki"` sources the controller calls this module before
 * handing the AgentRunContext to any agent. The materializer invokes
 * `loki-gather` (the Python script shipped in the Docker image at
 * /usr/local/bin/loki-gather) and writes an RRPair snapshot tree under
 * `<runDir>/snapshot/<sourceName>/`. On success it returns a transformed
 * copy of the TrafficSource where `store.kind` is rewritten to `"local-fs"`
 * and `store.path` points to the populated snapshot dir — agents that handle
 * `local-fs` sources transparently pick up Loki traffic without modification.
 *
 * Non-loki sources are passed through unchanged.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TrafficSource } from "../contracts/index.js";
import type { AgentLogger } from "../agents/types.js";

const execAsync = promisify(exec);

/**
 * Default path to the loki-gather script inside the Docker image.
 * Override with `AF_LOKI_GATHER_PATH` for custom installs or local dev.
 */
const DEFAULT_LOKI_GATHER_PATH =
  process.env.AF_LOKI_GATHER_PATH ?? "/usr/local/bin/loki-gather";

export interface MaterializerOptions {
  /** Base directory for this agent run — snapshot lands in <runDir>/snapshot/<name>/. */
  runDir: string;
  logger: AgentLogger;
  /**
   * Resolve a k8s Secret value for the given namespace/name/key.
   * Used to surface a Loki auth token when `store.auth.secretRef` is set.
   * If omitted, auth is skipped (fine for in-cluster Loki without auth).
   */
  readSecret?: (namespace: string, name: string, key: string) => Promise<string>;
  /**
   * Injectable exec function — replace in tests to avoid spawning real processes.
   * Default: util.promisify(child_process.exec).
   */
  execFn?: (
    cmd: string,
    opts?: { env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Path to the loki-gather Python script.
   * Default: AF_LOKI_GATHER_PATH env var, or "/usr/local/bin/loki-gather".
   */
  lokiGatherPath?: string;
  /**
   * Kubernetes namespace — required when `readSecret` is provided and the
   * TrafficSource has an `auth.secretRef`.
   */
  namespace?: string;
}

/**
 * Materialise a single TrafficSource.
 *
 * - `kind: "loki"` → invoke loki-gather, return a `local-fs` copy pointing
 *   at the populated snapshot dir.
 * - All other kinds → returned unchanged (pass-through).
 */
export async function materializeTrafficSource(
  source: TrafficSource,
  opts: MaterializerOptions,
): Promise<TrafficSource> {
  if (source.spec.store.kind !== "loki") {
    return source;
  }

  const { runDir, logger, readSecret, namespace } = opts;
  const execFn = opts.execFn ?? execAsync;
  const lokiGatherPath = opts.lokiGatherPath ?? DEFAULT_LOKI_GATHER_PATH;

  const sourceName = source.metadata.name;
  const snapshotDir = path.join(runDir, "snapshot", sourceName);
  await fs.mkdir(snapshotDir, { recursive: true });

  const endpoint = source.spec.store.endpoint;
  if (!endpoint) {
    throw new Error(
      `TrafficSource "${sourceName}": store.kind is "loki" but store.endpoint is not set`,
    );
  }

  // Build the argument list.
  const args: string[] = [
    lokiGatherPath,
    "--loki-url", shellescape(endpoint),
    "--out-dir", shellescape(snapshotDir),
  ];

  // Time window (default -1h matches the TrafficSource contract).
  const window = source.spec.store.window ?? "-1h";
  args.push("--start", shellescape(window));

  // LogQL query takes priority over scope-based label filters.
  if (source.spec.store.logql) {
    args.push("--logql", shellescape(source.spec.store.logql));
  } else {
    // Fall back to scope-level cluster / service label filters.
    const clusters = source.spec.scope.clusters ?? [];
    if (clusters.length > 0) {
      args.push("--cluster", shellescape(clusters[0]));
    }
    const services = source.spec.scope.services ?? [];
    if (services.length > 0) {
      args.push("--service", shellescape(services[0]));
    }
  }

  // Auth: read the secret if a secretRef is configured and we have a reader.
  let env: NodeJS.ProcessEnv | undefined;
  const secretRef = source.spec.store.auth?.secretRef;
  if (secretRef && readSecret && namespace) {
    try {
      const token = await readSecret(namespace, secretRef.name, secretRef.key);
      env = { ...process.env, LOKI_AUTH_TOKEN: token };
    } catch (err) {
      logger.warn("loki-gather: could not read auth secret, proceeding without auth", {
        secretName: secretRef.name,
        secretKey: secretRef.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const cmd = `python3 ${args.join(" ")}`;
  logger.info("loki-gather: invoking", { cmd, snapshotDir });

  try {
    const { stdout, stderr } = await execFn(cmd, env ? { env } : undefined);
    if (stderr) {
      logger.warn("loki-gather: stderr output", { stderr: stderr.slice(0, 500) });
    }
    logger.info("loki-gather: complete", { stdout: stdout.slice(0, 200), snapshotDir });
  } catch (err) {
    throw new Error(
      `loki-gather failed for TrafficSource "${sourceName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Return a transformed copy: kind → local-fs, path → snapshot dir.
  // Deep-clone via JSON round-trip to avoid mutating the original k8s object.
  const materialized: TrafficSource = JSON.parse(JSON.stringify(source));
  materialized.spec.store = {
    ...materialized.spec.store,
    kind: "local-fs",
    path: snapshotDir,
    // Clear loki-specific fields that don't apply to local-fs.
    logql: undefined,
    window: undefined,
    endpoint: undefined,
    auth: undefined,
  };
  return materialized;
}

/**
 * Materialise all TrafficSources for an agent run, resolving any Loki sources
 * into local snapshot dirs.  Returns the array in the same order, with loki
 * entries replaced by their `local-fs` equivalents.
 */
export async function materializeTrafficSources(
  sources: TrafficSource[],
  opts: MaterializerOptions,
): Promise<TrafficSource[]> {
  const results: TrafficSource[] = [];
  for (const source of sources) {
    results.push(await materializeTrafficSource(source, opts));
  }
  return results;
}

/**
 * Minimal shell-escaping: wrap the value in single quotes and escape any
 * embedded single quotes.  Sufficient for well-formed URLs, paths, and
 * LogQL strings.  Not a general-purpose sanitiser — the TrafficSource RBAC
 * in k8s ensures only trusted operators can set these values.
 */
function shellescape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
