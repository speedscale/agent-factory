import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { AgentApp, AgentEvidence, AgentRun } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "./io.js";
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

function waitForTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();

  return new Promise((resolve) => {
    const probe = () => {
      const socket = net.createConnection({ host, port });

      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.once("error", () => {
        socket.destroy();

        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }

        setTimeout(probe, 500);
      });
    };

    probe();
  });
}

function spawnService(command: string, cwd: string): ChildProcess {
  return spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stopService(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.killed) {
    return;
  }

  process.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 5000);

    process.once("close", () => {
      clearTimeout(timeout);
      resolve();
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

function formatCommandOutput(result: CommandResult, label: string): string {
  return [
    `[${label}] ${result.command}`,
    result.stdout.trimEnd() ? "[stdout]" : "",
    result.stdout.trimEnd(),
    result.stderr.trimEnd() ? "[stderr]" : "",
    result.stderr.trimEnd()
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function updateEvidenceReplay(
  context: ValidatorContext,
  command: string,
  exitCode: number,
  result: "pass" | "fail"
): Promise<void> {
  const evidencePath = resolveFromRepo(
    context.run.status.artifacts.evidence ?? path.posix.join("artifacts", context.run.metadata.name, "evidence.json")
  );

  try {
    const evidence = await readJsonFile<AgentEvidence>(evidencePath);
    evidence.spec.replayValidation = {
      command,
      exitCode,
      result
    };
    await writeJsonFile(evidencePath, evidence);
  } catch {
    // best effort
  }
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
  const dependencies = context.app.spec.validate.proxymock.dependencies;
  const service = context.app.spec.validate.proxymock.service;
  const validationLogPath = resolveFromRepo(
    context.run.status.artifacts.validationReport ?? path.posix.join("artifacts", context.run.metadata.name, "validation.log")
  );
  let serviceProcess: ChildProcess | undefined;
  let serviceStdout = "";
  let serviceStderr = "";
  let dependencySetupExecuted = false;

  try {
    if (dependencies?.setupCommand) {
      const setupResult = await runShellCommand(dependencies.setupCommand, workspaceCwd);
      dependencySetupExecuted = true;

      if (setupResult.exitCode !== 0) {
        const failedResult: CommandResult = {
          command,
          exitCode: 1,
          stdout: "",
          stderr: `dependency setup failed\n${formatCommandOutput(setupResult, "dependency setup")}`
        };

        const failedRun: AgentRun = {
          ...context.run,
          status: {
            ...context.run.status,
            phase: "failed",
            summary: "Validation failed: dependency setup command failed"
          }
        };

        await Promise.all([
          writeCommandLog(validationLogPath, failedResult),
          writeJsonFile(resolveFromRepo("artifacts", context.run.metadata.name, "run.json"), failedRun),
          writeRunResultArtifact(failedRun, {
            build: {
              command: context.app.spec.build.test,
              exitCode: 0
            },
            validation: {
              command,
              exitCode: failedResult.exitCode
            }
          })
        ]);

        await updateEvidenceReplay(context, command, failedResult.exitCode, "fail");

        return {
          result: failedResult,
          run: failedRun
        };
      }
    }

    if (service) {
      const serviceCommand = service.command ?? context.app.spec.build.start;
      const serviceHost = service.host ?? "localhost";
      const startupTimeoutSeconds = service.startupTimeoutSeconds ?? 60;

      serviceProcess = spawnService(serviceCommand, workspaceCwd);
      serviceProcess.stdout?.on("data", (chunk: Buffer) => {
        serviceStdout += chunk.toString("utf8");
      });
      serviceProcess.stderr?.on("data", (chunk: Buffer) => {
        serviceStderr += chunk.toString("utf8");
      });

      const ready = await waitForTcp(serviceHost, service.port, startupTimeoutSeconds * 1000);

      if (!ready) {
        await stopService(serviceProcess);

        const failedResult: CommandResult = {
          command,
          exitCode: 1,
          stdout: "",
          stderr: [
            `service bootstrap timed out: ${serviceHost}:${service.port} did not become ready`,
            serviceStdout.trimEnd() ? "[service stdout]" : "",
            serviceStdout.trimEnd(),
            serviceStderr.trimEnd() ? "[service stderr]" : "",
            serviceStderr.trimEnd()
          ]
            .filter((line) => line.length > 0)
            .join("\n")
        };

        const failedRun: AgentRun = {
          ...context.run,
          status: {
            ...context.run.status,
            phase: "failed",
            summary: `Validation failed: service bootstrap timeout for ${serviceHost}:${service.port}`
          }
        };

        await Promise.all([
          writeCommandLog(validationLogPath, failedResult),
          writeJsonFile(resolveFromRepo("artifacts", context.run.metadata.name, "run.json"), failedRun),
          writeRunResultArtifact(failedRun, {
            build: {
              command: context.app.spec.build.test,
              exitCode: 0
            },
            validation: {
              command,
              exitCode: failedResult.exitCode
            }
          })
        ]);

        return {
          result: failedResult,
          run: failedRun
        };
      }
    }

    const result = await runShellCommand(command, workspaceCwd);

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

    await updateEvidenceReplay(context, command, result.exitCode, result.exitCode === 0 ? "pass" : "fail");

    return {
      result,
      run: nextRun
    };
  } finally {
    await stopService(serviceProcess);

    if (dependencySetupExecuted && dependencies?.teardownCommand) {
      await runShellCommand(dependencies.teardownCommand, workspaceCwd);
    }
  }
}
