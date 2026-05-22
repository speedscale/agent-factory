/**
 * Linear-issue intake path.
 *
 * Parallel to `issue-poller.ts` (which pulls GitHub issues). When the
 * `POLLER_SOURCE` env var is set to `linear`, the embedded poller in
 * `intake-api.ts` uses this module instead of the GitHub one.
 *
 * Why this exists: the deployed factory dispatches GitHub-issue work today,
 * but operationally we want to dispatch Speedscale-internal work from
 * Linear tickets (the `auto-fix` label). Until now the only Linear path
 * was the local `llm-run` CLI; this gives k8s-deployed instances the same
 * capability.
 *
 * Scope of this module:
 *   - Linear API GraphQL client (one query: issues matching a filter).
 *   - `linearIssueToIntakeRequest(issue, app)` — converts a Linear issue
 *     payload into the IntakeRequest shape the rest of the pipeline already
 *     understands.
 *   - Redis-backed dedup keyed on Linear issue ID + updated-at.
 *   - One-shot `runLinearPollerOnce()` and interval-driver
 *     `startLinearPollerLoop(intervalMs)`.
 *
 * NOT in scope (deferred follow-ups):
 *   - Per-ticket repo routing. For MVP all matching Linear tickets go to
 *     a single default AgentApp loaded from `LINEAR_DEFAULT_APP_FILE`.
 *   - Posting back to Linear from the Worker.
 */

import { readFile } from "node:fs/promises";
import { createClient } from "redis";
import { parse as parseYaml } from "yaml";
import type { AgentApp } from "../contracts/index.js";
import { createRunFromRequest, type IntakeRequest, type RunIssueInput } from "./run-store.js";

/**
 * The subset of Linear issue fields this module reads. Linear returns far
 * more — we deliberately consume only what the converter needs so the type
 * doesn't drift with Linear API additions.
 */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  url: string;
  branchName: string | null;
  labels: { nodes: Array<{ name: string }> };
}

export interface LinearPollerConfig {
  apiKey: string;
  /** Linear "filter" string passed verbatim to the issues query. */
  query: string;
  /** Path to the YAML AgentApp manifest every matched ticket dispatches against. */
  defaultAppFile: string;
  redisUrl: string;
  statePrefix: string;
  /** Max tickets returned per poll; prevents runaway dispatch on a large query. */
  maxIssuesPerPoll: number;
}

/**
 * Build a poller config from env vars. Throws if any required value is
 * missing — startup should fail loudly, not silently no-op.
 */
export function loadLinearPollerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LinearPollerConfig {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("LINEAR_API_KEY is required when POLLER_SOURCE=linear");
  }
  const query = env.AF_LINEAR_QUERY;
  if (!query || query.trim().length === 0) {
    throw new Error("AF_LINEAR_QUERY is required when POLLER_SOURCE=linear");
  }
  const defaultAppFile = env.LINEAR_DEFAULT_APP_FILE;
  if (!defaultAppFile || defaultAppFile.trim().length === 0) {
    throw new Error("LINEAR_DEFAULT_APP_FILE is required when POLLER_SOURCE=linear (path to a YAML AgentApp)");
  }
  const max = Number(env.POLLER_MAX_ISSUES_PER_POLL ?? "20");
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error("POLLER_MAX_ISSUES_PER_POLL must be a positive integer");
  }
  return {
    apiKey: apiKey.trim(),
    query: query.trim(),
    defaultAppFile: defaultAppFile.trim(),
    redisUrl: env.POLLER_STATE_REDIS_URL ?? env.REDIS_URL ?? "redis://127.0.0.1:6379",
    statePrefix: env.POLLER_STATE_KEY_PREFIX ?? "agent-factory:poller",
    maxIssuesPerPoll: Math.floor(max)
  };
}

/**
 * Convert a Linear issue into the IntakeRequest shape the rest of the
 * pipeline consumes. Pure; no IO. Tested in isolation.
 *
 * The `issue.id` field becomes the run's stable identifier (so re-polls
 * don't double-dispatch). The `branchName` Linear computes is preserved
 * as a hint — Worker may use it or override.
 */
export function linearIssueToIntakeRequest(issue: LinearIssue, app: AgentApp): IntakeRequest {
  const labelNames = issue.labels?.nodes?.map((n) => n.name) ?? [];
  const branchHint = issue.branchName?.trim() || `linear/${issue.identifier.toLowerCase()}`;

  const runIssue: RunIssueInput = {
    // Use Linear's human-readable identifier (e.g. S-XXXXX) as the run-name
    // suffix — `createRunName()` slugifies, so colons/spaces are safe.
    id: issue.identifier,
    title: issue.title,
    body: composeBody(issue, labelNames, branchHint),
    url: issue.url
  };

  return {
    app,
    issue: runIssue,
    request: {
      source: "manual",
      mode: "baseline"
    }
  };
}

/**
 * Render the run body with the Linear context the Worker will want — labels,
 * the URL back to Linear, the branch hint Linear computed.
 */
function composeBody(issue: LinearIssue, labels: string[], branchHint: string): string {
  const parts: string[] = [];
  if (issue.description && issue.description.trim().length > 0) {
    parts.push(issue.description.trim());
  }
  parts.push("---");
  parts.push(`Linear: ${issue.identifier} — ${issue.url}`);
  if (labels.length > 0) parts.push(`Labels: ${labels.join(", ")}`);
  parts.push(`Branch hint: ${branchHint}`);
  return parts.join("\n\n");
}

/**
 * Hit Linear's GraphQL endpoint with the configured filter and return
 * matching issues. Limited by `maxIssuesPerPoll`.
 */
