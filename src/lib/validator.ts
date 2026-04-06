import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { resolveFromRepo, writeJsonFile } from "./io.js";
import { loadPlannerContext } from "./planner.js";
import { writeRunResultArtifact } from "./run-result.js";

export interface ValidatorContext {
  run: AgentRun;
  app: AgentApp;
  runDir: string;
  workspaceDir: string;
  sourceDir?: string;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runShellCommand(command: string, cwd: string): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (exitCode) => {
      resolve({
        command,
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function writeCommandLog(logPath: string, result: CommandResult): Promise<void> {
  const payload = [
    `> ${result.command}`,
    result.stdout.trimEnd(),
    result.stderr.trimEnd() ? "[stderr]" : "",
    result.stderr.trimEnd()
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  await writeFile(logPath, `${payload}\n`, "utf8");
}

export async function loadValidatorContext(runInput: string): Promise<ValidatorContext> {
  const plannerContext = await loadPlannerContext(runInput);
  return {
    ...plannerContext,
    workspaceDir: resolveFromRepo(plannerContext.run.spec.workspace.root)
  };
}

export async function runValidationStage(context: ValidatorContext): Promise<{ result: CommandResult; run: AgentRun }> {
  const command = context.app.spec.validate.proxymock.command;
  const workspaceCwd = path.join(context.workspaceDir, context.app.spec.repo.workdir);
  const result = await runShellCommand(command, workspaceCwd);
  const validationLogPath = resolveFromRepo(
    context.run.status.artifacts.validationReport ?? path.posix.join("artifacts", context.run.metadata.name, "validation.log")
  );

  const nextRun: AgentRun = {
    ...context.run,
    status: {
      ...context.run.status,
      phase: result.exitCode === 0 ? "succeeded" : "failed",
      summary:
        result.exitCode === 0
          ? `Validation succeeded: ${command}`
          : `Validation failed: ${command}`
    }
  };

  await Promise.all([
    writeCommandLog(validationLogPath, result),
    writeJsonFile(resolveFromRepo("artifacts", context.run.metadata.name, "run.json"), nextRun),
    writeRunResultArtifact(nextRun, {
      build: {
        command: context.app.spec.build.test,
        exitCode: 0
      },
      validation: {
        command,
        exitCode: result.exitCode
      }
    })
  ]);

  return {
    result,
    run: nextRun
  };
}
