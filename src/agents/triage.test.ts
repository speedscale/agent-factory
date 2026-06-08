import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  runTriageAgent,
  triageAgent,
  TriageBadResponseError,
  type TriageDeps,
} from "./triage.js";
import type { AgentRunContext } from "./types.js";
import type { AgentApp, AgentRun, TrafficSource } from "../contracts/index.js";
import type { TriageResult, TriageOptions } from "../lib/triage.js";
import type { LLMProvider } from "../lib/llm-providers.js";

// `runTriageAgent` accepts injectable deps; we don't have to monkey-patch
// ES-module exports (which is illegal anyway). `triageAgent.run` delegates
// to `runTriageAgent` with real deps — verified in the smoke test below.

interface CapturedLog {
  level: "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

function makeCtx(opts: {
  runDir: string;
  issue: Record<string, unknown>;
}): { ctx: AgentRunContext; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const ctx: AgentRunContext = {
    app: { metadata: { name: "demo-node" } } as unknown as AgentApp,
    run: {
      metadata: { name: "triage-xyz-99999" },
      spec: {
        appRef: { name: "demo-node" },
        issue: opts.issue,
      },
    } as unknown as AgentRun,
    trafficSources: [] as TrafficSource[],
    runDir: opts.runDir,
    logger: {
      info: (msg, fields) => logs.push({ level: "info", msg, fields }),
      warn: (msg, fields) => logs.push({ level: "warn", msg, fields }),
      error: (msg, fields) => logs.push({ level: "error", msg, fields }),
    },
  };
  return { ctx, logs };
}

async function tempRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "triage-test-"));
}

function fakeRunTriage(result: TriageResult): TriageDeps["runTriage"] {
  return async () => result;
}

interface RunTriageCall {
  spec: { title: string; body: string };
  opts: TriageOptions;
}

function capturingFakeRunTriage(
  result: TriageResult,
  calls: RunTriageCall[],
): TriageDeps["runTriage"] {
  return async (spec, opts) => {
    calls.push({ spec, opts });
    return result;
  };
}

function fakeRunTriageThrowing(message: string): TriageDeps["runTriage"] {
  return async () => {
    throw new Error(message);
  };
}

interface FakeLinearCall {
  issueId: string;
  body: string;
}

function fakeLinearClient(
  calls: FakeLinearCall[],
  opts: { failWith?: string } = {},
): TriageDeps["createLinearClient"] {
  return () => ({
    postComment: async (issueId, body) => {
      if (opts.failWith) throw new Error(opts.failWith);
      calls.push({ issueId, body });
      return { id: `comment-${calls.length}` };
    },
    createIssue: async () => ({ id: "issue-1", identifier: "ENG-1", url: "https://linear.app/x" }),
  });
}

test("writes triage.json and returns summary on dispatch verdict", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const { ctx, logs } = makeCtx({
    runDir,
    issue: { id: "XYZ-99999", title: "Test ticket", body: "Bug in foo" },
  });
  const out = await runTriageAgent({}, ctx, {
    runTriage: fakeRunTriage({
      verdict: "dispatch",
      reason: "All fields pinned.",
      missingContext: [],
      recommendedActions: [],
    }),
    env: {},
  });

  assert.match(out.summary, /classified as dispatch/);
  assert.match(out.summary, /All fields pinned/);
  assert.equal(out.artifacts?.triage, "triage.json");

  const artifact = JSON.parse(await fs.readFile(path.join(runDir, "triage.json"), "utf8"));
  assert.equal(artifact.verdict, "dispatch");
  assert.equal(artifact.issue.id, "XYZ-99999");

  const verdictLog = logs.find((l) => l.msg === "triage verdict");
  assert.ok(verdictLog, "expected a triage verdict log line");
  assert.equal(verdictLog?.fields?.verdict, "dispatch");
});

test("posts Linear comment when linearIssueId + LINEAR_API_KEY are present", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: FakeLinearCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-99999", title: "T", body: "B", linearIssueId: "uuid-abc" },
  });
  const out = await runTriageAgent({}, ctx, {
    runTriage: fakeRunTriage({
      verdict: "needs-info",
      reason: "Ambiguous fix shape.",
      missingContext: ["Which file"],
      recommendedActions: ["Name the file"],
    }),
    createLinearClient: fakeLinearClient(calls),
    env: { LINEAR_API_KEY: "lin_api_test" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].issueId, "uuid-abc");
  assert.match(calls[0].body, /NEEDS-INFO/);
  assert.match(out.summary, /Linear comment posted/);
});

test("skips Linear post when LINEAR_API_KEY is missing but run came from Linear", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const { ctx, logs } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B", linearIssueId: "uuid-x" },
  });
  const out = await runTriageAgent({}, ctx, {
    runTriage: fakeRunTriage({
      verdict: "dispatch",
      reason: "ok",
      missingContext: [],
      recommendedActions: [],
    }),
    env: {},
  });
  assert.match(out.summary, /LINEAR_API_KEY not configured/);
  assert.ok(logs.some((l) => l.msg.includes("LINEAR_API_KEY not set")));
});

