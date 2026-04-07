import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRunPhase } from "../contracts/index.js";
import type { IntakeRequest } from "../lib/run-store.js";
import { listRuns, loadRun } from "../lib/run-admin.js";
import { createRunQueueFromEnv } from "../lib/run-queue.js";
import { createRunFromIssue } from "../lib/run-store.js";

const apiToken = process.env.INTAKE_API_TOKEN;
const evidenceDiscoverySources = new Set(["logs", "speedscale-capture", "both", "unknown"]);
const trivialCommands = new Set(["true", ":", "exit 0", "/bin/true"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return typeof value === "undefined" || typeof value === "string";
}

function isOptionalCapture(value: unknown): boolean {
  if (typeof value === "undefined") {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  const capture = value as Record<string, unknown>;
  return (
    isOptionalString(capture.dataset) &&
    isOptionalString(capture.downloadCommand) &&
    isOptionalString(capture.requestResponseSummary)
  );
}

function isOptionalEvidence(value: unknown): boolean {
  if (typeof value === "undefined") {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  const evidence = value as Record<string, unknown>;
  const discovery = evidence.discovery as Record<string, unknown> | undefined;
  const reproduction = evidence.reproduction as Record<string, unknown> | undefined;

  return (
    typeof discovery === "object" &&
    discovery !== null &&
    typeof discovery.source === "string" &&
    evidenceDiscoverySources.has(discovery.source) &&
    typeof discovery.notes === "string" &&
    isOptionalCapture(evidence.capture) &&
    typeof reproduction === "object" &&
    reproduction !== null &&
    isStringArray(reproduction.steps) &&
    isOptionalString(reproduction.expectedBehavior) &&
    isOptionalString(reproduction.observedBehavior) &&
    isOptionalString(evidence.suspectedBug) &&
    isOptionalString(evidence.fixSummary)
  );
}

function isMeaningfulCommand(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !trivialCommands.has(normalized);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }

  return JSON.parse(raw) as unknown;
}

function isIntakeRequest(value: unknown): value is IntakeRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const app = candidate.app as Record<string, unknown> | undefined;
  const issue = candidate.issue as Record<string, unknown> | undefined;
  const evidence = candidate.evidence;

  if (
    typeof app !== "object" ||
    app === null ||
    app.apiVersion !== "agents.speedscale.io/v1alpha1" ||
    app.kind !== "AgentApp"
  ) {
    return false;
  }

  const appMetadata = app.metadata as Record<string, unknown> | undefined;
  const appSpec = app.spec as Record<string, unknown> | undefined;
  const appRepo = appSpec?.repo as Record<string, unknown> | undefined;
  const appBuild = appSpec?.build as Record<string, unknown> | undefined;
  const appValidate = appSpec?.validate as Record<string, unknown> | undefined;
  const appProxymock = appValidate?.proxymock as Record<string, unknown> | undefined;

  return (
    typeof appMetadata?.name === "string" &&
    typeof appRepo?.provider === "string" &&
    typeof appRepo?.url === "string" &&
    typeof appRepo?.defaultBranch === "string" &&
    typeof appRepo?.workdir === "string" &&
    isMeaningfulCommand(appBuild?.test) &&
    typeof appBuild?.install === "string" &&
    typeof appBuild?.start === "string" &&
    typeof appProxymock?.dataset === "string" &&
    typeof appProxymock?.mode === "string" &&
    isMeaningfulCommand(appProxymock?.command) &&
    typeof issue === "object" &&
    issue !== null &&
    typeof issue.id === "string" &&
    typeof issue.title === "string" &&
    typeof issue.body === "string" &&
    isOptionalEvidence(evidence)
  );
}

const allowedPhases: AgentRunPhase[] = [
  "queued",
  "planned",
  "building",
  "validating",
  "succeeded",
  "failed"
];

function parseRequestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "localhost";
  const path = req.url ?? "/";
  return new URL(path, `http://${host}`);
}

