import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "./io.js";
import { loadPlannerContext } from "./planner.js";
import { writeRunResultArtifact } from "./run-result.js";

export interface RunnerContext {
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

function resolveRunJsonPath(runInput: string): string {
  return runInput.endsWith(".json")
    ? resolveFromRepo(runInput)
    : resolveFromRepo("artifacts", runInput, "run.json");
}

async function runShellCommand(command: string, cwd: string): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
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

async function prepareWorkspace(context: RunnerContext): Promise<void> {
  await mkdir(context.workspaceDir, { recursive: true });

  if (context.sourceDir) {
    const excludedSegments = new Set([".git", "node_modules", "artifacts", ".work"]);

    await cp(context.sourceDir, context.workspaceDir, {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const relative = path.relative(context.sourceDir as string, sourcePath);
        if (!relative || relative === ".") {
          return true;
        }

        const segments = relative.split(path.sep);
        return !segments.some((segment) => excludedSegments.has(segment));
      }
    });
  }
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

async function capturePatchArtifact(context: RunnerContext, buildCommand: string): Promise<void> {
  const patchPath = resolveFromRepo(context.run.status.artifacts.patch ?? path.posix.join("artifacts", context.run.metadata.name, "patch.diff"));

  if (!context.sourceDir) {
    await writeFile(
      patchPath,
      [
        "--- a/sandbox",
        "+++ b/sandbox",
        "@@",
        "+ runner executed the configured build command in an isolated workspace",
        `+ command: ${buildCommand}`
      ].join("\n") + "\n",
      "utf8"
    );
    return;
  }

  const diffResult = await runShellCommand(
    `git diff --no-index -- "${context.sourceDir}" "${context.workspaceDir}"`,
    resolveFromRepo(".")
  );

  if (diffResult.exitCode === 1 && diffResult.stdout.trim().length > 0) {
    await writeFile(patchPath, diffResult.stdout, "utf8");
    return;
  }

  if (diffResult.exitCode === 0) {
    await writeFile(
      patchPath,
      [
        "# no source changes detected in workspace",
        `# build command executed: ${buildCommand}`
      ].join("\n") + "\n",
      "utf8"
    );
    return;
  }

  await writeFile(
    patchPath,
    [
      "# patch capture failed",
      `# command: git diff --no-index -- \"${context.sourceDir}\" \"${context.workspaceDir}\"`,
      `# exitCode: ${diffResult.exitCode}`,
      diffResult.stderr.trimEnd()
    ]
      .filter((line) => line.length > 0)
      .join("\n") + "\n",
    "utf8"
  );
}

export async function loadRunnerContext(runInput: string, sourceDir?: string): Promise<RunnerContext> {
  const plannerContext = await loadPlannerContext(runInput);
  return {
    ...plannerContext,
    workspaceDir: resolveFromRepo(plannerContext.run.spec.workspace.root),
    sourceDir: sourceDir
      ? path.isAbsolute(sourceDir)
        ? sourceDir
        : resolveFromRepo(sourceDir)
      : undefined
  };
}

export async function runBuildStage(context: RunnerContext): Promise<{ result: CommandResult; run: AgentRun }> {
  await prepareWorkspace(context);

  const workspaceCwd = context.sourceDir
    ? path.join(context.workspaceDir, context.app.spec.repo.workdir)
    : context.workspaceDir;
  const command = context.app.spec.build.test;
  const result = await runShellCommand(command, workspaceCwd);

  await Promise.all([
    writeCommandLog(resolveFromRepo(context.run.status.artifacts.buildLog ?? path.posix.join("artifacts", context.run.metadata.name, "build.log")), result),
    capturePatchArtifact(context, command)
  ]);

  const nextRun: AgentRun = {
    ...context.run,
    status: {
      ...context.run.status,
      phase: result.exitCode === 0 ? "validating" : "failed",
      summary:
        result.exitCode === 0
          ? `Build command succeeded: ${command}`
          : `Build command failed: ${command}`,
      artifacts: {
        ...context.run.status.artifacts
      }
    }
  };

  await writeJsonFile(resolveFromRepo("artifacts", context.run.metadata.name, "run.json"), nextRun);

  if (nextRun.status.phase === "failed") {
    await writeRunResultArtifact(nextRun, {
      build: {
        command,
        exitCode: result.exitCode
      }
    });
  }

  return { result, run: nextRun };
}
