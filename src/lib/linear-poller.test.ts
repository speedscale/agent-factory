import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linearIssueToIntakeRequest,
  linearIssueToAgentRun,
  applyAgentRun,
  parseHumanQueryToFilter,
  loadLinearPollerConfigFromEnv,
  pickNamespace,
  type LinearIssue
} from "./linear-poller.js";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import type { K8sClients } from "./controller/k8s.js";

const APP: AgentApp = {
  apiVersion: "agents.speedscale.io/v1alpha1",
  kind: "AgentApp",
  metadata: { name: "demo-node" },
  spec: {
    repo: { provider: "github", url: "https://github.com/speedscale/demo", defaultBranch: "main", workdir: "node" },
    build: { install: "npm ci", test: "npm test", start: "npm start" },
    validate: { proxymock: { dataset: "sample-node-bug", mode: "replay-with-mocks", command: "proxymock replay" } },
    policy: { autoBranch: true, autoMr: false, autoMerge: false }
  } as unknown as AgentApp["spec"]
};

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "ddc4a2c9-1234",
    identifier: "TEST-99999",
    title: "Test ticket",
    description: "Some description.",
    updatedAt: "2026-05-22T17:00:00Z",
    url: "https://linear.app/speedscale/issue/TEST-99999/test-ticket",
    branchName: "test-99999-test-ticket",
    labels: { nodes: [{ name: "auto-fix" }, { name: "Bug" }] },
    ...overrides
  };
}

// ---------- linearIssueToIntakeRequest ----------

test("converts a basic ticket to IntakeRequest with the AgentApp attached", () => {
  const out = linearIssueToIntakeRequest(makeIssue(), APP);
  assert.equal(out.app, APP);
  assert.equal(out.issue.id, "TEST-99999");
  assert.equal(out.issue.title, "Test ticket");
  assert.equal(out.issue.url, "https://linear.app/speedscale/issue/TEST-99999/test-ticket");
  assert.equal(out.request?.source, "manual");
  assert.equal(out.request?.mode, "baseline");
});

test("body composes description + Linear url + labels + branch hint", () => {
  const out = linearIssueToIntakeRequest(makeIssue(), APP);
  assert.match(out.issue.body, /Some description\./);
  assert.match(out.issue.body, /Linear: TEST-99999 — https/);
  assert.match(out.issue.body, /Labels: auto-fix, Bug/);
  assert.match(out.issue.body, /Branch hint: test-99999-test-ticket/);
});

test("falls back to synthetic branch hint when Linear didn't compute one", () => {
  const out = linearIssueToIntakeRequest(makeIssue({ branchName: null }), APP);
  assert.match(out.issue.body, /Branch hint: linear\/test-99999/);
});

test("handles null description (Linear allows empty bodies)", () => {
  const out = linearIssueToIntakeRequest(makeIssue({ description: null }), APP);
  assert.doesNotMatch(out.issue.body, /^null/);
  assert.match(out.issue.body, /Linear: TEST-99999/);
});

test("handles empty label set", () => {
  const out = linearIssueToIntakeRequest(makeIssue({ labels: { nodes: [] } }), APP);
  assert.doesNotMatch(out.issue.body, /Labels:/);
  assert.match(out.issue.body, /Branch hint:/);
});

// ---------- parseHumanQueryToFilter ----------

test("parses single-label query", () => {
  const f = parseHumanQueryToFilter("label:auto-fix");
  assert.deepEqual(f, {
    and: [{ labels: { some: { name: { eq: "auto-fix" } } } }]
  });
});

test("parses multi-clause query (label + state + team)", () => {
  const f = parseHumanQueryToFilter('label:auto-fix state:Todo team:"Speedscale"');
  assert.deepEqual(f, {
    and: [{ labels: { some: { name: { eq: "auto-fix" } } } }],
    state: { name: { eq: "Todo" } },
    team: { name: { eq: "Speedscale" } }
  });
});

test("parses assignee:me as the isMe filter", () => {
  const f = parseHumanQueryToFilter("assignee:me");
  assert.deepEqual(f.assignee, { isMe: { eq: true } });
});

test("parses assignee:<email> as the email filter", () => {
  const f = parseHumanQueryToFilter("assignee:ken@speedscale.com");
  assert.deepEqual(f.assignee, { email: { eq: "ken@speedscale.com" } });
});

test("supports multiple label clauses (AND)", () => {
  const f = parseHumanQueryToFilter("label:auto-fix label:Bug");
  const andClauses = f.and as Array<Record<string, unknown>>;
  assert.equal(andClauses.length, 2);
  assert.deepEqual(andClauses[0], { labels: { some: { name: { eq: "auto-fix" } } } });
  assert.deepEqual(andClauses[1], { labels: { some: { name: { eq: "Bug" } } } });
});

