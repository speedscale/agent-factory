import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalArchiveStorage } from "./archive/local.js";
import {
  recordAgentRun,
  buildBaseRecord,
  computePromptSha,
  type AgentRunRecord,
} from "./agent-run-recorder.js";
import type { AgentRun } from "../contracts/index.js";

function fakeRun(): AgentRun {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRun",
    metadata: { name: "triage-demo-001" },
    spec: {
      appRef: { name: "demo-node" },
      agent: "triage",
      engine: { kind: "claude-sdk", model: "claude-sonnet-4-6", endpoint: "https://api.anthropic.com" },
      issue: { id: "abc", title: "thing broken", body: "details", url: "https://example.com/x" },
      workspace: { root: "/tmp" },
    },
    status: { phase: "queued", artifacts: {} },
  };
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger(); } };
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "af-recorder-"));
}

test("buildBaseRecord copies ticket and engine fields", () => {
  const r = buildBaseRecord(fakeRun());
  assert.equal(r.runId, "triage-demo-001");
  assert.equal(r.agent, "triage");
  assert.equal(r.app, "demo-node");
  assert.equal(r.ticket.title, "thing broken");
  assert.equal(r.engine?.provider, "claude-sdk");
});

test("computePromptSha is stable and changes when prompts change", () => {
  const a = computePromptSha({ system: "s", user: "u" });
  const b = computePromptSha({ system: "s", user: "u" });
  const c = computePromptSha({ system: "s", user: "v" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("recordAgentRun writes the expected key", async () => {
  const root = await tmpRoot();
  const storage = new LocalArchiveStorage({ root });
  const record: AgentRunRecord = {
    ...buildBaseRecord(fakeRun()),
    prompts: { system: "SYS", user: "USR" },
    rawResponse: '{"verdict":"dispatch"}',
    parsed: { verdict: "dispatch", reasoning: "ok" },
  };
  const ok = await recordAgentRun(record, {
    storage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: silentLogger() as any,
    now: () => new Date("2026-05-23T12:00:00Z"),
  });
  assert.equal(ok, true);
  const buf = await storage.get("agent-runs/2026-05-23/triage-demo-001.json");
  const parsed = JSON.parse(buf.toString("utf8")) as AgentRunRecord;
  assert.equal(parsed.runId, "triage-demo-001");
  assert.equal(parsed.parsed?.verdict, "dispatch");
  assert.ok(parsed.prompts?.promptSha, "promptSha auto-filled");
});

test("recordAgentRun swallows storage errors and returns false", async () => {
  const broken = {
    async put() {
      throw new Error("disk full");
    },
    async get() {
      throw new Error("nope");
    },
    list() {
      return (async function* () {})();
    },
  };
  const ok = await recordAgentRun(buildBaseRecord(fakeRun()), {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storage: broken as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: silentLogger() as any,
  });
  assert.equal(ok, false);
});
