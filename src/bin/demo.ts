import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { createRunFromRequest } from "../lib/run-store.js";
import { buildPlan, loadPlannerContext, writePlanArtifact, writeTriageArtifact } from "../lib/planner.js";
import { loadRunnerContext, runBuildStage } from "../lib/runner.js";
import { loadValidatorContext, runValidationStage } from "../lib/validator.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "../lib/io.js";
import { sampleApp, sampleIssue } from "../lib/sample-data.js";
import { writeQualityArtifacts } from "../lib/quality-report.js";

async function createDemoSource(): Promise<{ sourceDir: string; proxymockDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-factory-demo-"));
  const sourceDir = path.join(root, "fixture");
  const appDir = path.join(sourceDir, "node");
  const proxymockDir = path.join(root, "bin");

  await Promise.all([mkdir(appDir, { recursive: true }), mkdir(proxymockDir, { recursive: true })]);

  await writeFile(
    path.join(appDir, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-node-fixture",
        private: true,
        scripts: {
          test: "node test.js"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    path.join(appDir, "test.js"),
    [
      "const mode = process.env.AGENT_FACTORY_BUILD_MODE ?? 'pass';",
      "if (mode === 'fail') {",
      "  console.error('build regression simulated');",
      "  process.exit(1);",
      "}",
      "console.log('build ok');"
    ].join("\n") + "\n",
    "utf8"
  );

  const proxymockPath = path.join(proxymockDir, "proxymock");
  await writeFile(
    proxymockPath,
    [
      "#!/bin/sh",
      "mode=\"${AGENT_FACTORY_PROXYMOCK_MODE:-pass}\"",
      "if [ \"$mode\" = \"fail\" ]; then",
      "  echo \"proxymock replay regression simulated\" >&2",
      "  exit 1",
      "fi",
      "if [ \"$mode\" = \"hang\" ]; then",
      "  sleep 300",
      "fi",
      "echo \"proxymock replay ok\""
    ].join("\n") + "\n",
    "utf8"
  );
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
      lastTransitionAt: new Date().toISOString(),
      summary
    }
  });
}

async function persistRunState(runName: string, phase: AgentRun["status"]["phase"], summary: string): Promise<void> {
  const runJsonPath = resolveFromRepo("artifacts", runName, "run.json");
  const run = await readJsonFile<AgentRun>(runJsonPath);

  await writeJsonFile(runJsonPath, {
    ...run,
    status: {
      ...run.status,
      phase,
      lastTransitionAt: new Date().toISOString(),
      summary
    }
  });
}

function createDemoApp(): AgentApp {
  return {
    ...sampleApp,
    spec: {
      ...sampleApp.spec,
      quality: {
        baseline: {
          strategy: "single",
          targets: [
            {
              name: "demo-node",
              workdir: "node",
              baselineRef: "demo/local-loop"
            }
          ]
        },
        reporting: {
          formats: ["json", "markdown"],
          failOnRegression: true
        }
      },
      build: {
        ...sampleApp.spec.build,
        timeoutSeconds: 60,
        maxNoOutputSeconds: 20,
        retries: 0
      },
      validate: {
        proxymock: {
          ...sampleApp.spec.validate.proxymock,
          timeoutSeconds: 45,
          maxNoOutputSeconds: 15,
          retries: 1
        }
      }
    }
  };
}

interface DemoRunSummary {
  scenario: string;
  mode: "baseline" | "comparison";
  run: string;
  phase: AgentRun["status"]["phase"];
  qualityOutcome: "pass" | "warning" | "regression";
  qualitySummary: string;
  buildExitCode: number;
  validationExitCode?: number;
  artifacts: AgentRun["status"]["artifacts"];
}

