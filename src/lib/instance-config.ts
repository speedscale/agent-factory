/**
 * Instance config — per-deployment identity + ticket-sourcing knobs.
 *
 * The agent-factory binary is portable; per-deployment policy lives outside
 * the repo (see `speedstack/instances/agent-factory/`). This module is the
 * narrow surface the binary reads to know which instance it is and what
 * tickets it cares about.
 *
 * Precedence: CLI flag > env var > default.
 *
 * Env vars consumed:
 *   AF_INSTANCE       Free-form tag identifying this deployment in logs and
 *                     metrics (e.g. "ken-local-cli", "minikube-local",
 *                     "k8s-staging"). Defaults to "local".
 *
 *   AF_LINEAR_QUERY   Linear filter string the poller uses when sourcing
 *                     tickets from Linear instead of GitHub. Unused by the
 *                     binary today (the Linear intake path is a separate
 *                     ticket); declared here so config bundles can pin a
 *                     value before that ships.
 */

export interface InstanceConfig {
  /** Instance tag — appears in every log line, never empty. */
  instance: string;
  /** Optional Linear query string. Undefined if not configured. */
  linearQuery: string | undefined;
}

export interface InstanceConfigOverrides {
  /** CLI flag value if provided; takes precedence over env. */
  instance?: string;
  linearQuery?: string;
}

const DEFAULT_INSTANCE = "local";

/**
 * Read instance config from env (and optional CLI overrides). Pure — does
 * not log, does not throw. Callers log on startup.
 */
export function getInstanceConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: InstanceConfigOverrides = {}
): InstanceConfig {
  const instance = pickFirst(overrides.instance, env.AF_INSTANCE) ?? DEFAULT_INSTANCE;
  const linearQuery = pickFirst(overrides.linearQuery, env.AF_LINEAR_QUERY);
  return { instance, linearQuery };
}

/**
 * Return the first non-empty trimmed string in the list, or `undefined` if
 * none qualify. `undefined`-typed entries are skipped without coercion to "".
 */
function pickFirst(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * One-line startup banner for any binary entry-point. Calling this from
 * `main()` gives consistent instance identification across long-running
 * deployments (intake-api, controller, worker) and one-shot CLIs (llm-run).
 */
export function formatInstanceBanner(cfg: InstanceConfig, role: string): string {
  const bits: string[] = [`[instance=${cfg.instance}]`, `role=${role}`];
  if (cfg.linearQuery) bits.push(`linearQuery=${JSON.stringify(cfg.linearQuery)}`);
  return bits.join(" ");
}
