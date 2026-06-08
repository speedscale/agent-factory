import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRunPhase } from "../contracts/index.js";
import type { AgentApp } from "../contracts/index.js";
import type { IntakeRequest } from "../lib/run-store.js";
import { parsePollerIntervalMs, startIssuePollerLoop } from "../lib/issue-poller.js";
import { startLinearPollerLoop } from "../lib/linear-poller.js";
import { triggerWorkerJobForRun } from "../lib/k8s-worker-job.js";
import { getInstanceConfig, formatInstanceBanner } from "../lib/instance-config.js";
import {
  createIntakeRegistry,
  createOtlpMetrics,
  renderPrometheusText,
  PROMETHEUS_CONTENT_TYPE,
  type IntakeRegistry
} from "../lib/metrics.js";
import { createK8sRunsLoader, countByPhase, mergeRuns } from "../lib/k8s-runs.js";
import { createLogger } from "../lib/logger.js";
import { listRuns, loadRun } from "../lib/run-admin.js";
import { createRunQueueFromEnv } from "../lib/run-queue.js";
import { createRunFromRequest } from "../lib/run-store.js";
import { resolveFromRepo } from "../lib/io.js";
import { parse as parseYaml } from "yaml";
import { OtlpBuffer } from "../lib/otlp-buffer.js";
import { createOtlpReceiver } from "../lib/otlp-receiver.js";
import { processClosedWindow } from "../lib/otlp-window-processor.js";

const apiToken = process.env.INTAKE_API_TOKEN;
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const githubApiBase = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
const allowUnknownRepos = process.env.INTAKE_ALLOW_UNKNOWN_REPOS === "true";
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
const embeddedPollerEnabled = process.env.INTAKE_ENABLE_EMBEDDED_POLLER === "true";

// One process-wide Prometheus registry seeded with the instance label so
// /metrics renders the same identity that startup banners do.
const intakeRegistry: IntakeRegistry = createIntakeRegistry(getInstanceConfig().instance);

// Structured logger for intake-api. Carries `instance` on every line; child
// loggers (per-request, per-run) layer additional fields on top.
const log = createLogger({
  component: "intake-api",
  fields: { instance: getInstanceConfig().instance },
});

// k8s LIST loader for AgentRuns. The HTTP intake writes run.json to the
// filesystem; the CRD intake writes to k8s — without this loader the
// dashboard reads 0 on every CRD-driven run.
//
// AF_WATCH_NAMESPACE is the same env var the controller uses; if a single
// namespace is in scope we share it so RBAC stays tight.
const k8sRunsLoader = createK8sRunsLoader({
  namespace: process.env.AF_WATCH_NAMESPACE || undefined,
});

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

/**
 * Compute the latest phase counts + queue depth and write them into the
 * shared Prometheus registry. Used by both /metrics (text) and
 * /metrics.json (JSON) so the two views stay consistent.
 *
 * Pulls runs from BOTH stores:
 *   - filesystem (`listRuns()`) — written by HTTP `POST /qa/runs`
 *   - kubernetes (`k8sRunsLoader.list()`) — written by `kubectl apply
 *     AgentRun` and the controller's status patches
 * deduped by `metadata.name`. Either source's failure is logged but does
 * not block the other; queue-depth lookup is similarly isolated so a
 * Redis hiccup never blanks the phase counts.
 */
