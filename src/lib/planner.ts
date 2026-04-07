import path from "node:path";
import type { AgentApp, AgentPlan, AgentRun, AgentTriage } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "./io.js";

export interface PlannerRunContext {
  run: AgentRun;
  app: AgentApp;
  runDir: string;
}

function summarizeIssue(title: string, body: string): string {
  const text = `${title} ${body}`.toLowerCase();

  if (text.includes("404") && text.includes("500")) {
    return "Preserve upstream 404 behavior instead of converting it to 500.";
  }

  if (text.includes("timeout")) {
    return "Preserve the expected timeout behavior instead of failing early.";
  }

  return title.trim();
}

function inferHypothesis(issue: AgentRun["spec"]["issue"]): string {
  const text = `${issue.title} ${issue.body}`.toLowerCase();

  if (text.includes("404") || text.includes("status code")) {
    return "The error mapping in the request path is collapsing known upstream status codes into a generic internal error.";
  }

  if (text.includes("timeout") || text.includes("retry")) {
    return "The dependency timeout or retry handling is causing the request to fail before the expected fallback behavior can run.";
  }

  return "The failure likely comes from the app code path that translates dependency behavior into client responses.";
}

function inferTargetPaths(app: AgentApp): string[] {
  const workdir = app.spec.repo.workdir.trim();
  return workdir.length > 0 ? [workdir.endsWith("/") ? workdir : `${workdir}/`] : ["."];
}

function inferValidationCommand(app: AgentApp): string {
  return app.spec.validate.proxymock.command;
}

function inferConfidence(issue: AgentRun["spec"]["issue"]): AgentTriage["spec"]["confidence"] {
  const text = `${issue.title} ${issue.body}`.toLowerCase();

  if (text.includes("404") && text.includes("500")) {
    return "high";
  }

  if (text.includes("timeout") || text.includes("retry") || text.includes("connection")) {
    return "medium";
  }

  return "low";
}

function buildPlanFromContext(context: PlannerRunContext): AgentPlan {
  const runName = context.run.metadata.name;
  const issueId = context.run.spec.issue.id;
  const targetPaths = inferTargetPaths(context.app);
  const validationCommand = inferValidationCommand(context.app);
  const hypothesis = inferHypothesis(context.run.spec.issue);

  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentPlan",
    metadata: {
      name: `plan-${runName}`
    },
    spec: {
      runRef: {
        name: runName
      },
      summary: summarizeIssue(context.run.spec.issue.title, context.run.spec.issue.body),
      hypothesis,
      steps: [
        {
          id: `inspect-${issueId}`,
          action: "inspect",
          description: "Review the app code path and the configured build/test commands.",
          targetPaths
        },
        {
          id: `edit-${issueId}`,
          action: "edit",
          description: "Make the smallest code change that preserves the expected client behavior.",
          targetPaths
        },
        {
          id: `build-${issueId}`,
          action: "build",
          description: "Run the app's configured test command.",
          command: context.app.spec.build.test
        },
        {
          id: `validate-${issueId}`,
          action: "validate",
          description: "Replay the captured traffic set against the patched app.",
          command: validationCommand
        }
      ],
      validation: {
        command: validationCommand,
        successCriteria: `The proxymock replay for ${context.app.metadata.name} no longer reproduces the reported issue.`
      }
    }
  };
}

export function writePlanArtifact(runDir: string, plan: AgentPlan): Promise<void> {
  return writeJsonFile(path.join(runDir, "plan.yaml"), plan);
}

export function writeTriageArtifact(context: PlannerRunContext, plan: AgentPlan): Promise<void> {
  const triage: AgentTriage = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentTriage",
    metadata: {
      name: `triage-${context.run.metadata.name}`
    },
    spec: {
      runRef: {
        name: context.run.metadata.name
      },
      issue: {
        id: context.run.spec.issue.id,
        title: context.run.spec.issue.title
      },
      hypothesis: plan.spec.hypothesis,
      confidence: inferConfidence(context.run.spec.issue),
      candidatePaths: inferTargetPaths(context.app),
      rationale: [
        `Issue summary: ${plan.spec.summary}`,
        `Validation command: ${plan.spec.validation.command}`,
        "Target paths selected from app workdir and issue heuristics."
      ]
    }
  };

  return writeJsonFile(path.join(context.runDir, "triage.json"), triage);
}

export function buildPlan(context: PlannerRunContext): AgentPlan {
  return buildPlanFromContext(context);
}

export async function loadPlannerContext(runInput: string): Promise<PlannerRunContext> {
  const runJsonPath = runInput.endsWith(".json")
    ? resolveFromRepo(runInput)
    : resolveFromRepo("artifacts", runInput, "run.json");
  const runDir = path.dirname(runJsonPath);
  const appJsonPath = path.join(runDir, "app.json");

  const [run, app] = await Promise.all([
    readJsonFile<AgentRun>(runJsonPath),
    readJsonFile<AgentApp>(appJsonPath)
  ]);

  return { run, app, runDir };
}
