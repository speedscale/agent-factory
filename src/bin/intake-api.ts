import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRunPhase } from "../contracts/index.js";
import type { AgentApp } from "../contracts/index.js";
import type { IntakeRequest } from "../lib/run-store.js";
import { listRuns, loadRun } from "../lib/run-admin.js";
import { createRunQueueFromEnv } from "../lib/run-queue.js";
import { createRunFromIssue } from "../lib/run-store.js";
import { resolveFromRepo } from "../lib/io.js";
import { parse as parseYaml } from "yaml";

const apiToken = process.env.INTAKE_API_TOKEN;
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const githubBotToken = process.env.GITHUB_BOT_TOKEN ?? process.env.GH_TOKEN;
const githubApiBase = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
const allowUnknownRepos = process.env.INTAKE_ALLOW_UNKNOWN_REPOS === "true";
const commentOnSkippedIssue = process.env.INTAKE_COMMENT_ON_SKIPPED_ISSUE === "true";
const allowedRepos = new Set(
  (process.env.INTAKE_ALLOWED_REPOS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
);
function parseRepoAppMapFromEnv(): Map<string, string> {
  const raw = process.env.INTAKE_REPO_APP_MAP_JSON ?? "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INTAKE_REPO_APP_MAP_JSON must be valid JSON object");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("INTAKE_REPO_APP_MAP_JSON must be a JSON object");
  }

  return new Map<string, string>(
    Object.entries(parsed).map(([repo, appPath]) => [repo.trim().toLowerCase(), String(appPath)])
  );
}

const repoAppMap = parseRepoAppMapFromEnv();
const appCache = new Map<string, AgentApp>();
const evidenceDiscoverySources = new Set(["logs", "speedscale-capture", "both", "unknown"]);
const trivialCommands = new Set(["true", ":", "exit 0", "/bin/true"]);

interface GitHubIssueEvent {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    full_name: string;
  };
}

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

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readRawBody(req)).trim();
  if (raw.length === 0) {
    return undefined;
  }

  return JSON.parse(raw) as unknown;
}

function verifyGitHubSignature(req: IncomingMessage, rawBody: string): boolean {
  if (!githubWebhookSecret || githubWebhookSecret.length === 0) {
    return true;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const providedHex = signatureHeader.slice("sha256=".length);
  const expectedHex = createHmac("sha256", githubWebhookSecret).update(rawBody, "utf8").digest("hex");
  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

function isGitHubIssueEvent(value: unknown): value is GitHubIssueEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;

  return (
    typeof payload.action === "string" &&
    typeof issue === "object" &&
    issue !== null &&
    typeof issue.number === "number" &&
    typeof issue.title === "string" &&
    (typeof issue.body === "string" || issue.body === null) &&
    typeof issue.html_url === "string" &&
    Array.isArray(issue.labels) &&
    issue.labels.every(
      (label) => typeof label === "object" && label !== null && typeof (label as { name?: unknown }).name === "string"
    ) &&
    typeof repository === "object" &&
    repository !== null &&
    typeof repository.full_name === "string"
  );
}

async function loadAgentAppFromMapping(repoFullName: string): Promise<AgentApp | undefined> {
  const key = repoFullName.toLowerCase();
  const mappedPath = repoAppMap.get(key);
  if (!mappedPath) {
    return undefined;
  }

  if (appCache.has(key)) {
    return appCache.get(key);
  }

  const filePath = path.isAbsolute(mappedPath) ? mappedPath : resolveFromRepo(mappedPath);
  const raw = await readFile(filePath, "utf8");
  const isJson = mappedPath.endsWith(".json");
  const parsed = (isJson ? JSON.parse(raw) : parseYaml(raw)) as AgentApp;

  appCache.set(key, parsed);
  return parsed;
}

function issueHasRequiredLabels(app: AgentApp, labels: string[]): boolean {
  const required = app.spec.issue?.labels?.include ?? [];
  if (required.length === 0) {
    return true;
  }

  const present = new Set(labels.map((label) => label.toLowerCase()));
  return required.every((label) => present.has(label.toLowerCase()));
}

async function createIssueComment(repoFullName: string, issueNumber: number, body: string): Promise<void> {
  if (!githubBotToken || githubBotToken.trim().length === 0) {
    return;
  }

  const response = await fetch(`${githubApiBase}/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubBotToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "agent-factory-intake"
    },
    body: JSON.stringify({ body })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`failed to comment on issue ${repoFullName}#${issueNumber}: ${response.status} ${text}`);
  }
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

async function githubIssueWebhookHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const eventName = req.headers["x-github-event"];
  if (eventName !== "issues") {
    sendJson(res, 202, { message: "ignored github event", event: eventName ?? "unknown" });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifyGitHubSignature(req, rawBody)) {
    sendJson(res, 401, { error: "invalid webhook signature" });
    return;
  }

  const payload = JSON.parse(rawBody || "{}") as unknown;
  if (!isGitHubIssueEvent(payload)) {
    sendJson(res, 400, { error: "invalid github issue webhook payload" });
    return;
  }

  if (payload.action !== "opened" && payload.action !== "reopened" && payload.action !== "labeled") {
    sendJson(res, 202, { message: "ignored issue action", action: payload.action });
    return;
  }

  const repoFullName = payload.repository.full_name.toLowerCase();
  if (!allowUnknownRepos && allowedRepos.size > 0 && !allowedRepos.has(repoFullName)) {
    sendJson(res, 403, { error: `repository not allowlisted: ${repoFullName}` });
    return;
  }

  const app = await loadAgentAppFromMapping(repoFullName);
  if (!app) {
    if (commentOnSkippedIssue) {
      await createIssueComment(
        repoFullName,
        payload.issue.number,
        "Thanks for opening this issue. Agent Factory does not have an onboarding manifest for this repository yet, so I cannot run an automated fix attempt."
      );
    }

    sendJson(res, 202, { message: "no app manifest mapping for repository", repository: repoFullName });
    return;
  }

  const issueLabels = payload.issue.labels.map((label) => label.name);
  if (!issueHasRequiredLabels(app, issueLabels)) {
    if (commentOnSkippedIssue) {
      const required = app.spec.issue?.labels?.include ?? [];
      await createIssueComment(
        repoFullName,
        payload.issue.number,
        `Thanks for opening this issue. I can auto-process this repository when labels are present: ${required.join(", ") || "<none>"}.`
      );
    }

    sendJson(res, 202, {
      message: "issue does not match required labels",
      repository: repoFullName,
      requiredLabels: app.spec.issue?.labels?.include ?? []
    });
    return;
  }

  const intake: IntakeRequest = {
    app,
    issue: {
      id: String(payload.issue.number),
      title: payload.issue.title,
      body: payload.issue.body ?? "",
      url: payload.issue.html_url
    }
  };

  const run = await createRunFromIssue(intake);
  sendJson(res, 201, {
    message: "queued run from github issue webhook",
    repository: repoFullName,
    action: payload.action,
    run
  });
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

  if (req.method === "POST" && parsedUrl.pathname === "/webhooks/github/issues") {
    try {
      await githubIssueWebhookHandler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to process github webhook";
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
