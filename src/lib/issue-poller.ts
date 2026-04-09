import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "redis";
import { parse as parseYaml } from "yaml";
import type { AgentApp } from "../contracts/index.js";
import { createGitHubAuthProviderFromEnv } from "./github-auth.js";
import { resolveFromRepo } from "./io.js";
import { createRunFromIssue, type IntakeRequest } from "./run-store.js";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

type PollerRedisClient = ReturnType<typeof createClient>;

interface PollerConfig {
  githubApiBase: string;
  repoMapFile?: string;
  repoMapJson?: string;
  redisUrl: string;
  statePrefix: string;
  maxIssuesPerRepo: number;
  repos: string[];
}

function loadPollerConfigFromEnv(): PollerConfig {
  return {
    githubApiBase: process.env.GITHUB_API_BASE_URL ?? "https://api.github.com",
    repoMapFile: process.env.INTAKE_REPO_APP_MAP_FILE,
    repoMapJson: process.env.INTAKE_REPO_APP_MAP_JSON,
    redisUrl: process.env.POLLER_STATE_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    statePrefix: process.env.POLLER_STATE_KEY_PREFIX ?? "agent-factory:poller",
    maxIssuesPerRepo: Number(process.env.POLLER_MAX_ISSUES_PER_REPO ?? "20"),
    repos: (process.env.INTAKE_ALLOWED_REPOS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  };
}

function parseRepoAppMapFromJson(raw: string): Map<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("repo app map must be a JSON object");
  }

  return new Map<string, string>(
    Object.entries(parsed).map(([repo, appPath]) => [repo.trim().toLowerCase(), String(appPath)])
  );
}

async function loadRepoAppMap(config: PollerConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  if (config.repoMapJson && config.repoMapJson.trim().length > 0) {
    for (const [repo, appPath] of parseRepoAppMapFromJson(config.repoMapJson)) {
      map.set(repo, appPath);
    }
  }

  if (config.repoMapFile && config.repoMapFile.trim().length > 0) {
    const filePath = path.isAbsolute(config.repoMapFile) ? config.repoMapFile : resolveFromRepo(config.repoMapFile);
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

async function createIssueComment(
  githubApiBase: string,
  token: string,
  repoFullName: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const response = await fetch(`${githubApiBase}/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "agent-factory-issue-poller"
    },
    body: JSON.stringify({ body })
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status}) /repos/${repoFullName}/issues/${issueNumber}/comments: ${responseBody}`
    );
  }
}

function hasRequiredLabels(app: AgentApp, issueLabels: string[]): boolean {
  const required = app.spec.issue?.labels?.include ?? [];
  if (required.length === 0) {
    return true;
  }

  const present = new Set(issueLabels.map((entry) => entry.toLowerCase()));
  return required.every((label) => present.has(label.toLowerCase()));
}

function processedKey(statePrefix: string, repo: string, issueNumber: number): string {
  return `${statePrefix}:processed:${repo}#${issueNumber}`;
}

function commentKey(statePrefix: string, repo: string, issueNumber: number, reason: string): string {
  return `${statePrefix}:commented:${reason}:${repo}#${issueNumber}`;
}

async function setIfAbsent(redis: PollerRedisClient, key: string): Promise<boolean> {
  const set = await redis.set(key, "1", { NX: true });
  return set === "OK";
}

async function markProcessed(redis: PollerRedisClient, statePrefix: string, repo: string, issueNumber: number): Promise<void> {
  await redis.set(processedKey(statePrefix, repo, issueNumber), "1");
}

async function isProcessed(redis: PollerRedisClient, statePrefix: string, repo: string, issueNumber: number): Promise<boolean> {
  const value = await redis.get(processedKey(statePrefix, repo, issueNumber));
  return value === "1";
}

async function fetchOpenIssues(githubApiBase: string, token: string, repo: string, maxIssuesPerRepo: number): Promise<GitHubIssue[]> {
  const pathSuffix = `/repos/${repo}/issues?state=open&per_page=${maxIssuesPerRepo}&sort=updated&direction=desc`;
  const response = await fetch(`${githubApiBase}${pathSuffix}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "agent-factory-issue-poller"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) ${pathSuffix}: ${body}`);
  }

  const issues = (await response.json()) as GitHubIssue[];
  return issues.filter((issue) => typeof issue.pull_request === "undefined");
}

async function handleIssue(
  redis: PollerRedisClient,
  config: PollerConfig,
  appMap: Map<string, string>,
  repo: string,
  issue: GitHubIssue,
  token: string
): Promise<void> {
  if (await isProcessed(redis, config.statePrefix, repo, issue.number)) {
    return;
  }

  const mappedAppPath = appMap.get(repo);
  if (!mappedAppPath) {
    if (await setIfAbsent(redis, commentKey(config.statePrefix, repo, issue.number, "no-manifest"))) {
      await createIssueComment(
        config.githubApiBase,
        token,
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
    if (await setIfAbsent(redis, commentKey(config.statePrefix, repo, issue.number, "labels"))) {
      const required = app.spec.issue?.labels?.include ?? [];
      await createIssueComment(
        config.githubApiBase,
        token,
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
  await markProcessed(redis, config.statePrefix, repo, issue.number);
  console.log(`queued run for ${repo}#${issue.number}`);
}

export async function runIssuePollerOnce(): Promise<void> {
  const config = loadPollerConfigFromEnv();
  if (config.repos.length === 0) {
    throw new Error("INTAKE_ALLOWED_REPOS must include at least one repo");
  }

  const githubAuth = createGitHubAuthProviderFromEnv({ requireProvider: true, githubApiBase: config.githubApiBase });
  if (!githubAuth) {
    throw new Error("GitHub auth provider was not configured");
  }

  const appMap = await loadRepoAppMap(config);
  const redis = createClient({ url: config.redisUrl });

  await redis.connect();
  try {
    for (const repo of config.repos) {
      const token = await githubAuth.getTokenForRepo(repo);
      const issues = await fetchOpenIssues(config.githubApiBase, token, repo, config.maxIssuesPerRepo);
      for (const issue of issues) {
        await handleIssue(redis, config, appMap, repo, issue, token);
      }
    }
  } finally {
    await redis.quit();
  }
}

export function parsePollerIntervalMs(raw: string | undefined): number {
  const value = Number(raw ?? "120000");
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("poller interval must be a positive integer");
  }
  return Math.floor(value);
}

export function startIssuePollerLoop(intervalMs: number): NodeJS.Timeout {
  const runLoop = async () => {
    try {
      await runIssuePollerOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`poll iteration failed: ${message}`);
    }
  };

  void runLoop();
  return setInterval(() => {
    void runLoop();
  }, intervalMs);
}
