import path from "node:path";
import type { AgentRun, AgentRunResult } from "../contracts/index.js";
import { resolveFromRepo, writeJsonFile } from "./io.js";

export interface RunCommandResultSummary {
  build?: {
    command: string;
    exitCode: number;
  };
  validation?: {
    command: string;
    exitCode: number;
  };
}

export function resolveResultArtifactPath(run: AgentRun): string {
  return run.status.artifacts.result ?? path.posix.join("artifacts", run.metadata.name, "result.json");
}

export async function writeRunResultArtifact(
  run: AgentRun,
  commands: RunCommandResultSummary = {}
): Promise<void> {
  const resultPath = resolveResultArtifactPath(run);
  const runPath = path.posix.join("artifacts", run.metadata.name, "run.json");

  const summary = run.status.summary ?? "";

  const payload: AgentRunResult = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRunResult",
    metadata: {
      name: `result-${run.metadata.name}`,
      generatedAt: new Date().toISOString()
    },
    spec: {
      runRef: {
        name: run.metadata.name
      },
      appRef: {
        name: run.spec.appRef.name
      },
      issue: {
        id: run.spec.issue.id,
        title: run.spec.issue.title,
        url: run.spec.issue.url
      },
      phase: run.status.phase,
      summary,
      commands,
      artifacts: {
        run: runPath,
        triage: run.status.artifacts.triage,
        plan: run.status.artifacts.plan,
        patch: run.status.artifacts.patch,
        buildLog: run.status.artifacts.buildLog,
        validationReport: run.status.artifacts.validationReport,
        result: resultPath
      }
    }
  };

  await writeJsonFile(resolveFromRepo(resultPath), payload);
}