test("rejects unknown filter keys with a clear error", () => {
  assert.throws(
    () => parseHumanQueryToFilter("priority:1"),
    /Unsupported filter key.*priority/
  );
});

test("ignores whitespace in the query", () => {
  const f = parseHumanQueryToFilter("  label:auto-fix    state:Todo  ");
  assert.deepEqual(f, {
    and: [{ labels: { some: { name: { eq: "auto-fix" } } } }],
    state: { name: { eq: "Todo" } }
  });
});

// ---------- loadLinearPollerConfigFromEnv ----------

test("loads config from env when all required vars are set", () => {
  const cfg = loadLinearPollerConfigFromEnv({
    LINEAR_API_KEY: "lin_api_xyz",
    AF_LINEAR_QUERY: "label:auto-fix state:Todo",
    LINEAR_DEFAULT_APP_FILE: "/etc/agent-factory/default-app.yaml"
  });
  assert.equal(cfg.apiKey, "lin_api_xyz");
  assert.equal(cfg.query, "label:auto-fix state:Todo");
  assert.equal(cfg.defaultAppFile, "/etc/agent-factory/default-app.yaml");
  assert.equal(cfg.statePrefix, "agent-factory:poller");
  assert.equal(cfg.maxIssuesPerPoll, 20);
});

test("respects POLLER_STATE_REDIS_URL and POLLER_STATE_KEY_PREFIX overrides", () => {
  const cfg = loadLinearPollerConfigFromEnv({
    LINEAR_API_KEY: "k",
    AF_LINEAR_QUERY: "label:x",
    LINEAR_DEFAULT_APP_FILE: "/x.yaml",
    POLLER_STATE_REDIS_URL: "redis://cluster:6379",
    POLLER_STATE_KEY_PREFIX: "af:staging"
  });
  assert.equal(cfg.redisUrl, "redis://cluster:6379");
  assert.equal(cfg.statePrefix, "af:staging");
});

test("falls back to REDIS_URL when POLLER_STATE_REDIS_URL is unset", () => {
  const cfg = loadLinearPollerConfigFromEnv({
    LINEAR_API_KEY: "k",
    AF_LINEAR_QUERY: "label:x",
    LINEAR_DEFAULT_APP_FILE: "/x.yaml",
    REDIS_URL: "redis://shared:6379"
  });
  assert.equal(cfg.redisUrl, "redis://shared:6379");
});

test("throws when LINEAR_API_KEY is missing", () => {
  assert.throws(
    () => loadLinearPollerConfigFromEnv({
      AF_LINEAR_QUERY: "label:x",
      LINEAR_DEFAULT_APP_FILE: "/x.yaml"
    }),
    /LINEAR_API_KEY is required/
  );
});

test("throws when AF_LINEAR_QUERY is missing", () => {
  assert.throws(
    () => loadLinearPollerConfigFromEnv({
      LINEAR_API_KEY: "k",
      LINEAR_DEFAULT_APP_FILE: "/x.yaml"
    }),
    /AF_LINEAR_QUERY is required/
  );
});

test("throws when LINEAR_DEFAULT_APP_FILE is missing", () => {
  assert.throws(
    () => loadLinearPollerConfigFromEnv({
      LINEAR_API_KEY: "k",
      AF_LINEAR_QUERY: "label:x"
    }),
    /LINEAR_DEFAULT_APP_FILE is required/
  );
});

test("trims whitespace from env values", () => {
  const cfg = loadLinearPollerConfigFromEnv({
    LINEAR_API_KEY: "  k  ",
    AF_LINEAR_QUERY: "  label:x  ",
    LINEAR_DEFAULT_APP_FILE: "  /x.yaml  "
  });
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.query, "label:x");
  assert.equal(cfg.defaultAppFile, "/x.yaml");
});

// ---------- linearIssueToAgentRun ----------

test("AgentRun name is deterministic: triage-<lowercase-identifier>", () => {
  const run = linearIssueToAgentRun(makeIssue({ identifier: "XYZ-123" }), APP);
  assert.equal(run.metadata.name, "triage-xyz-123");
  // Same input → same name → idempotency.
  const again = linearIssueToAgentRun(makeIssue({ identifier: "XYZ-123" }), APP);
  assert.equal(run.metadata.name, again.metadata.name);
});

test("AgentRun carries spec.agent=triage, spec.appRef, source labels", () => {
  const run = linearIssueToAgentRun(makeIssue(), APP);
  assert.equal(run.spec.agent, "triage");
  assert.equal(run.spec.appRef.name, "demo-node");
  const labels = (run.metadata as { labels?: Record<string, string> }).labels ?? {};
  assert.equal(labels["agents.speedscale.io/source"], "linear-poller");
  assert.equal(labels["agents.speedscale.io/agent"], "triage");
});

