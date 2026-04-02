import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { resolveFromRepo, writeJsonFile } from "./io.js";

export interface RunIssueInput {
  id: string;
  title: string;
  body: string;
  url?: string;
}

export interface IntakeRequest {
  app: AgentApp;
  issue: RunIssueInput;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function ensureRelativePath(...parts: string[]): string {
  return path.posix.join(...parts);
}

function createRunName(appName: string, issueId: string): string {
  return slugify(`run-${appName}-${issueId}`);
}

async function initializeArtifactFiles(artifactRoot: string): Promise<void> {
  await Promise.all([
    writeFile(path.join(artifactRoot, "plan.yaml"), "", "utf8"),
    writeFile(path.join(artifactRoot, "patch.diff"), "", "utf8"),
    writeFile(path.join(artifactRoot, "build.log"), "", "utf8"),
    writeFile(path.join(artifactRoot, "validation.log"), "", "utf8")
  ]);
}

export async function createRunFromIssue(input: IntakeRequest): Promise<AgentRun> {
  const runName = createRunName(input.app.metadata.name, input.issue.id);
  const artifactRoot = ensureRelativePath("artifacts", runName);
  const workspaceRoot = ensureRelativePath(".work", runName);
  const absoluteArtifactRoot = resolveFromRepo(artifactRoot);
  const absoluteWorkspaceRoot = resolveFromRepo(workspaceRoot);

  await Promise.all([
    mkdir(absoluteArtifactRoot, { recursive: true }),
    mkdir(absoluteWorkspaceRoot, { recursive: true })
  ]);

  const run: AgentRun = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRun",
    metadata: {
      name: runName
    },
    spec: {
      appRef: {
        name: input.app.metadata.name
      },
      issue: {
        id: input.issue.id,
        title: input.issue.title,
        body: input.issue.body,
        url: input.issue.url
      },
      workspace: {
        root: workspaceRoot,
        branch: `agent/${runName}`
      }
    },
    status: {
      phase: "queued",
      artifacts: {
        plan: ensureRelativePath(artifactRoot, "plan.yaml"),
        patch: ensureRelativePath(artifactRoot, "patch.diff"),
        buildLog: ensureRelativePath(artifactRoot, "build.log"),
        validationReport: ensureRelativePath(artifactRoot, "validation.log")
      }
    }
  };

  await Promise.all([
    writeJsonFile(resolveFromRepo(artifactRoot, "run.json"), run),
    writeJsonFile(resolveFromRepo(artifactRoot, "app.json"), input.app),
    writeJsonFile(resolveFromRepo(artifactRoot, "issue.json"), input.issue),
    initializeArtifactFiles(absoluteArtifactRoot)
  ]);

  return run;
}