async function refreshMetricsSnapshot(): Promise<{
  total: number;
  phaseCounts: Record<string, number>;
  queueBackend: string;
  queueDepth: number;
  sources: { filesystem: number; k8s: number };
}> {
  const [fsRuns, k8sRuns] = await Promise.all([
    listRuns().catch((err: unknown) => {
      log.warn("filesystem listRuns failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }),
    k8sRunsLoader.list().catch((err: unknown) => {
      log.warn("k8s listRuns failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }),
  ]);

  const merged = mergeRuns(fsRuns, k8sRuns);
  const phaseCounts = countByPhase(merged);

  // Push phase counts into the registry first, so even if the queue
  // backend is down the dashboard tiles still reflect the truth.
  for (const [phase, count] of Object.entries(phaseCounts)) {
    intakeRegistry.runsTotal.set({ phase }, count);
  }

  const queue = createRunQueueFromEnv();
  let queueDepth = 0;
  try {
    queueDepth = await queue.getQueueDepth();
    intakeRegistry.queueDepth.set({ backend: queue.backend }, queueDepth);
  } catch (err) {
    log.warn("queue depth lookup failed; phase counts still updated", {
      backend: queue.backend,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await queue.close().catch(() => undefined);
  }

  return {
    total: merged.length,
    phaseCounts,
    queueBackend: queue.backend,
    queueDepth,
    sources: { filesystem: fsRuns.length, k8s: k8sRuns.length },
  };
}

async function metricsPrometheusHandler(res: ServerResponse): Promise<void> {
  await refreshMetricsSnapshot();
  const text = await renderPrometheusText(intakeRegistry.registry);
  res.statusCode = 200;
  res.setHeader("content-type", PROMETHEUS_CONTENT_TYPE);
  res.end(text);
}

async function metricsJsonHandler(res: ServerResponse): Promise<void> {
  const snap = await refreshMetricsSnapshot();
  sendJson(res, 200, {
    service: "intake-api",
    generatedAt: new Date().toISOString(),
    runTotals: { total: snap.total, byPhase: snap.phaseCounts },
    queue: { backend: snap.queueBackend, depth: snap.queueDepth },
    sources: {
      filesystem: snap.sources.filesystem,
      k8s: snap.sources.k8s,
      k8sConfigured: k8sRunsLoader.isConfigured()
    }
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
      error: "request body must be a valid QaIntakeEvent (source, repository, sha, requestor)"
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

  // /metrics and /metrics.json are intentionally unauthenticated: Prometheus
  // scrape configs inside the cluster shouldn't need a bearer token, and
  // operators can gate external access via ingress rules. Both are
  // read-only and idempotent.
  if (req.method === "GET" && parsedUrl.pathname === "/metrics") {
    await metricsPrometheusHandler(res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/metrics.json") {
    await metricsJsonHandler(res);
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
  const instanceCfg = getInstanceConfig();
  console.log(formatInstanceBanner(instanceCfg, "intake-api"));

  await initializeRepoAppMap();

  if (embeddedPollerEnabled) {
    const intervalMs = parsePollerIntervalMs(process.env.POLLER_INTERVAL_MS);
    const source = (process.env.POLLER_SOURCE ?? "github").toLowerCase();
    if (source === "linear") {
      startLinearPollerLoop(intervalMs);
      console.log(`embedded Linear poller enabled (intervalMs=${intervalMs})`);
    } else if (source === "github") {
      startIssuePollerLoop(intervalMs);
      console.log(`embedded GitHub poller enabled (intervalMs=${intervalMs})`);
    } else {
      throw new Error(`unknown POLLER_SOURCE: ${source} (expected "github" or "linear")`);
    }
  }

  createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unexpected server error";
      sendJson(res, 500, { error: message });
    });
  }).listen(port, () => {
    console.log(`intake-api listening on http://localhost:${port}`);
  });

  // ── OTLP streaming receiver (opt-in via OTLP_RECEIVER_ENABLED=true) ──────
  const otlpEnabled = process.env.OTLP_RECEIVER_ENABLED === "true";
  if (otlpEnabled) {
    const otlpPort = Number(process.env.OTLP_RECEIVER_PORT ?? "4317");
    const windowMs = Number(process.env.OTLP_WINDOW_MS ?? "60000");
    const maxRecordsPerService = Number(process.env.OTLP_MAX_RECORDS_PER_SERVICE ?? "10000");
    const baselineDir = process.env.BASELINE_DIR ?? "/app/.work/baselines";

    const otlpMetrics = createOtlpMetrics(intakeRegistry.registry);
    intakeRegistry.otlp = otlpMetrics;

    const buffer = new OtlpBuffer({ windowMs, maxRecordsPerService });

    const grpcServer = createOtlpReceiver({
      port: otlpPort,
      buffer,
      logger: log,
      metrics: otlpMetrics,
    });

    // Timer: on each tick, close all non-empty windows and process them.
    const stopTimer = buffer.startTimer((windows) => {
      // Update buffer size metrics
      const stats = buffer.stats();
      for (const [svc, count] of stats.perService) {
        otlpMetrics.bufferSize.set({ service: svc }, count);
      }

      // Process each closed window asynchronously
      for (const win of windows) {
        void processClosedWindow(win, { baselineDir, logger: log, metrics: otlpMetrics });
      }
    });

    // Graceful shutdown: flush remaining windows before exit.
    const shutdown = () => {
      log.info("otlp-receiver shutting down, flushing windows");
      stopTimer();
      const remaining = buffer.flush();
      const flushPromises = remaining.map((win) =>
        processClosedWindow(win, { baselineDir, logger: log, metrics: otlpMetrics }),
      );
      void Promise.allSettled(flushPromises).then(() => {
        grpcServer.forceShutdown();
        log.info("otlp-receiver shutdown complete");
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    console.log(`otlp-receiver enabled (port=${otlpPort}, windowMs=${windowMs}, maxPerService=${maxRecordsPerService})`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed to start intake-api";
  console.error(message);
  process.exitCode = 1;
});
