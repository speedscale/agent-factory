import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processReproduceRun,
  signalReproduces,
  renderTicketBody,
  resolveReplayTarget,
  type ReproduceDeps,
} from "./reproduce-worker.js";
import type { AgentRun } from "../contracts/index.js";
import type { ScanStats, Signal } from "./rrpair-stats.js";

const SIGNAL: Signal = {
  kind: "errors",
  severity: "high",
  fingerprint: "abc123",
  title: "Errors: GET /api/sync — 50% non-2xx",
  details: "50/100 requests returned errors.",
  evidence: { host: "radar.speedscale.com", pattern: "GET:/api/sync", count: 100, errorRate: 0.5, examples: [] },
};

function makeRun(inputOverride: Record<string, unknown> = {}): AgentRun {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRun",
    metadata: { name: "reproduce-radar-abc123" },
    spec: {
      appRef: { name: "radar" },
      agent: "reproduce",
      input: {
        service: "radar",
        fingerprint: "abc123",
        signal: SIGNAL,
        evidenceKey: "agent-factory/stream-evidence/radar/abc123-ts.tgz",
        evidenceUri: "s3://bucket/agent-factory/stream-evidence/radar/abc123-ts.tgz",
        windowStart: "2026-06-08T00:00:00Z",
        windowEnd: "2026-06-08T00:01:00Z",
        ...inputOverride,
      },
      issue: { id: "abc123", title: SIGNAL.title, body: SIGNAL.details },
      workspace: { root: ".work/reproduce-radar-abc123" },
    },
    status: { phase: "queued", artifacts: {} },
  };
}

function statsWith(signals: Signal[]): ScanStats {
  return { snapshotDir: "/x", windowStart: "", windowEnd: "", totalFiles: 1, parsedOk: 1, signals, endpointStats: [] };
}

function fakeDeps(over: Partial<ReproduceDeps> = {}): ReproduceDeps {
  return {
    fetchEvidence: async () => ({}),
    extractTar: async () => {},
    replay: async () => null, // no replay target → capture re-analysis
    analyze: async () => statsWith([SIGNAL]),
    fileTicket: async () => ({ filed: true, ref: "ENG-42", url: "https://linear.app/x/ENG-42" }),
    ...over,
  };
}

test("signalReproduces matches by fingerprint", () => {
  assert.equal(signalReproduces(SIGNAL, statsWith([SIGNAL])), true);
  assert.equal(signalReproduces(SIGNAL, statsWith([])), false);
});

test("signalReproduces matches by kind+pattern when fingerprint shifts", () => {
  const shifted: Signal = { ...SIGNAL, fingerprint: "different" };
  assert.equal(signalReproduces(SIGNAL, statsWith([shifted])), true);
});

test("processReproduceRun confirms and files a ticket when the signal reproduces", async () => {
  const phases: Array<{ phase: string; summary: string }> = [];
  const updatePhase = async (phase: AgentRun["status"]["phase"], summary: string) => {
    phases.push({ phase, summary });
  };

  let ticketFiled = false;
  const result = await processReproduceRun(
    makeRun(),
    updatePhase,
    fakeDeps({ fileTicket: async () => { ticketFiled = true; return { filed: true, ref: "ENG-42" }; } }),
  );

  assert.equal(result.reproduced, true);
  assert.equal(result.method, "capture-reanalysis");
  assert.equal(result.ticket.filed, true);
  assert.equal(result.ticket.ref, "ENG-42");
  assert.equal(ticketFiled, true);
  assert.equal(phases.at(-1)?.phase, "succeeded");
});

test("processReproduceRun does not file a ticket when the signal does not reproduce", async () => {
  let ticketAttempted = false;
  const result = await processReproduceRun(
    makeRun(),
    async () => {},
    fakeDeps({
      analyze: async () => statsWith([]), // signal gone
      fileTicket: async () => { ticketAttempted = true; return { filed: true }; },
    }),
  );

  assert.equal(result.reproduced, false);
  assert.equal(result.ticket.filed, false);
  assert.equal(ticketAttempted, false, "should not attempt to file when not reproduced");
});

test("processReproduceRun uses replay method when a replay target is available", async () => {
  const result = await processReproduceRun(
    makeRun(),
    async () => {},
    fakeDeps({ replay: async ({ outDir }) => ({ outDir }) }),
  );
  assert.equal(result.method, "replay");
  assert.equal(result.reproduced, true);
});

test("processReproduceRun fails when there is no evidence key", async () => {
  const phases: string[] = [];
  await assert.rejects(
    processReproduceRun(
      makeRun({ evidenceKey: undefined }),
      async (phase) => { phases.push(phase); },
      fakeDeps(),
    ),
    /no archived evidence/,
  );
  assert.equal(phases.at(-1), "failed");
});

test("renderTicketBody includes the evidence URI and reproduce hint", () => {
  const body = renderTicketBody({
    service: "radar",
    signal: SIGNAL,
    method: "replay",
    evidenceUri: "s3://bucket/abc.tgz",
    windowStart: "2026-06-08T00:00:00Z",
    windowEnd: "2026-06-08T00:01:00Z",
  });
  assert.match(body, /s3:\/\/bucket\/abc\.tgz/);
  assert.match(body, /proxymock replay/);
  assert.match(body, /reproduced/);
});

test("resolveReplayTarget expands {service} and handles unset templates", () => {
  assert.equal(resolveReplayTarget(undefined, "banking-user"), null);
  assert.equal(resolveReplayTarget("", "banking-user"), null);
  assert.equal(resolveReplayTarget("   ", "banking-user"), null);
  assert.equal(
    resolveReplayTarget("http://gateway.banking-app.svc.cluster.local", "banking-user"),
    "http://gateway.banking-app.svc.cluster.local",
  );
  assert.equal(
    resolveReplayTarget("http://{service}.banking-app.svc.cluster.local", "banking-user"),
    "http://banking-user.banking-app.svc.cluster.local",
  );
});

test("processReproduceRun passes the signal's service to replay", async () => {
  let seenService: string | undefined;
  const result = await processReproduceRun(
    makeRun(),
    async () => {},
    fakeDeps({
      replay: async ({ outDir, service }) => {
        seenService = service;
        return { outDir };
      },
    }),
  );
  assert.equal(seenService, "radar");
  assert.equal(result.method, "replay");
});
