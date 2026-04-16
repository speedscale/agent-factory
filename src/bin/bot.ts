import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPlan, loadPlannerContext, writePlanArtifact, writeTriageArtifact } from "../lib/planner.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "../lib/io.js";
import { loadRunnerContext, runBuildStage } from "../lib/runner.js";
import { loadValidatorContext, runValidationStage } from "../lib/validator.js";
import { createRunFromRequest, type IntakeRequest } from "../lib/run-store.js";
import type { AgentRun } from "../contracts/index.js";
import { writeQualityArtifacts } from "../lib/quality-report.js";
import { writeRunResultArtifact } from "../lib/run-result.js";

interface BotOptions {
  intakePath: string;
  sourceDir?: string;
  requestMode?: "comparison" | "baseline";
  proxymockMode: "pass" | "fail" | "hang";
}

function getArg(argv: string[], flagNames: string[]): string | undefined {
  const index = argv.findIndex((value) => flagNames.includes(value));
  if (index >= 0 && typeof argv[index + 1] === "string") {
    return argv[index + 1];
  }

  return undefined;
}

function parseOptions(argv: string[]): BotOptions {
  const intakePath = getArg(argv, ["--intake", "-i"]) ?? "examples/runs/demo-node-intake.json";
  const sourceDir = getArg(argv, ["--source", "-s"]);
  const mode = getArg(argv, ["--mode"]);
  const proxymockMode = getArg(argv, ["--proxymock-mode"]) ?? "pass";

  if (typeof mode !== "undefined" && mode !== "comparison" && mode !== "baseline") {
    throw new Error("--mode must be one of: comparison, baseline");
  }

  if (proxymockMode !== "pass" && proxymockMode !== "fail" && proxymockMode !== "hang") {
    throw new Error("--proxymock-mode must be one of: pass, fail, hang");
  }

  return {
    intakePath,
    sourceDir,
    requestMode: mode as "comparison" | "baseline" | undefined,
    proxymockMode
  };
}