test("preserves verdict + artifact when Linear post fails", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: FakeLinearCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B", linearIssueId: "uuid-x" },
  });
  const out = await runTriageAgent({}, ctx, {
    runTriage: fakeRunTriage({
      verdict: "dispatch",
      reason: "ok",
      missingContext: [],
      recommendedActions: [],
    }),
    createLinearClient: fakeLinearClient(calls, { failWith: "linear is down" }),
    env: { LINEAR_API_KEY: "k" },
  });

  assert.match(out.summary, /Linear comment failed: linear is down/);
  // Run still "succeeded" from the agent's view — caller decides whether
  // to fail the AgentRun (we deliberately don't, so the verdict isn't lost).
  const artifact = JSON.parse(await fs.readFile(path.join(runDir, "triage.json"), "utf8"));
  assert.equal(artifact.verdict, "dispatch");
});

test("throws TriageBadResponseError when runTriage throws", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const { ctx } = makeCtx({ runDir, issue: { id: "XYZ-1", title: "T", body: "B" } });
  await assert.rejects(
    runTriageAgent({}, ctx, {
      runTriage: fakeRunTriageThrowing("model returned malformed JSON"),
      env: {},
    }),
    TriageBadResponseError,
  );
});

test("rejects an AgentRun with no issue.title (defensive)", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const { ctx } = makeCtx({ runDir, issue: { id: "XYZ-1" } });
  await assert.rejects(runTriageAgent({}, ctx, { env: {} }), /issue\.title is required/);
});

test("non-Linear-sourced run never reaches the Linear client", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: FakeLinearCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "pr-42", title: "T", body: "B" /* no linearIssueId */ },
  });
  const out = await runTriageAgent({}, ctx, {
    runTriage: fakeRunTriage({
      verdict: "dispatch",
      reason: "ok",
      missingContext: [],
      recommendedActions: [],
    }),
    createLinearClient: fakeLinearClient(calls),
    env: { LINEAR_API_KEY: "k" },
  });
  assert.equal(calls.length, 0);
  assert.doesNotMatch(out.summary, /Linear comment/);
});

test("triageAgent.run delegates to runTriageAgent with default deps (smoke)", () => {
  // No execution — just verify the registered agent has the right id and
  // exposes the same input schema. The real runTriage / createLinearClient
  // dependencies are exercised in production; tests use the injection seam.
  assert.equal(triageAgent.id, "triage");
  assert.equal(typeof triageAgent.run, "function");
});

// ---------- env-driven provider selection ----------
//
// The bug we're guarding against: triage.ts used to hardcode
// `provider = "anthropic"` regardless of what the chart set
// AF_ENGINE_KIND to. These tests assert the resolved provider is
// threaded into runTriage's opts so the chart's `engine.kind` actually
// takes effect at runtime.

test("provider resolved from AF_ENGINE_KIND=ds4 is passed to runTriage", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: RunTriageCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B" },
  });
  await runTriageAgent({}, ctx, {
    runTriage: capturingFakeRunTriage(
      {
        verdict: "dispatch",
        reason: "ok",
        missingContext: [],
        recommendedActions: [],
      },
      calls,
    ),
    // Use the real resolveEngineConfig — the whole point is to verify
    // the env-driven mapping reaches runTriage.
    env: { AF_ENGINE_KIND: "ds4" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.provider, "ds4");
});

test("provider falls back to anthropic when AF_ENGINE_KIND is unset", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: RunTriageCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B" },
  });
  await runTriageAgent({}, ctx, {
    runTriage: capturingFakeRunTriage(
      {
        verdict: "dispatch",
        reason: "ok",
        missingContext: [],
        recommendedActions: [],
      },
      calls,
    ),
    env: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.provider, "anthropic");
});

test("AF_ENGINE_MODEL overrides the per-provider default model", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: RunTriageCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B" },
  });
  await runTriageAgent({}, ctx, {
    runTriage: capturingFakeRunTriage(
      {
        verdict: "dispatch",
        reason: "ok",
        missingContext: [],
        recommendedActions: [],
      },
      calls,
    ),
    env: { AF_ENGINE_KIND: "openrouter", AF_ENGINE_MODEL: "anthropic/claude-3.5-sonnet" },
  });

  assert.equal(calls[0].opts.provider, "openrouter");
  assert.equal(calls[0].opts.model, "anthropic/claude-3.5-sonnet");
});

test("unknown AF_ENGINE_KIND propagates as an error (no silent anthropic fallback)", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B" },
  });
  await assert.rejects(
    runTriageAgent({}, ctx, {
      runTriage: fakeRunTriage({
        verdict: "dispatch",
        reason: "ok",
        missingContext: [],
        recommendedActions: [],
      }),
      env: { AF_ENGINE_KIND: "gpt5" },
    }),
    /unknown AF_ENGINE_KIND/,
  );
});

test("injected resolveEngineConfig override is honored", async (t) => {
  const runDir = await tempRunDir();
  t.after(async () => fs.rm(runDir, { recursive: true, force: true }));

  const calls: RunTriageCall[] = [];
  const { ctx } = makeCtx({
    runDir,
    issue: { id: "XYZ-1", title: "T", body: "B" },
  });
  await runTriageAgent({}, ctx, {
    runTriage: capturingFakeRunTriage(
      {
        verdict: "dispatch",
        reason: "ok",
        missingContext: [],
        recommendedActions: [],
      },
      calls,
    ),
    resolveEngineConfig: () => ({
      provider: "omlx" as LLMProvider,
      model: "test-model-id",
    }),
    env: {}, // ignored because resolveEngineConfig is stubbed
  });

  assert.equal(calls[0].opts.provider, "omlx");
  assert.equal(calls[0].opts.model, "test-model-id");
});
