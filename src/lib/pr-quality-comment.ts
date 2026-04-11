import type { AgentApp, AgentRun, QualityReport } from "../contracts/index.js";
import { createGitHubAuthProviderFromEnv } from "./github-auth.js";
import { readJsonFile, resolveFromRepo } from "./io.js";

const COMMENT_MARKER = "<!-- agent-factory:quality-report -->";

function parseRepoFromUrl(repoUrl: string): string | undefined {
  const httpsMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return undefined;
}

function resolvePullRequestCoordinates(run: AgentRun, app: AgentApp): { repo: string; number: number } | undefined {
  const pullRequest = run.spec.request?.pullRequest;
  if (!pullRequest) {
    return undefined;
  }

  const repo = pullRequest.repository || parseRepoFromUrl(app.spec.repo.url);
  if (!repo) {
    return undefined;
  }

  return {
    repo,
    number: pullRequest.number
  };
}

function buildCommentBody(run: AgentRun, report: QualityReport): string {
  const reportPath = run.status.artifacts.qualityReportJson ?? "artifacts/<run>/quality-report.json";
  const markdownPath = run.status.artifacts.qualityReportMarkdown ?? "artifacts/<run>/quality-report.md";
  const highlights = report.spec.highlights.length > 0 ? report.spec.highlights.map((entry) => `- ${entry}`).join("\n") : "- none";

  return [
    COMMENT_MARKER,
    "## Agent Factory Quality Report",
    `- run: \`${run.metadata.name}\``,
    `- outcome: **${report.spec.outcome}**`,
    `- mode: \`${report.spec.mode}\``,
    `- target: \`${report.spec.target.name}\` (\`${report.spec.target.workdir}\`)`,
    `- summary: ${report.spec.summary}`,
    `- report artifact: \`${reportPath}\``,
    `- markdown artifact: \`${markdownPath}\``,
    "",
    "### Highlights",
    highlights,
    ""
  ].join("\n");
}

interface GitHubIssueComment {
  id: number;
  body: string;
}

export async function publishPrQualityComment(run: AgentRun, app: AgentApp): Promise<void> {
  const request = run.spec.request;
  if (!request || request.source !== "pull_request") {
    return;
  }

  const coords = resolvePullRequestCoordinates(run, app);
  if (!coords) {
    return;
  }

  const auth = createGitHubAuthProviderFromEnv();
  if (!auth) {
    return;
  }

  const reportPath = run.status.artifacts.qualityReportJson;
  if (!reportPath) {
    return;
  }

  const report = await readJsonFile<QualityReport>(resolveFromRepo(reportPath));
  const token = await auth.getTokenForRepo(coords.repo);
  const githubApiBase = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "agent-factory-worker"
  };

  const commentsResponse = await fetch(`${githubApiBase}/repos/${coords.repo}/issues/${coords.number}/comments`, {
    method: "GET",
    headers
  });

  if (!commentsResponse.ok) {
    const text = await commentsResponse.text();
    throw new Error(`failed to list PR comments ${coords.repo}#${coords.number}: ${commentsResponse.status} ${text}`);
  }

  const existingComments = (await commentsResponse.json()) as GitHubIssueComment[];
  const existing = existingComments.find((comment) => comment.body.includes(COMMENT_MARKER));
  const body = buildCommentBody(run, report);

  if (existing) {
    const updateResponse = await fetch(`${githubApiBase}/repos/${coords.repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body })
    });

    if (!updateResponse.ok) {
      const text = await updateResponse.text();
      throw new Error(`failed to update PR comment ${coords.repo}#${coords.number}: ${updateResponse.status} ${text}`);
    }
    return;
  }

  const createResponse = await fetch(`${githubApiBase}/repos/${coords.repo}/issues/${coords.number}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body })
  });

  if (!createResponse.ok) {
    const text = await createResponse.text();
    throw new Error(`failed to create PR comment ${coords.repo}#${coords.number}: ${createResponse.status} ${text}`);
  }
}
