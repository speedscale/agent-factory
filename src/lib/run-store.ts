import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentApp, AgentEvidence, AgentRun } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "./io.js";
import { createRunQueueFromEnv } from "./run-queue.js";

export interface RunIssueInput {
  id: string;
  title: string;
  body: string;
  url?: string;
}

export interface IntakeEvidenceInput {
  discovery: {
    source: AgentEvidence["spec"]["discovery"]["source"];
    notes: string;
  };
  capture?: {
    dataset?: string;
    downloadCommand?: string;
    requestResponseSummary?: string;
  };
  reproduction: {
    steps: string[];
    expectedBehavior?: string;
    observedBehavior?: string;
  };
  suspectedBug?: string;
  fixSummary?: string;
}

export interface IntakeRequest {
  app: AgentApp;
  issue: RunIssueInput;
  evidence?: IntakeEvidenceInput;
  request?: {
    source: "pull_request" | "manual" | "agent" | "developer";
    mode: "comparison" | "baseline";
    url?: string;
    pullRequest?: {
      repository: string;
      number: number;
      headSha?: string;
      baseSha?: string;
    };
  };
  qualityTarget?: {
    name: string;
    workdir: string;
    baselineRef?: string;
  };
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
  const runName = path.basename(artifactRoot);
  const evidenceSeed: AgentEvidence = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentEvidence",
    metadata: {
      name: `evidence-${runName}`
    },
    spec: {
      runRef: {
        name: runName
      },
      issue: {
        id: "pending",
        title: "pending"
      },
      discovery: {
        source: "unknown",
        notes: "Record how the bug was discovered from logs or Speedscale capture."
      },
      capture: {},
      reproduction: {
        steps: ["Document local repro steps here."]
      },
      replayValidation: {
        result: "pending"
      }
    }
  };

  await Promise.all([
    writeFile(path.join(artifactRoot, "evidence.json"), `${JSON.stringify(evidenceSeed, null, 2)}\n`, "utf8"),
    writeFile(path.join(artifactRoot, "triage.json"), "", "utf8"),
    writeFile(path.join(artifactRoot, "plan.yaml"), "", "utf8"),
    writeFile(path.join(artifactRoot, "patch.diff"), "", "utf8"),
    writeFile(path.join(artifactRoot, "baseline.json"), "", "utf8"),
    writeFile(path.join(artifactRoot, "build.log"), "", "utf8"),
    writeFile(path.join(artifactRoot, "validation.log"), "", "utf8"),
    writeFile(path.join(artifactRoot, "quality-report.json"), "", "utf8"),
    writeFile(path.join(artifactRoot, "quality-report.md"), "", "utf8"),
    writeFile(path.join(artifactRoot, "result.json"), "", "utf8")
  ]);
}

export async function createRunFromRequest(input: IntakeRequest): Promise<AgentRun> {
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
      request: input.request,
      issue: {
        id: input.issue.id,
        title: input.issue.title,
        body: input.issue.body,
        url: input.issue.url
      },
      qualityTarget: input.qualityTarget,
      workspace: {
        root: workspaceRoot,
        branch: `agent/${runName}`
      }
    },
    status: {
      phase: "queued",
      artifacts: {
        evidence: ensureRelativePath(artifactRoot, "evidence.json"),
        triage: ensureRelativePath(artifactRoot, "triage.json"),
        plan: ensureRelativePath(artifactRoot, "plan.yaml"),
        patch: ensureRelativePath(artifactRoot, "patch.diff"),
        baseline: ensureRelativePath(artifactRoot, "baseline.json"),
        buildLog: ensureRelativePath(artifactRoot, "build.log"),
        validationReport: ensureRelativePath(artifactRoot, "validation.log"),
        qualityReportJson: ensureRelativePath(artifactRoot, "quality-report.json"),
        qualityReportMarkdown: ensureRelativePath(artifactRoot, "quality-report.md"),
        result: ensureRelativePath(artifactRoot, "result.json")
      }
    }
  };

  await Promise.all([
    writeJsonFile(resolveFromRepo(artifactRoot, "run.json"), run),
    writeJsonFile(resolveFromRepo(artifactRoot, "app.json"), input.app),
    writeJsonFile(resolveFromRepo(artifactRoot, "issue.json"), input.issue),
    writeJsonFile(resolveFromRepo(artifactRoot, "request.json"), input.request ?? { source: "manual", mode: "comparison" }),
    initializeArtifactFiles(absoluteArtifactRoot)
  ]);

  const evidencePath = resolveFromRepo(artifactRoot, "evidence.json");
  const evidence = await readJsonFile<AgentEvidence>(evidencePath);
  evidence.spec.issue = {
    id: input.issue.id,
    title: input.issue.title,
    url: input.issue.url
  };

  if (input.evidence) {
    evidence.spec.discovery = {
      source: input.evidence.discovery.source,
      notes: input.evidence.discovery.notes
    };

    evidence.spec.capture = {
      dataset: input.evidence.capture?.dataset,
      downloadCommand: input.evidence.capture?.downloadCommand,
      requestResponseSummary: input.evidence.capture?.requestResponseSummary
    };

    evidence.spec.reproduction = {
      steps: input.evidence.reproduction.steps,
      expectedBehavior: input.evidence.reproduction.expectedBehavior,
      observedBehavior: input.evidence.reproduction.observedBehavior
    };

    evidence.spec.suspectedBug = input.evidence.suspectedBug;
    evidence.spec.fixSummary = input.evidence.fixSummary;
  }

  await writeJsonFile(evidencePath, evidence);

  const queue = createRunQueueFromEnv();
  try {
    await queue.enqueueRun(run.metadata.name);
  } finally {
    await queue.close();
  }

  return run;
}

export async function createRunFromIssue(input: IntakeRequest): Promise<AgentRun> {
  return createRunFromRequest(input);
}