test("AgentRun spec.issue carries linearIssueId (the UUID, not identifier)", () => {
  const run = linearIssueToAgentRun(makeIssue({ id: "uuid-abc", identifier: "XYZ-99999" }), APP);
  const issue = run.spec.issue as Record<string, unknown>;
  assert.equal(issue.id, "XYZ-99999");
  assert.equal(issue.linearIssueId, "uuid-abc");
});

test("AgentRun targets the AF_WATCH_NAMESPACE (or default)", () => {
  const a = linearIssueToAgentRun(makeIssue(), APP);
  assert.equal((a.metadata as { namespace?: string }).namespace, "default");
  const b = linearIssueToAgentRun(makeIssue(), APP, { namespace: "demo" });
  assert.equal((b.metadata as { namespace?: string }).namespace, "demo");
});

test("AgentRun.spec.request.source is 'agent' (poller-origin)", () => {
  const run = linearIssueToAgentRun(makeIssue(), APP);
  assert.equal(run.spec.request?.source, "agent");
  assert.equal(run.spec.request?.mode, "baseline");
});

// ---------- applyAgentRun ----------

function makeFakeClients(behavior: "ok" | "409" | "500"): { clients: K8sClients; calls: AgentRun[] } {
  const calls: AgentRun[] = [];
  const clients = {
    objects: {
      create: async (obj: AgentRun) => {
        calls.push(obj);
        if (behavior === "409") {
          const err = new Error("already exists") as Error & { statusCode: number };
          err.statusCode = 409;
          throw err;
        }
        if (behavior === "500") {
          const err = new Error("server error") as Error & { statusCode: number };
          err.statusCode = 500;
          throw err;
        }
        return obj;
      },
    },
  } as unknown as K8sClients;
  return { clients, calls };
}

test("applyAgentRun returns 'created' on success", async () => {
  const { clients, calls } = makeFakeClients("ok");
  const run = linearIssueToAgentRun(makeIssue(), APP);
  const result = await applyAgentRun(clients, run);
  assert.equal(result, "created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.name, "triage-test-99999");
});

test("applyAgentRun treats 409 Conflict as 'already-exists' (idempotency contract)", async () => {
  const { clients } = makeFakeClients("409");
  const run = linearIssueToAgentRun(makeIssue(), APP);
  const result = await applyAgentRun(clients, run);
  assert.equal(result, "already-exists");
});

// ---------- pickNamespace ----------

test("pickNamespace prefers AF_WATCH_NAMESPACE over POD_NAMESPACE", () => {
  assert.equal(pickNamespace("ns-explicit", "ns-downward"), "ns-explicit");
});

test("pickNamespace falls back to POD_NAMESPACE when AF_WATCH_NAMESPACE is empty", () => {
  // Caught by smoke test 2026-05-23: previously the fallback was hardcoded
  // "default" so CRs landed where the AgentApp didn't live, and every run
  // failed AppRefUnresolved. POD_NAMESPACE via downward API fixes this.
  assert.equal(pickNamespace(undefined, "agent-factory"), "agent-factory");
  assert.equal(pickNamespace("", "agent-factory"), "agent-factory");
  assert.equal(pickNamespace("   ", "agent-factory"), "agent-factory");
});

test("pickNamespace returns undefined when both are empty (caller picks final default)", () => {
  assert.equal(pickNamespace(undefined, undefined), undefined);
  assert.equal(pickNamespace("", ""), undefined);
});

test("pickNamespace trims whitespace", () => {
  assert.equal(pickNamespace("  ns-padded  "), "ns-padded");
});

test("applyAgentRun re-throws non-409 errors", async () => {
  const { clients } = makeFakeClients("500");
  const run = linearIssueToAgentRun(makeIssue(), APP);
  await assert.rejects(applyAgentRun(clients, run), /server error/);
});

test("POLLER_MAX_ISSUES_PER_POLL is read and validated", () => {
  const cfg = loadLinearPollerConfigFromEnv({
    LINEAR_API_KEY: "k",
    AF_LINEAR_QUERY: "label:x",
    LINEAR_DEFAULT_APP_FILE: "/x.yaml",
    POLLER_MAX_ISSUES_PER_POLL: "50"
  });
  assert.equal(cfg.maxIssuesPerPoll, 50);

  assert.throws(
    () => loadLinearPollerConfigFromEnv({
      LINEAR_API_KEY: "k",
      AF_LINEAR_QUERY: "label:x",
      LINEAR_DEFAULT_APP_FILE: "/x.yaml",
      POLLER_MAX_ISSUES_PER_POLL: "0"
    }),
    /must be a positive integer/
  );
});
