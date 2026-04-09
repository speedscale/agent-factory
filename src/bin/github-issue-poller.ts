import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "redis";
import { parse as parseYaml } from "yaml";
import type { AgentApp } from "../contracts/index.js";
import { createGitHubAuthProviderFromEnv } from "../lib/github-auth.js";
import { resolveFromRepo } from "../lib/io.js";
import { createRunFromIssue, type IntakeRequest } from "../lib/run-store.js";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

const githubApiBase = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
const repoMapFile = process.env.INTAKE_REPO_APP_MAP_FILE;
const repoMapJson = process.env.INTAKE_REPO_APP_MAP_JSON;
const redisUrl = process.env.POLLER_STATE_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const statePrefix = process.env.POLLER_STATE_KEY_PREFIX ?? "agent-factory:poller";
const maxIssuesPerRepo = Number(process.env.POLLER_MAX_ISSUES_PER_REPO ?? "20");
const githubAuth = createGitHubAuthProviderFromEnv({ requireProvider: true, githubApiBase });

function requiredGitHubAuth() {
  if (!githubAuth) {
    throw new Error("GitHub auth provider was not configured");
  }

  return githubAuth;
}

const repos = (process.env.INTAKE_ALLOWED_REPOS ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0);

function parseRepoAppMapFromJson(raw: string): Map<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("repo app map must be a JSON object");
  }

  return new Map<string, string>(
    Object.entries(parsed).map(([repo, appPath]) => [repo.trim().toLowerCase(), String(appPath)])
  );
}

async function loadRepoAppMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  if (repoMapJson && repoMapJson.trim().length > 0) {
    for (const [repo, appPath] of parseRepoAppMapFromJson(repoMapJson)) {
      map.set(repo, appPath);
    }
  }

  if (repoMapFile && repoMapFile.trim().length > 0) {
    const filePath = path.isAbsolute(repoMapFile) ? repoMapFile : resolveFromRepo(repoMapFile);
    const raw = await readFile(filePath, "utf8");
    for (const [repo, appPath] of parseRepoAppMapFromJson(raw)) {
      map.set(repo, appPath);
    }
  }

  return map;
}

async function loadAgentApp(appPath: string): Promise<AgentApp> {
  const filePath = path.isAbsolute(appPath) ? appPath : resolveFromRepo(appPath);
  const raw = await readFile(filePath, "utf8");
  if (appPath.endsWith(".json")) {
    return JSON.parse(raw) as AgentApp;
  }
  return parseYaml(raw) as AgentApp;
}

async function githubRequest<T>(repoFullName: string, pathSuffix: string, init?: RequestInit): Promise<T> {
  const token = await requiredGitHubAuth().getTokenForRepo(repoFullName);

  const response = await fetch(`${githubApiBase}${pathSuffix}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "agent-factory-issue-poller",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) ${pathSuffix}: ${body}`);
  }

  return (await response.json()) as T;
}

async function createIssueComment(repoFullName: string, issueNumber: number, body: string): Promise<void> {
  await githubRequest(repoFullName, `/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

function hasRequiredLabels(app: AgentApp, issueLabels: string[]): boolean {
  const required = app.spec.issue?.labels?.include ?? [];
  if (required.length === 0) {
    return true;
  }

  const present = new Set(issueLabels.map((entry) => entry.toLowerCase()));
  return required.every((label) => present.has(label.toLowerCase()));
}

function processedKey(repo: string, issueNumber: number): string {
  return `${statePrefix}:processed:${repo}#${issueNumber}`;
}

function commentKey(repo: string, issueNumber: number, reason: string): string {
  return `${statePrefix}:commented:${reason}:${repo}#${issueNumber}`;
}

async function setIfAbsent(redis: PollerRedisClient, key: string): Promise<boolean> {
  const set = await redis.set(key, "1", { NX: true });
  return set === "OK";
}

async function markProcessed(redis: PollerRedisClient, repo: string, issueNumber: number): Promise<void> {
  await redis.set(processedKey(repo, issueNumber), "1");
}

async function isProcessed(redis: PollerRedisClient, repo: string, issueNumber: number): Promise<boolean> {
  const value = await redis.get(processedKey(repo, issueNumber));
  return value === "1";
}

async function fetchOpenIssues(repo: string): Promise<GitHubIssue[]> {
  const pathSuffix = `/repos/${repo}/issues?state=open&per_page=${maxIssuesPerRepo}&sort=updated&direction=desc`;
  const issues = await githubRequest<GitHubIssue[]>(repo, pathSuffix);
  return issues.filter((issue) => typeof issue.pull_request === "undefined");
}

async function handleIssue(
  redis: PollerRedisClient,
  appMap: Map<string, string>,
  repo: string,
  issue: GitHubIssue
): Promise<void> {
  if (await isProcessed(redis, repo, issue.number)) {
    return;
  }

  const mappedAppPath = appMap.get(repo);
  if (!mappedAppPath) {
    if (await setIfAbsent(redis, commentKey(repo, issue.number, "no-manifest"))) {
      await createIssueComment(
        repo,
        issue.number,
        "Thanks for opening this issue. Agent Factory does not have an onboarding manifest for this repository yet, so I cannot run an automated fix attempt."
      );
    }
    return;
  }

  const app = await loadAgentApp(mappedAppPath);
  const issueLabels = issue.labels.map((label) => label.name);
  if (!hasRequiredLabels(app, issueLabels)) {
    if (await setIfAbsent(redis, commentKey(repo, issue.number, "labels"))) {
      const required = app.spec.issue?.labels?.include ?? [];
      await createIssueComment(
        repo,
        issue.number,
        `Agent Factory is watching this repository. To queue an autonomous run, add these labels: ${required.join(", ") || "<none>"}.`
      );
    }
    return;
  }

  const intake: IntakeRequest = {
    app,
    issue: {
      id: String(issue.number),
      title: issue.title,
      body: issue.body ?? "",
      url: issue.html_url
    }
  };

  await createRunFromIssue(intake);
  await markProcessed(redis, repo, issue.number);
  console.log(`queued run for ${repo}#${issue.number}`);
}

async function runOnce(): Promise<void> {
  if (repos.length === 0) {
    throw new Error("INTAKE_ALLOWED_REPOS must include at least one repo");
  }

  const appMap = await loadRepoAppMap();
  const redis = createClient({ url: redisUrl });

  await redis.connect();
  try {
    for (const repo of repos) {
      const issues = await fetchOpenIssues(repo);
      for (const issue of issues) {
        await handleIssue(redis, appMap, repo, issue);
      }
    }
  } finally {
    await redis.quit();
  }
}

function parseIntervalMs(): number {
  const raw = Number(process.env.POLLER_INTERVAL_MS ?? "120000");
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("POLLER_INTERVAL_MS must be a positive integer");
  }
  return Math.floor(raw);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await runOnce();
    return;
  }

  const intervalMs = parseIntervalMs();
  while (true) {
    try {
      await runOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`poll iteration failed: ${message}`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(message);
  process.exitCode = 1;
});
type PollerRedisClient = ReturnType<typeof createClient>;