async function createLocalFixture(): Promise<{ sourceDir: string; proxymockBinDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-factory-bot-"));
  const sourceDir = path.join(root, "fixture");
  const appDir = path.join(sourceDir, "node");
  const proxymockBinDir = path.join(root, "bin");

  await Promise.all([mkdir(appDir, { recursive: true }), mkdir(proxymockBinDir, { recursive: true })]);

  await writeFile(
    path.join(appDir, "package.json"),
    `${JSON.stringify(
      {
        name: "bot-node-fixture",
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

  await writeFile(path.join(appDir, "test.js"), "console.log('build ok')\n", "utf8");

  const proxymockPath = path.join(proxymockBinDir, "proxymock");
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

  return { sourceDir, proxymockBinDir };
}

async function updateRun(runName: string, phase: AgentRun["status"]["phase"], summary: string): Promise<void> {
  const runPath = resolveFromRepo("artifacts", runName, "run.json");
  const run = await readJsonFile<AgentRun>(runPath);
  const nextRun: AgentRun = {
    ...run,
    status: {
      ...run.status,
      phase,
      summary,
      lastTransitionAt: new Date().toISOString()
    }
  };

  await writeJsonFile(runPath, nextRun);
}

async function executeRun(runName: string, sourceDir: string): Promise<AgentRun> {
  const plannerContext = await loadPlannerContext(runName);
  const plan = buildPlan(plannerContext);

  await Promise.all([
    writePlanArtifact(plannerContext.runDir, plan),
    writeTriageArtifact(plannerContext, plan),
    updateRun(runName, "planned", plan.spec.summary)
  ]);

  const runnerContext = await loadRunnerContext(runName, sourceDir);
  await updateRun(runName, "building", "Preparing isolated workspace and executing build commands.");
  const buildResult = await runBuildStage(runnerContext);

  if (buildResult.run.status.phase !== "validating") {
    const qualityOutcome = await writeQualityArtifacts({
      run: buildResult.run,
      app: runnerContext.app,
      build: {
        command: buildResult.result.command,
        exitCode: buildResult.result.exitCode,
        stdout: buildResult.result.stdout,
        stderr: buildResult.result.stderr
      }
    });

    const finalRun: AgentRun = {
      ...buildResult.run,
      status: {
        ...buildResult.run.status,
        summary: `${buildResult.run.status.summary ?? "Build failed."} Quality report: ${qualityOutcome.summary}`,
        lastTransitionAt: new Date().toISOString()
      }
    };

    await Promise.all([
      writeJsonFile(resolveFromRepo("artifacts", runName, "run.json"), finalRun),
      writeRunResultArtifact(finalRun, {
        build: {
          command: buildResult.result.command,
          exitCode: buildResult.result.exitCode
        }
      })
    ]);

    return finalRun;
  }

  await updateRun(runName, "validating", "Running proxymock validation command.");
  const validatorContext = await loadValidatorContext(runName);
  const validationResult = await runValidationStage(validatorContext);

  const qualityOutcome = await writeQualityArtifacts({
    run: validationResult.run,
    app: runnerContext.app,
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

  const failOnRegression = runnerContext.app.spec.quality?.reporting?.failOnRegression === true;
  const shouldFailRun = qualityOutcome.outcome === "regression" && failOnRegression;
  const finalRun: AgentRun = shouldFailRun
    ? {
        ...validationResult.run,
        status: {
          ...validationResult.run.status,
          phase: "failed",
          summary: `Quality regression detected: ${qualityOutcome.summary}`,
          lastTransitionAt: new Date().toISOString()
        }
      }
    : {
        ...validationResult.run,
        status: {
          ...validationResult.run.status,
          summary: `${validationResult.run.status.summary ?? "Validation completed."} Quality report: ${qualityOutcome.summary}`,
          lastTransitionAt: new Date().toISOString()
        }
      };

  await Promise.all([
    writeJsonFile(resolveFromRepo("artifacts", runName, "run.json"), finalRun),
    writeRunResultArtifact(finalRun, {
      build: {
        command: buildResult.result.command,
        exitCode: buildResult.result.exitCode
      },
      validation: {
        command: validationResult.result.command,
        exitCode: validationResult.result.exitCode
      }
    })
  ]);

  return finalRun;
}

function toIntakeRequest(value: unknown): IntakeRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("intake file must be a JSON object");
  }

  const candidate = value as Partial<IntakeRequest>;
  if (!candidate.app || !candidate.issue) {
    throw new Error("intake JSON must include 'app' and 'issue'");
  }

  return candidate as IntakeRequest;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const intakeRaw = await readJsonFile<unknown>(resolveFromRepo(options.intakePath));
  const intake = toIntakeRequest(intakeRaw);

  let cleanupRoot: string | undefined;
  let sourceDir = options.sourceDir
    ? path.isAbsolute(options.sourceDir)
      ? options.sourceDir
      : resolveFromRepo(options.sourceDir)
    : undefined;
  let proxymockBinDir: string | undefined;

  if (!sourceDir) {
    const fixture = await createLocalFixture();
    sourceDir = fixture.sourceDir;
    proxymockBinDir = fixture.proxymockBinDir;
    cleanupRoot = path.dirname(fixture.sourceDir);
  }

  const originalPath = process.env.PATH ?? "";
  const originalProxymockMode = process.env.AGENT_FACTORY_PROXYMOCK_MODE;

  if (proxymockBinDir) {
    process.env.PATH = `${proxymockBinDir}${path.delimiter}${originalPath}`;
  }
  process.env.AGENT_FACTORY_PROXYMOCK_MODE = options.proxymockMode;

  try {
    const uniqueIssueId = `${intake.issue.id}-bot-${Date.now()}`;
    const run = await createRunFromRequest({
      ...intake,
      issue: {
        ...intake.issue,
        id: uniqueIssueId
      },
      request: {
        source: intake.request?.source ?? "agent",
        mode: options.requestMode ?? intake.request?.mode ?? "comparison",
        url: intake.request?.url,
        pullRequest: intake.request?.pullRequest
      }
    });

    const finalRun = await executeRun(run.metadata.name, sourceDir);
    console.log(
      JSON.stringify(
        {
          message: "bot completed run",
          run: finalRun.metadata.name,
          phase: finalRun.status.phase,
          summary: finalRun.status.summary,
          artifacts: finalRun.status.artifacts
        },
        null,
        2
      )
    );
  } finally {
    process.env.PATH = originalPath;
    if (typeof originalProxymockMode === "undefined") {
      delete process.env.AGENT_FACTORY_PROXYMOCK_MODE;
    } else {
      process.env.AGENT_FACTORY_PROXYMOCK_MODE = originalProxymockMode;
    }

    if (cleanupRoot) {
      await rm(cleanupRoot, { recursive: true, force: true });
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "bot failed";
  console.error(message);
  process.exitCode = 1;
});
