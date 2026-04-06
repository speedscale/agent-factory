import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunFromIssue } from "../lib/run-store.js";
import { buildPlan, loadPlannerContext, writePlanArtifact } from "../lib/planner.js";
import { loadRunnerContext, runBuildStage } from "../lib/runner.js";
import { loadValidatorContext, runValidationStage } from "../lib/validator.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "../lib/io.js";
import { sampleApp, sampleIssue } from "../lib/sample-data.js";

async function createDemoSource(): Promise<{ sourceDir: string; proxymockDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-factory-demo-"));
  const sourceDir = path.join(root, "node");
  const proxymockDir = path.join(root, "bin");

  await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(proxymockDir, { recursive: true })]);

  await writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-node-fixture",
        private: true,
        scripts: {
          test: "true"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const proxymockPath = path.join(proxymockDir, "proxymock");
  await writeFile(proxymockPath, "#!/bin/sh\necho proxymock replay ok\n", "utf8");
  await chmod(proxymockPath, 0o755);

  return { sourceDir, proxymockDir };
}

async function persistPlannedRun(runName: string, summary: string): Promise<void> {
  const runJsonPath = resolveFromRepo("artifacts", runName, "run.json");
  const run = await readJsonFile<Record<string, any>>(runJsonPath);

  await writeJsonFile(runJsonPath, {
    ...run,
    status: {
      ...run.status,
      phase: "planned",
      summary
    }
  });
}

async function main(): Promise<void> {
  const { sourceDir, proxymockDir } = await createDemoSource();
  const originalPath = process.env.PATH ?? "";

  try {
    const run = await createRunFromIssue({ app: sampleApp, issue: sampleIssue });
    const plannerContext = await loadPlannerContext(run.metadata.name);
    const plan = buildPlan(plannerContext);

    await Promise.all([
      writePlanArtifact(plannerContext.runDir, plan),
      persistPlannedRun(run.metadata.name, plan.spec.summary)
    ]);

    const runnerContext = await loadRunnerContext(run.metadata.name, sourceDir);
    const startedBuildRun = {
      ...runnerContext.run,
      status: {
        ...runnerContext.run.status,
        phase: "building" as const,
        summary: "Preparing isolated workspace and executing build commands."
      }
    };

    await writeJsonFile(path.join(runnerContext.runDir, "run.json"), startedBuildRun);
    const buildResult = await runBuildStage({ ...runnerContext, run: startedBuildRun });

    process.env.PATH = `${proxymockDir}${path.delimiter}${originalPath}`;
    const validatorContext = await loadValidatorContext(run.metadata.name);
    const startedValidateRun = {
      ...validatorContext.run,
      status: {
        ...validatorContext.run.status,
        phase: "validating" as const,
        summary: "Running proxymock validation command."
      }
    };

    await writeJsonFile(path.join(validatorContext.runDir, "run.json"), startedValidateRun);
    const validationResult = await runValidationStage({ ...validatorContext, run: startedValidateRun });

    console.log(
      JSON.stringify(
        {
          message: "golden path completed",
          run: validationResult.run.metadata.name,
          plan: plan.metadata.name,
          build: {
            command: buildResult.result.command,
            exitCode: buildResult.result.exitCode
          },
          validation: {
            command: validationResult.result.command,
            exitCode: validationResult.result.exitCode
          },
          artifacts: validationResult.run.status.artifacts
        },
        null,
        2
      )
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(path.dirname(sourceDir), { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "demo failed";
  console.error(message);
  process.exitCode = 1;
});
