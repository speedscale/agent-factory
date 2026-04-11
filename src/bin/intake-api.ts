import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRunPhase } from "../contracts/index.js";
import type { AgentApp } from "../contracts/index.js";
import type { IntakeRequest } from "../lib/run-store.js";
import { createGitHubAuthProviderFromEnv } from "../lib/github-auth.js";
import { parsePollerIntervalMs, startIssuePollerLoop } from "../lib/issue-poller.js";
import { triggerWorkerJobForRun } from "../lib/k8s-worker-job.js";
import { listRuns, loadRun } from "../lib/run-admin.js";
import { createRunQueueFromEnv } from "../lib/run-queue.js";
import { createRunFromRequest } from "../lib/run-store.js";
import { resolveFromRepo } from "../lib/io.js";
import { parse as parseYaml } from "yaml";

const apiToken = process.env.INTAKE_API_TOKEN;
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const githubApiBase = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
const allowUnknownRepos = process.env.INTAKE_ALLOW_UNKNOWN_REPOS === "true";
const commentOnSkippedIssue = process.env.INTAKE_COMMENT_ON_SKIPPED_ISSUE === "true";
const repoAppMapFile = process.env.INTAKE_REPO_APP_MAP_FILE;
const allowedRepos = new Set(
  (process.env.INTAKE_ALLOWED_REPOS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
);
function parseRepoAppMapFromJson(raw: string): Map<string, string> {

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
const repoAppMap = new Map<string, string>();
const appCache = new Map<string, AgentApp>();
const githubAuth = createGitHubAuthProviderFromEnv({ githubApiBase });
const embeddedPollerEnabled = process.env.INTAKE_ENABLE_EMBEDDED_POLLER === "true";
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

interface GitHubPullRequestEvent {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    head: {
      sha: string;
      ref: string;
    };
    base: {
      sha: string;
      ref: string;
    };
  };
  repository: {
    full_name: string;
  };
}

interface QaIntakeEvent {
  source: "github-webhook" | "ai-agent" | "developer" | "manual";
  repository: {
    provider: "github";
    owner: string;
    name: string;
  };
  appRef: {
    name: string;
    qualityTarget?: string;
  };
  request: {
    mode: "comparison" | "baseline";
    pullRequest?: {
      number: number;
      url: string;
      headSha?: string;
      baseSha?: string;
    };
    branch?: string;
    commitSha?: string;
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

function isGitHubPullRequestEvent(value: unknown): value is GitHubPullRequestEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;

  const head = pullRequest?.head as Record<string, unknown> | undefined;
  const base = pullRequest?.base as Record<string, unknown> | undefined;

  return (
    typeof payload.action === "string" &&
    typeof pullRequest === "object" &&
    pullRequest !== null &&
    typeof pullRequest.number === "number" &&
    typeof pullRequest.title === "string" &&
    (typeof pullRequest.body === "string" || pullRequest.body === null) &&
    typeof pullRequest.html_url === "string" &&
    Array.isArray(pullRequest.labels) &&
    pullRequest.labels.every(
      (label) => typeof label === "object" && label !== null && typeof (label as { name?: unknown }).name === "string"
    ) &&
    typeof head === "object" &&
    head !== null &&
    typeof head.sha === "string" &&
    typeof head.ref === "string" &&
    typeof base === "object" &&
    base !== null &&
    typeof base.sha === "string" &&
    typeof base.ref === "string" &&
    typeof repository === "object" &&
    repository !== null &&
    typeof repository.full_name === "string"
  );
}

function isQaIntakeEvent(value: unknown): value is QaIntakeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const repository = candidate.repository as Record<string, unknown> | undefined;
  const appRef = candidate.appRef as Record<string, unknown> | undefined;
  const request = candidate.request as Record<string, unknown> | undefined;
  const pullRequest = request?.pullRequest as Record<string, unknown> | undefined;

  return (
    (candidate.source === "github-webhook" ||
      candidate.source === "ai-agent" ||
      candidate.source === "developer" ||
      candidate.source === "manual") &&
    typeof repository === "object" &&
    repository !== null &&
    repository.provider === "github" &&
    typeof repository.owner === "string" &&
    typeof repository.name === "string" &&
    typeof appRef === "object" &&
    appRef !== null &&
    typeof appRef.name === "string" &&
    (typeof appRef.qualityTarget === "undefined" || typeof appRef.qualityTarget === "string") &&
    typeof request === "object" &&
    request !== null &&
    (request.mode === "comparison" || request.mode === "baseline") &&
    (typeof pullRequest === "undefined" ||
      (typeof pullRequest.number === "number" &&
        typeof pullRequest.url === "string" &&
        (typeof pullRequest.headSha === "undefined" || typeof pullRequest.headSha === "string") &&
        (typeof pullRequest.baseSha === "undefined" || typeof pullRequest.baseSha === "string")))
  );
}

function resolveQualityTargets(app: AgentApp, requestedTargetName: string | undefined): Array<NonNullable<IntakeRequest["qualityTarget"]>> {
  const targets = app.spec.quality?.baseline?.targets ?? [];

  if (typeof requestedTargetName === "string") {
    const selected = targets.find((target) => target.name.toLowerCase() === requestedTargetName.toLowerCase());
    if (!selected) {
      throw new Error(`quality target '${requestedTargetName}' not found for app ${app.metadata.name}`);
    }

    return [
      {
        name: selected.name,
        workdir: selected.workdir,
        baselineRef: selected.baselineRef
      }
    ];
  }

  if (targets.length > 0) {
    return targets.map((target) => ({
      name: target.name,
      workdir: target.workdir,
      baselineRef: target.baselineRef
    }));
  }

  return [
    {
      name: app.metadata.name,
      workdir: app.spec.repo.workdir
    }
  ];
}

function toIssueId(baseId: string, targetName: string, totalTargets: number): string {
  if (totalTargets <= 1) {
    return baseId;
  }

  const suffix = targetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseId}-${suffix}`;
}

function buildIntakesFromQaEvent(app: AgentApp, qaEvent: QaIntakeEvent): IntakeRequest[] {
  const repositoryFullName = `${qaEvent.repository.owner}/${qaEvent.repository.name}`;
  const pullRequestNumber = qaEvent.request.pullRequest?.number;
  const baseIssueId =
    typeof pullRequestNumber === "number"
      ? `pr-${pullRequestNumber}`
      : `${qaEvent.request.mode}-manual-${Date.now()}`;
  const baseIssueTitle =
    typeof pullRequestNumber === "number"
      ? `Quality validation for PR #${pullRequestNumber}`
      : `Quality validation request (${qaEvent.request.mode})`;
  const qualityTargets = resolveQualityTargets(app, qaEvent.appRef.qualityTarget);

  return qualityTargets.map((qualityTarget) => ({
    app,
    issue: {
      id: toIssueId(baseIssueId, qualityTarget.name, qualityTargets.length),
      title:
        qualityTargets.length > 1
          ? `${baseIssueTitle} [target: ${qualityTarget.name}]`
          : baseIssueTitle,
      body: qaEvent.request.pullRequest?.url ?? "Manual quality validation request",
      url: qaEvent.request.pullRequest?.url
    },
    request: {
      source: qaEvent.request.pullRequest ? "pull_request" : qaEvent.source === "manual" ? "manual" : "agent",
      mode: qaEvent.request.mode,
      url: qaEvent.request.pullRequest?.url,
      pullRequest: qaEvent.request.pullRequest
        ? {
            repository: repositoryFullName,
            number: qaEvent.request.pullRequest.number,
            headSha: qaEvent.request.pullRequest.headSha,
            baseSha: qaEvent.request.pullRequest.baseSha
          }
        : undefined
    },
    qualityTarget
  }));
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

async function initializeRepoAppMap(): Promise<void> {
  const envJson = process.env.INTAKE_REPO_APP_MAP_JSON;
  if (envJson && envJson.trim().length > 0) {
    for (const [repo, appPath] of parseRepoAppMapFromJson(envJson)) {
      repoAppMap.set(repo, appPath);
    }
  }

  if (!repoAppMapFile || repoAppMapFile.trim().length === 0) {
    return;
  }

  const filePath = path.isAbsolute(repoAppMapFile) ? repoAppMapFile : resolveFromRepo(repoAppMapFile);
  const raw = await readFile(filePath, "utf8");
  for (const [repo, appPath] of parseRepoAppMapFromJson(raw)) {
    repoAppMap.set(repo, appPath);
  }
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
  if (!githubAuth) {
    return;
  }

  const token = await githubAuth.getTokenForRepo(repoFullName);

  const response = await fetch(`${githubApiBase}/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
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
      request: run.spec.request,
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

  const run = await queueRunAndTriggerWorker(intake);
  sendJson(res, 201, {
    message: "queued run from github issue webhook",
    repository: repoFullName,
    action: payload.action,
    run
  });
}

async function githubPullRequestWebhookHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const eventName = req.headers["x-github-event"];
  if (eventName !== "pull_request") {
    sendJson(res, 202, { message: "ignored github event", event: eventName ?? "unknown" });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifyGitHubSignature(req, rawBody)) {
    sendJson(res, 401, { error: "invalid webhook signature" });
    return;
  }

  const payload = JSON.parse(rawBody || "{}") as unknown;
  if (!isGitHubPullRequestEvent(payload)) {
    sendJson(res, 400, { error: "invalid github pull_request webhook payload" });
    return;
  }

  if (payload.action !== "opened" && payload.action !== "reopened" && payload.action !== "synchronize") {
    sendJson(res, 202, { message: "ignored pull_request action", action: payload.action });
    return;
  }

  const repoFullName = payload.repository.full_name.toLowerCase();
  if (!allowUnknownRepos && allowedRepos.size > 0 && !allowedRepos.has(repoFullName)) {
    sendJson(res, 403, { error: `repository not allowlisted: ${repoFullName}` });
    return;
  }

  const app = await loadAgentAppFromMapping(repoFullName);
  if (!app) {
    sendJson(res, 202, { message: "no app manifest mapping for repository", repository: repoFullName });
    return;
  }

  const labels = payload.pull_request.labels.map((label) => label.name);
  if (!issueHasRequiredLabels(app, labels)) {
    sendJson(res, 202, {
      message: "pull request does not match required labels",
      repository: repoFullName,
      requiredLabels: app.spec.issue?.labels?.include ?? []
    });
    return;
  }

  const [owner, name] = repoFullName.split("/");
  const qaIntake: QaIntakeEvent = {
    source: "github-webhook",
    repository: {
      provider: "github",
      owner,
      name
    },
    appRef: {
      name: app.metadata.name
    },
    request: {
      mode: "comparison",
      pullRequest: {
        number: payload.pull_request.number,
        url: payload.pull_request.html_url,
        headSha: payload.pull_request.head.sha,
        baseSha: payload.pull_request.base.sha
      }
    }
  };

  const queuedRuns = await Promise.all(buildIntakesFromQaEvent(app, qaIntake).map((intake) => queueRunAndTriggerWorker(intake)));
  sendJson(res, 201, {
    message: "queued run(s) from github pull_request webhook",
    repository: repoFullName,
    action: payload.action,
    runs: queuedRuns
  });
}

async function qaRunsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!isQaIntakeEvent(body)) {
    sendJson(res, 400, {
      error: "request must match schemas/qa-intake.schema.yaml"
    });
    return;
  }

  const repoFullName = `${body.repository.owner}/${body.repository.name}`.toLowerCase();
  if (!allowUnknownRepos && allowedRepos.size > 0 && !allowedRepos.has(repoFullName)) {
    sendJson(res, 403, { error: `repository not allowlisted: ${repoFullName}` });
    return;
  }

  const app = await loadAgentAppFromMapping(repoFullName);
  if (!app) {
    sendJson(res, 404, { error: `no app manifest mapping for repository: ${repoFullName}` });
    return;
  }

  if (app.metadata.name !== body.appRef.name) {
    sendJson(res, 400, {
      error: `appRef.name mismatch for ${repoFullName}: expected ${app.metadata.name}`
    });
    return;
  }

  const runs = await Promise.all(buildIntakesFromQaEvent(app, body).map((intake) => queueRunAndTriggerWorker(intake)));

  sendJson(res, 201, {
    message: "quality intake created queued run(s)",
    runs
  });
}

async function queueRunAndTriggerWorker(intake: IntakeRequest) {
  const run = await createRunFromRequest(intake);

  try {
    await triggerWorkerJobForRun(run.metadata.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed to trigger worker job for ${run.metadata.name}: ${message}`);
  }

  return run;
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
    sendJson(res, 410, {
      error: "legacy endpoint removed for quality-agent mode; use POST /qa/runs"
    });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/qa/runs") {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    try {
      await qaRunsHandler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request body";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/webhooks/github/issues") {
    sendJson(res, 410, {
      error: "legacy webhook removed for quality-agent mode; use POST /webhooks/github/pulls"
    });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/webhooks/github/pulls") {
    try {
      await githubPullRequestWebhookHandler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to process github webhook";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const port = Number(process.env.PORT ?? "8080");

async function main(): Promise<void> {
  await initializeRepoAppMap();

  if (embeddedPollerEnabled) {
    const intervalMs = parsePollerIntervalMs(process.env.POLLER_INTERVAL_MS);
    startIssuePollerLoop(intervalMs);
    console.log(`embedded quality poller enabled (intervalMs=${intervalMs})`);
  }

  createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unexpected server error";
      sendJson(res, 500, { error: message });
    });
  }).listen(port, () => {
    console.log(`intake-api listening on http://localhost:${port}`);
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed to start intake-api";
  console.error(message);
  process.exitCode = 1;
});
