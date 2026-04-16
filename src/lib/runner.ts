import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { createGitHubAuthProviderFromEnv } from "./github-auth.js";
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

interface CommandExecutionOptions {
  timeoutSeconds?: number;
  maxNoOutputSeconds?: number;
}

function resolveRunJsonPath(runInput: string): string {
  return runInput.endsWith(".json")
    ? resolveFromRepo(runInput)
    : resolveFromRepo("artifacts", runInput, "run.json");
}

async function runShellCommand(command: string, cwd: string, options: CommandExecutionOptions = {}): Promise<CommandResult> {
  const timeoutSeconds = typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0 ? options.timeoutSeconds : undefined;
  const maxNoOutputSeconds =
    typeof options.maxNoOutputSeconds === "number" && options.maxNoOutputSeconds > 0 ? options.maxNoOutputSeconds : undefined;

  return await new Promise<CommandResult>((resolve) => {
    let settled = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let hardTimeout: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (hardTimeout) {
        clearTimeout(hardTimeout);
        hardTimeout = undefined;
      }

      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = undefined;
      }

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
    };

    const beginShutdown = (reason: string): void => {
      if (settled) {
        return;
      }

      stderr = [stderr.trimEnd(), reason].filter((line) => line.length > 0).join("\n");
      child.kill("SIGTERM");

      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3000);
    };

    const resetIdleTimer = (): void => {
      if (!maxNoOutputSeconds) {
        return;
      }

      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }

      idleTimeout = setTimeout(() => {
        beginShutdown(`command exceeded no-output timeout (${maxNoOutputSeconds}s): ${command}`);
      }, maxNoOutputSeconds * 1000);
    };

    if (timeoutSeconds) {
      hardTimeout = setTimeout(() => {
        beginShutdown(`command exceeded timeout (${timeoutSeconds}s): ${command}`);
      }, timeoutSeconds * 1000);
    }

    resetIdleTimer();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      resetIdleTimer();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      resetIdleTimer();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolve({
        command,
        exitCode: 1,
        stdout,
        stderr: [stderr.trimEnd(), `spawn error: ${error.message}`].filter((line) => line.length > 0).join("\n")
      });
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolve({
        command,
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function firstUsefulLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  return line ?? "no output";
}

async function runShellCommandWithRetries(
  command: string,
  cwd: string,
  options: CommandExecutionOptions,
  retries: number,
  stageName: string
): Promise<CommandResult> {
  const maxAttempts = Math.max(1, Math.floor(retries) + 1);
  const failures: CommandResult[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runShellCommand(command, cwd, options);
    if (result.exitCode === 0) {
      if (attempt === 1) {
        return result;
      }

      return {
        ...result,
        stderr: [result.stderr.trimEnd(), `${stageName} succeeded on attempt ${attempt}/${maxAttempts}`]
          .filter((line) => line.length > 0)
          .join("\n")
      };
    }

    failures.push(result);
  }

  const final = failures[failures.length - 1];
  if (failures.length <= 1) {
    return final;
  }

  const attemptSummary = failures
    .slice(0, -1)
    .map((failure, index) => `attempt ${index + 1}/${maxAttempts} failed (exit ${failure.exitCode}): ${firstUsefulLine(failure.stderr || failure.stdout)}`)
    .join("\n");

  return {
    ...final,
    stderr: [final.stderr.trimEnd(), `previous ${stageName} attempts:\n${attemptSummary}`]
      .filter((line) => line.length > 0)
      .join("\n")
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseGitHubRepoFullName(repoUrl: string): string | undefined {
  const httpsMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return undefined;
}

function buildAuthenticatedGitUrl(repoUrl: string, token: string): string {
  const trimmed = repoUrl.trim();
  const normalized = trimmed.startsWith("git@github.com:")
    ? `https://github.com/${trimmed.slice("git@github.com:".length)}`
    : trimmed;

  if (!normalized.startsWith("https://github.com/")) {
    return normalized;
  }

  return normalized.replace("https://", `https://x-access-token:${encodeURIComponent(token)}@`);
}

async function cloneRepoIntoWorkspace(context: RunnerContext): Promise<void> {
  const repoUrl = context.app.spec.repo.url.trim();
  const defaultBranch = context.app.spec.repo.defaultBranch.trim() || "main";
  const repoFullName = parseGitHubRepoFullName(repoUrl);
  const githubAuth = createGitHubAuthProviderFromEnv();

  let cloneUrl = repoUrl;
  if (repoFullName && githubAuth) {
    const token = await githubAuth.getTokenForRepo(repoFullName);
    cloneUrl = buildAuthenticatedGitUrl(repoUrl, token);
  }

  await rm(context.workspaceDir, { recursive: true, force: true });
  await mkdir(path.dirname(context.workspaceDir), { recursive: true });

  const cloneResult = await runShellCommand(
    `git clone --depth 1 --branch ${shellQuote(defaultBranch)} ${shellQuote(cloneUrl)} ${shellQuote(context.workspaceDir)}`,
    resolveFromRepo(".")
  );

  if (cloneResult.exitCode !== 0) {
    throw new Error(`repository checkout failed: ${cloneResult.stderr || cloneResult.stdout || "git clone failed"}`);
  }
}

async function ensureWorkdirExists(workspaceCwd: string): Promise<void> {
  try {
    const details = await stat(workspaceCwd);
    if (!details.isDirectory()) {
      throw new Error("path exists but is not a directory");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`app workdir not found in workspace (${workspaceCwd}): ${message}`);
  }
}

async function prepareWorkspace(context: RunnerContext): Promise<void> {
  if (context.sourceDir) {
    await rm(context.workspaceDir, { recursive: true, force: true });
    await mkdir(path.dirname(context.workspaceDir), { recursive: true });
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

    return;
  }

  await cloneRepoIntoWorkspace(context);
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
    const workspaceDiff = await runShellCommand(`git -C ${shellQuote(context.workspaceDir)} diff`, resolveFromRepo("."));
    if (workspaceDiff.exitCode === 0 && workspaceDiff.stdout.trim().length > 0) {
      await writeFile(patchPath, workspaceDiff.stdout, "utf8");
      return;
    }

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

  const appWorkdir = context.app.spec.repo.workdir;
  const sourceAppDir = path.join(context.sourceDir, appWorkdir);
  const workspaceAppDir = path.join(context.workspaceDir, appWorkdir);

  const diffResult = await runShellCommand(
    `git diff --no-index -- "${sourceAppDir}" "${workspaceAppDir}"`,
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
      `# command: git diff --no-index -- \"${sourceAppDir}\" \"${workspaceAppDir}\"`,
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

  const workspaceCwd = path.join(context.workspaceDir, context.app.spec.repo.workdir);
  await ensureWorkdirExists(workspaceCwd);
  const command = context.app.spec.build.test;
  const result = await runShellCommandWithRetries(
    command,
    workspaceCwd,
    {
      timeoutSeconds: context.app.spec.build.timeoutSeconds,
      maxNoOutputSeconds: context.app.spec.build.maxNoOutputSeconds
    },
    context.app.spec.build.retries ?? 0,
    "build"
  );

  await Promise.all([
    writeCommandLog(resolveFromRepo(context.run.status.artifacts.buildLog ?? path.posix.join("artifacts", context.run.metadata.name, "build.log")), result),
    capturePatchArtifact(context, command)
  ]);

  const nextRun: AgentRun = {
    ...context.run,
    status: {
      ...context.run.status,
      phase: result.exitCode === 0 ? "validating" : "failed",
      lastTransitionAt: new Date().toISOString(),
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
