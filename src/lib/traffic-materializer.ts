/**
 * traffic-materializer — pluggable adapter system for resolving TrafficSources
 * into local RRPair snapshot directories.
 *
 * Each `store.kind` maps to a dedicated adapter.  Adding support for a new
 * traffic backend means adding one entry to ADAPTERS and implementing its
 * fetch function — nothing else changes in the controller or agent code.
 *
 * Implemented adapters
 * ────────────────────
 *   local-fs          Pass-through.  The snapshot dir is already on disk.
 *   speedscale-cloud  `proxymock cloud pull snapshot <id> --out <dir>`
 *                     store.path  = snapshot ID (required)
 *                     store.auth  = secretRef whose value is SPEEDSCALE_API_KEY
 *   speedscale-onprem Same as speedscale-cloud but with --app-url <store.endpoint>
 *   loki              `python3 loki-gather --loki-url <endpoint> --out-dir <dir>`
 *                     store.endpoint = Loki HTTP base URL (required)
 *                     store.logql    = full LogQL (optional; overrides scope filters)
 *                     store.window   = --start window e.g. "-1h" (default: "-1h")
 *                     store.auth     = secretRef whose value is LOKI_AUTH_TOKEN
 *
 * Planned (TBD) adapters
 * ──────────────────────
 *   elasticsearch     Gather via Elasticsearch query API (script TBD)
 *   fluent-bit        Gather via Fluent Bit HTTP output endpoint (script TBD)
 *
 * Both planned adapters will follow the same pattern: implement the adapter
 * function, add it to ADAPTERS, extend the CRD enum and TS union.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TrafficSource } from "../contracts/index.js";
import type { AgentLogger } from "../agents/types.js";

const execAsync = promisify(exec);

// ── Options ──────────────────────────────────────────────────────────────────

export interface MaterializerOptions {
  /** Base directory for this agent run — each source lands in <runDir>/snapshot/<name>/. */
  runDir: string;
  logger: AgentLogger;
  /**
   * Resolve a k8s Secret value.  Used by adapters that need auth credentials.
   * If omitted, auth secrets are skipped and a warning is logged.
   */
  readSecret?: (namespace: string, name: string, key: string) => Promise<string>;
  /**
   * Injectable exec function — replace in unit tests to avoid spawning real
   * processes.  Default: util.promisify(child_process.exec).
   */
  execFn?: (
    cmd: string,
    opts?: { env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Path to the loki-gather Python script.
   * Default: AF_LOKI_GATHER_PATH env var, then "/usr/local/bin/loki-gather".
   */
  lokiGatherPath?: string;
  /**
   * Path to the proxymock binary.
   * Default: AF_PROXYMOCK_PATH env var, then "proxymock" (resolved via PATH).
   */
  proxymockPath?: string;
  /**
   * Kubernetes namespace for secret reads.  Required when any source has
   * store.auth.secretRef set and readSecret is provided.
   */
  namespace?: string;
}

// ── Adapter type ─────────────────────────────────────────────────────────────

type AdapterFn = (
  source: TrafficSource,
  snapshotDir: string,
  opts: MaterializerOptions,
) => Promise<void>;

// ── Adapter registry ─────────────────────────────────────────────────────────
//
// Each entry handles one store.kind.  The adapter populates `snapshotDir` with
// RRPair files and returns.  The caller handles the local-fs rewrite.

const ADAPTERS: Record<string, AdapterFn> = {
  "local-fs": localFsAdapter,
  "speedscale-cloud": speedscaleCloudAdapter,
  "speedscale-onprem": speedscaleOnpremAdapter,
  "loki": lokiAdapter,
  // "elasticsearch": elasticsearchAdapter,  ← add here when ready
  // "fluent-bit": fluentBitAdapter,         ← add here when ready
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Materialise a single TrafficSource into a local snapshot directory.
 *
 * Returns a transformed copy of the source where `store.kind` is `"local-fs"`
 * and `store.path` points at the populated snapshot directory.  For sources
 * that are already local-fs the original object is returned unchanged.
 *
 * Throws for unrecognised `store.kind` values so misconfigured deployments
 * surface immediately rather than silently operating on empty traffic.
 */
export async function materializeTrafficSource(
  source: TrafficSource,
  opts: MaterializerOptions,
): Promise<TrafficSource> {
  const kind = source.spec.store.kind;
  const sourceName = source.metadata.name;

  const adapter = ADAPTERS[kind];
  if (!adapter) {
    throw new Error(
      `TrafficSource "${sourceName}": store.kind "${kind}" has no adapter. ` +
      `Implemented: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }

  // local-fs: already on disk, no fetch needed, return as-is.
  if (kind === "local-fs") {
    return source;
  }

  const snapshotDir = path.join(opts.runDir, "snapshot", sourceName);
  await fs.mkdir(snapshotDir, { recursive: true });

  try {
    await adapter(source, snapshotDir, opts);
  } catch (err) {
    throw new Error(
      `TrafficSource "${sourceName}" (${kind}): fetch failed — ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Return a normalised local-fs copy so all downstream agents see the same
  // shape regardless of which adapter ran.
  const materialized: TrafficSource = JSON.parse(JSON.stringify(source));
  materialized.spec.store = {
    kind: "local-fs",
    path: snapshotDir,
  };
  return materialized;
}

/**
 * Materialise all TrafficSources for an agent run.  Returns the array in the
 * same order with remote sources replaced by their local-fs equivalents.
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

// ── Adapters ──────────────────────────────────────────────────────────────────

/** local-fs: nothing to fetch, the path is already on disk. */
async function localFsAdapter(): Promise<void> {
  // no-op
}

/**
 * speedscale-cloud: pull a snapshot from Speedscale Cloud via the proxymock CLI.
 *
 *   proxymock cloud pull snapshot <store.path> --out <snapshotDir>
 *
 * store.path   = Speedscale Cloud snapshot ID (required)
 * store.auth   = secretRef for SPEEDSCALE_API_KEY (optional; falls back to env)
 */
async function speedscaleCloudAdapter(
  source: TrafficSource,
  snapshotDir: string,
  opts: MaterializerOptions,
): Promise<void> {
  const { logger } = opts;
  const sourceName = source.metadata.name;
  const snapshotId = source.spec.store.path;
  if (!snapshotId) {
    throw new Error(
      `store.path (snapshot ID) is required for kind "speedscale-cloud" — ` +
      `set it to the Speedscale Cloud snapshot UUID`,
    );
  }

  const proxymock = opts.proxymockPath ?? process.env.AF_PROXYMOCK_PATH ?? "proxymock";
  const env = await resolveApiKeyEnv(source, "SPEEDSCALE_API_KEY", opts);

  const cmd = [
    shellescape(proxymock),
    "cloud", "pull", "snapshot",
    shellescape(snapshotId),
    "--out", shellescape(snapshotDir),
  ].join(" ");

  await runCmd(cmd, env, `proxymock cloud pull snapshot (${sourceName})`, logger, opts.execFn);
}

/**
 * speedscale-onprem: same as speedscale-cloud but targets a customer-hosted
 * Speedscale instance via --app-url.
 *
 * store.endpoint = on-prem Speedscale app URL (required)
 * store.path     = snapshot ID (required)
 * store.auth     = secretRef for SPEEDSCALE_API_KEY (optional)
 */
async function speedscaleOnpremAdapter(
  source: TrafficSource,
  snapshotDir: string,
  opts: MaterializerOptions,
): Promise<void> {
  const { logger } = opts;
  const sourceName = source.metadata.name;
  const snapshotId = source.spec.store.path;
  if (!snapshotId) {
    throw new Error(
      `store.path (snapshot ID) is required for kind "speedscale-onprem"`,
    );
  }
  const appUrl = source.spec.store.endpoint;
  if (!appUrl) {
    throw new Error(
      `store.endpoint (on-prem app URL) is required for kind "speedscale-onprem"`,
    );
  }

  const proxymock = opts.proxymockPath ?? process.env.AF_PROXYMOCK_PATH ?? "proxymock";
  const env = await resolveApiKeyEnv(source, "SPEEDSCALE_API_KEY", opts);

  const cmd = [
    shellescape(proxymock),
    "cloud", "pull", "snapshot",
    shellescape(snapshotId),
    "--out", shellescape(snapshotDir),
    "--app-url", shellescape(appUrl),
  ].join(" ");

  await runCmd(cmd, env, `proxymock cloud pull snapshot onprem (${sourceName})`, logger, opts.execFn);
}

/**
 * loki: gather RRPairs from a Grafana Loki instance using the loki-gather script.
 *
 *   python3 loki-gather --loki-url <endpoint> --out-dir <snapshotDir>
 *                        [--logql <logql> | --cluster <c> --service <s>]
 *                        [--start <window>]
 *
 * store.endpoint = Loki HTTP base URL (required)
 * store.logql    = full LogQL query (optional; overrides scope filters)
 * store.window   = --start window e.g. "-1h" (optional; default "-1h")
 * store.auth     = secretRef for LOKI_AUTH_TOKEN (optional)
 * scope.clusters = [0] used as --cluster filter when logql is absent
 * scope.services = [0] used as --service filter when logql is absent
 */
async function lokiAdapter(
  source: TrafficSource,
  snapshotDir: string,
  opts: MaterializerOptions,
): Promise<void> {
  const { logger } = opts;
  const sourceName = source.metadata.name;
  const lokiGatherPath = opts.lokiGatherPath ?? process.env.AF_LOKI_GATHER_PATH ?? "/usr/local/bin/loki-gather";

  const endpoint = source.spec.store.endpoint;
  if (!endpoint) {
    throw new Error(
      `store.endpoint (Loki URL) is required for kind "loki"`,
    );
  }

  const args: string[] = [
    lokiGatherPath,
    "--loki-url", shellescape(endpoint),
    "--out-dir", shellescape(snapshotDir),
    "--start", shellescape(source.spec.store.window ?? "-1h"),
  ];

  if (source.spec.store.logql) {
    args.push("--logql", shellescape(source.spec.store.logql));
  } else {
    const clusters = source.spec.scope.clusters ?? [];
    if (clusters.length > 0) args.push("--cluster", shellescape(clusters[0]));
    const services = source.spec.scope.services ?? [];
    if (services.length > 0) args.push("--service", shellescape(services[0]));
  }

  const env = await resolveTokenEnv(source, "LOKI_AUTH_TOKEN", opts);
  await runCmd(`python3 ${args.join(" ")}`, env, `loki-gather (${sourceName})`, logger, opts.execFn);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read a k8s Secret value and inject it as an env var.  If the secretRef is
 * absent, readSecret is not provided, or the read fails, logs a warning and
 * returns undefined (caller continues without auth).
 */
async function resolveTokenEnv(
  source: TrafficSource,
  envKey: string,
  opts: MaterializerOptions,
): Promise<NodeJS.ProcessEnv | undefined> {
  const secretRef = source.spec.store.auth?.secretRef;
  if (!secretRef || !opts.readSecret || !opts.namespace) return undefined;
  try {
    const token = await opts.readSecret(opts.namespace, secretRef.name, secretRef.key);
    return { ...process.env, [envKey]: token };
  } catch (err) {
    opts.logger.warn(`could not read auth secret for ${source.metadata.name}, proceeding without auth`, {
      secretName: secretRef.name,
      secretKey: secretRef.key,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Alias for API-key style secrets (same logic, different env var name). */
async function resolveApiKeyEnv(
  source: TrafficSource,
  envKey: string,
  opts: MaterializerOptions,
): Promise<NodeJS.ProcessEnv | undefined> {
  return resolveTokenEnv(source, envKey, opts);
}

async function runCmd(
  cmd: string,
  env: NodeJS.ProcessEnv | undefined,
  label: string,
  logger: AgentLogger,
  execFn?: MaterializerOptions["execFn"],
): Promise<void> {
  const fn = execFn ?? execAsync;
  logger.info(`${label}: running`, { cmd });
  const { stdout, stderr } = await fn(cmd, env ? { env } : undefined);
  if (stderr) logger.warn(`${label}: stderr`, { stderr: stderr.slice(0, 500) });
  if (stdout) logger.info(`${label}: done`, { stdout: stdout.slice(0, 200) });
}

/**
 * Minimal shell-escaping: wrap in single quotes and escape embedded quotes.
 * Sufficient for well-formed URLs, paths, UUIDs, and LogQL strings.
 */
function shellescape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