function parsePhase(value: string | null): AgentRunPhase | undefined {
  if (!value) {
    return undefined;
  }

  if (!allowedPhases.includes(value as AgentRunPhase)) {
    throw new Error(`unsupported phase '${value}'`);
  }

  return value as AgentRunPhase;
}

function parsePositiveInteger(value: string | null, fallback: number, key: string): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  return parsed;
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!apiToken || apiToken.length === 0) {
    return true;
  }

  const authorization = req.headers.authorization;
  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token === apiToken) {
      return true;
    }
  }

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey === apiToken) {
    return true;
  }

  return false;
}

function sendUnauthorized(res: ServerResponse): void {
  res.setHeader("www-authenticate", 'Bearer realm="agent-factory-intake"');
  sendJson(res, 401, { error: "unauthorized" });
}

async function listRunsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = parseRequestUrl(req);
  const phase = parsePhase(parsedUrl.searchParams.get("phase"));
  const limit = Math.min(parsePositiveInteger(parsedUrl.searchParams.get("limit"), 20, "limit"), 100);
  const offset = parsePositiveInteger(parsedUrl.searchParams.get("offset"), 0, "offset");

  const runs = await listRuns(phase);
  const page = runs.slice(offset, offset + limit);

  sendJson(res, 200, {
    count: page.length,
    total: runs.length,
    phase: phase ?? "all",
    limit,
    offset,
    runs: page.map((run) => ({
      name: run.metadata.name,
      app: run.spec.appRef.name,
      issue: {
        id: run.spec.issue.id,
        title: run.spec.issue.title
      },
      phase: run.status.phase,
      summary: run.status.summary ?? "",
      artifacts: run.status.artifacts
    }))
  });
}

async function getRunHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = parseRequestUrl(req);
  const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);
  const runName = segments[1];

  if (!runName) {
    sendJson(res, 400, { error: "run name is required" });
    return;
  }

  try {
    const run = await loadRun(runName);
    sendJson(res, 200, { run });
  } catch {
    sendJson(res, 404, { error: `run not found: ${runName}` });
  }
}

async function metricsHandler(res: ServerResponse): Promise<void> {
  const runs = await listRuns();
  const phaseCounts: Record<string, number> = {
    queued: 0,
    planned: 0,
    building: 0,
    validating: 0,
    succeeded: 0,
    failed: 0
  };

  for (const run of runs) {
    phaseCounts[run.status.phase] = (phaseCounts[run.status.phase] ?? 0) + 1;
  }

  const queue = createRunQueueFromEnv();

  try {
    const queueDepth = await queue.getQueueDepth();
    sendJson(res, 200, {
      service: "intake-api",
      generatedAt: new Date().toISOString(),
      runTotals: {
        total: runs.length,
        byPhase: phaseCounts
      },
      queue: {
        backend: queue.backend,
        depth: queueDepth
      }
    });
  } finally {
    await queue.close();
  }
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = parseRequestUrl(req);

  if (req.method === "GET" && parsedUrl.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "intake-api" });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/runs") {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    try {
      await listRunsHandler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid query params";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/metrics") {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    await metricsHandler(res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname.startsWith("/runs/")) {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    await getRunHandler(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/runs") {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    try {
      const body = await readJsonBody(req);

      if (!isIntakeRequest(body)) {
        sendJson(res, 400, {
          error:
            "request must include app.metadata.name and issue.id/title/body, and build.test + validate.proxymock.command must be non-trivial commands"
        });
        return;
      }

      const run = await createRunFromIssue(body);

      sendJson(res, 201, {
        message: "intake created a queued run",
        run
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request body";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const port = Number(process.env.PORT ?? "8080");

createServer((req, res) => {
  void handler(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unexpected server error";
    sendJson(res, 500, { error: message });
  });
}).listen(port, () => {
  console.log(`intake-api listening on http://localhost:${port}`);
});