export async function fetchLinearIssues(config: LinearPollerConfig): Promise<LinearIssue[]> {
  const query = /* GraphQL */ `
    query AgentFactoryPoll($filter: IssueFilter!, $first: Int!) {
      issues(filter: $filter, first: $first) {
        nodes {
          id
          identifier
          title
          description
          updatedAt
          url
          branchName
          labels {
            nodes { name }
          }
        }
      }
    }
  `;

  // The Linear filter string in `config.query` is human-friendly
  // ("label:auto-fix state:Todo") — we parse it into the structured
  // IssueFilter shape Linear's GraphQL expects. Minimal parser; extend as
  // operators need more filter dimensions.
  const filter = parseHumanQueryToFilter(config.query);

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.apiKey
    },
    body: JSON.stringify({ query, variables: { filter, first: config.maxIssuesPerPoll } })
  });
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  }
  const payload = (await res.json()) as { data?: { issues?: { nodes?: LinearIssue[] } }; errors?: unknown };
  if (payload.errors) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }
  return payload.data?.issues?.nodes ?? [];
}

/**
 * Convert a human filter string ("label:auto-fix state:Todo team:Speedscale")
 * into the GraphQL `IssueFilter` shape. Only the dimensions we actually
 * dispatch on are recognised; unknown keys throw.
 *
 * Exported for unit tests.
 */
export function parseHumanQueryToFilter(query: string): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const tokens = query.match(/\w+:"[^"]+"|\w+:\S+/g) ?? [];
  for (const tok of tokens) {
    const eq = tok.indexOf(":");
    const key = tok.slice(0, eq).toLowerCase();
    const rawValue = tok.slice(eq + 1).replace(/^"|"$/g, "");
    switch (key) {
      case "label":
        // Multiple `label:` clauses AND together — push into an array,
        // then materialize as `{ labels: { some: { name: { eq: ... } } } }`
        // for each. Linear's filter syntax requires combining with `and`.
        appendLabelFilter(filter, rawValue);
        break;
      case "state":
        filter.state = { name: { eq: rawValue } };
        break;
      case "team":
        filter.team = { name: { eq: rawValue } };
        break;
      case "assignee":
        filter.assignee = rawValue === "me" ? { isMe: { eq: true } } : { email: { eq: rawValue } };
        break;
      default:
        throw new Error(`Unsupported filter key in AF_LINEAR_QUERY: ${key}`);
    }
  }
  return filter;
}

function appendLabelFilter(filter: Record<string, unknown>, name: string): void {
  // Linear filters multiple labels via `and: [{ labels: { ... } }, ...]`.
  if (!filter.and) filter.and = [];
  (filter.and as Array<Record<string, unknown>>).push({
    labels: { some: { name: { eq: name } } }
  });
}

type PollerRedisClient = ReturnType<typeof createClient>;

/**
 * Dedup key for a Linear issue. Includes updatedAt so re-edits of a
 * previously-dispatched ticket re-enqueue (intentional — the spec may
 * have improved enough to retry).
 */
function dedupKey(prefix: string, issue: LinearIssue): string {
  return `${prefix}:linear:${issue.id}:${issue.updatedAt}`;
}

/** Returns true if this is the first time we've seen this issue+updatedAt. */
async function claimIssue(redis: PollerRedisClient, prefix: string, issue: LinearIssue): Promise<boolean> {
  const key = dedupKey(prefix, issue);
  // SET key value NX EX seconds — atomic check-and-set with a 30-day TTL
  // so old dedup keys don't accumulate forever.
  const set = await redis.set(key, "1", { NX: true, EX: 60 * 60 * 24 * 30 });
  return set === "OK";
}

/**
 * Load the YAML AgentApp manifest the poller dispatches every matched
 * ticket against. Validation is intentionally light — bad shape is the
 * operator's problem and fails loudly when `createRunFromRequest` runs.
 */
export async function loadDefaultApp(filePath: string): Promise<AgentApp> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseYaml(raw) as AgentApp;
  if (!parsed || parsed.kind !== "AgentApp" || !parsed.metadata?.name) {
    throw new Error(`${filePath} is not a valid AgentApp manifest`);
  }
  return parsed;
}

/**
 * One poll pass. Fetches matching tickets, claims new-or-re-edited ones
 * in Redis, and enqueues runs for each.
 */
export async function runLinearPollerOnce(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadLinearPollerConfigFromEnv(env);
  const app = await loadDefaultApp(config.defaultAppFile);

  const redis = createClient({ url: config.redisUrl });
  await redis.connect();
  try {
    const issues = await fetchLinearIssues(config);
    let enqueued = 0;
    for (const issue of issues) {
      const fresh = await claimIssue(redis, config.statePrefix, issue);
      if (!fresh) continue;
      const intakeRequest = linearIssueToIntakeRequest(issue, app);
      await createRunFromRequest(intakeRequest);
      enqueued += 1;
      console.log(`[linear-poller] queued ${issue.identifier}: ${issue.title}`);
    }
    if (enqueued === 0 && issues.length > 0) {
      console.log(`[linear-poller] ${issues.length} ticket(s) returned; all already-dispatched`);
    } else if (issues.length === 0) {
      console.log(`[linear-poller] no tickets match query`);
    }
  } finally {
    await redis.quit();
  }
}

/**
 * Background-interval driver. Kicks off one pass immediately, then every
 * `intervalMs`. Errors in a pass are logged and skipped — next interval
 * tries again.
 */
export function startLinearPollerLoop(intervalMs: number): NodeJS.Timeout {
  const runLoop = async (): Promise<void> => {
    try {
      await runLinearPollerOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[linear-poller] iteration failed: ${message}`);
    }
  };
  void runLoop();
  return setInterval(() => {
    void runLoop();
  }, intervalMs);
}