async function executeDemoRun(input: {
  app: AgentApp;
  sourceDir: string;
  proxymockDir: string;
  scenario: string;
  mode: "baseline" | "comparison";
  proxymockMode: "pass" | "fail";
}): Promise<DemoRunSummary> {
  const run = await createRunFromRequest({
    app: input.app,
    issue: {
      id: `loop-${input.scenario}`,
      title: `${sampleIssue.title} (${input.scenario})`,
      body: sampleIssue.body,
      url: sampleIssue.url
    },
    request: {
      source: "developer",
      mode: input.mode
    }
  });

  const plannerContext = await loadPlannerContext(run.metadata.name);
  const plan = buildPlan(plannerContext);

  await Promise.all([
    writePlanArtifact(plannerContext.runDir, plan),
    writeTriageArtifact(plannerContext, plan),
    persistPlannedRun(run.metadata.name, plan.spec.summary)
  ]);

  const runnerContext = await loadRunnerContext(run.metadata.name, input.sourceDir);
  await persistRunState(run.metadata.name, "building", "Preparing isolated workspace and executing build commands.");
  const buildResult = await runBuildStage(runnerContext);

  if (buildResult.run.status.phase !== "validating") {
    const quality = await writeQualityArtifacts({
      run: buildResult.run,
      app: input.app,
      build: {
        command: buildResult.result.command,
        exitCode: buildResult.result.exitCode,
        stdout: buildResult.result.stdout,
        stderr: buildResult.result.stderr
      }
    });

    return {
      scenario: input.scenario,
      mode: input.mode,
      run: run.metadata.name,
      phase: buildResult.run.status.phase,
      qualityOutcome: quality.outcome,
      qualitySummary: quality.summary,
      buildExitCode: buildResult.result.exitCode,
      artifacts: buildResult.run.status.artifacts
    };
  }

  const originalPath = process.env.PATH ?? "";
  const originalProxymockMode = process.env.AGENT_FACTORY_PROXYMOCK_MODE;

  process.env.PATH = `${input.proxymockDir}${path.delimiter}${originalPath}`;
  process.env.AGENT_FACTORY_PROXYMOCK_MODE = input.proxymockMode;

  try {
    const validatorContext = await loadValidatorContext(run.metadata.name);
    await persistRunState(run.metadata.name, "validating", "Running proxymock validation command.");
    const validationResult = await runValidationStage(validatorContext);
    const quality = await writeQualityArtifacts({
      run: validationResult.run,
      app: input.app,
      build: {
        command: buildResult.result.command,
        exitCode: buildResult.result.exitCode,
        stdout: buildResult.result.stdout,
        stderr: buildResult.result.stderr
      },
      validation: {
        command: validationResult.result.command,
        exitCode: validationResult.result.exitCode,
        stdout: validationResult.result.stdout,
        stderr: validationResult.result.stderr
      }
    });

    return {
      scenario: input.scenario,
      mode: input.mode,
      run: run.metadata.name,
      phase: validationResult.run.status.phase,
      qualityOutcome: quality.outcome,
      qualitySummary: quality.summary,
      buildExitCode: buildResult.result.exitCode,
      validationExitCode: validationResult.result.exitCode,
      artifacts: validationResult.run.status.artifacts
    };
  } finally {
    process.env.PATH = originalPath;

    if (typeof originalProxymockMode === "undefined") {
      delete process.env.AGENT_FACTORY_PROXYMOCK_MODE;
    } else {
      process.env.AGENT_FACTORY_PROXYMOCK_MODE = originalProxymockMode;
    }
  }
}

async function main(): Promise<void> {
  const { sourceDir, proxymockDir } = await createDemoSource();
  const app = createDemoApp();

  try {
    const baselineRun = await executeDemoRun({
      app,
      sourceDir,
      proxymockDir,
      scenario: "baseline",
      mode: "baseline",
      proxymockMode: "pass"
    });

    const regressionRun = await executeDemoRun({
      app,
      sourceDir,
      proxymockDir,
      scenario: "regression",
      mode: "comparison",
      proxymockMode: "fail"
    });

    const recoveryRun = await executeDemoRun({
      app,
      sourceDir,
      proxymockDir,
      scenario: "recovery",
      mode: "comparison",
      proxymockMode: "pass"
    });

    console.log(
      JSON.stringify(
        {
          message: "loop demo completed",
          summary: "baseline seeded, regression detected, recovery confirmed",
          runs: [baselineRun, regressionRun, recoveryRun]
        },
        null,
        2
      )
    );
  } finally {
    await rm(path.dirname(sourceDir), { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "demo failed";
  console.error(message);
  process.exitCode = 1;
});
