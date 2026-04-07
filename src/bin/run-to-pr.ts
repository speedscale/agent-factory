import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo } from "../lib/io.js";

interface Options {
  run: string;
  repo: string;
  base?: string;
  branch?: string;
  title?: string;
  allowDirty: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function getArg(argv: string[], names: string[]): string | undefined {
  const index = argv.findIndex((value) => names.includes(value));
  if (index >= 0 && typeof argv[index + 1] === "string") {
    return argv[index + 1];
  }

  return undefined;
}

function hasFlag(argv: string[], names: string[]): boolean {
  return argv.some((value) => names.includes(value));
}

function parseOptions(argv: string[]): Options {
  const run = getArg(argv, ["--run", "-r"]);
  const repo = getArg(argv, ["--repo"]);

  if (!run) {
    throw new Error("missing required --run");
  }

  if (!repo) {
    throw new Error("missing required --repo");
  }

  return {
    run,
    repo,
    base: getArg(argv, ["--base"]),
    branch: getArg(argv, ["--branch"]),
    title: getArg(argv, ["--title"]),
    allowDirty: hasFlag(argv, ["--allow-dirty"])
  };
}

function toAbsoluteRepoPath(repoPath: string): string {
  return path.isAbsolute(repoPath) ? repoPath : resolveFromRepo(repoPath);
}

function resolveRunPath(runInput: string): string {
  return runInput.endsWith(".json") ? resolveFromRepo(runInput) : resolveFromRepo("artifacts", runInput, "run.json");
}

function runShell(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
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

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function ensureCleanRepo(repoPath: string): Promise<void> {
  const status = await runShell("git status --porcelain", repoPath);
  if (status.exitCode !== 0) {
    throw new Error(`unable to inspect repository state: ${status.stderr || status.stdout}`);
  }

  if (status.stdout.trim().length > 0) {
    throw new Error("target repository has local changes; commit or stash them first (or use --allow-dirty)");
  }
}

async function syncWorkspaceToRepo(run: AgentRun, app: AgentApp, repoPath: string): Promise<void> {
  const workspaceRoot = resolveFromRepo(run.spec.workspace.root);
  const workdir = app.spec.repo.workdir;

  const workspaceAppPath = path.join(workspaceRoot, workdir);
  const repoAppPath = path.join(repoPath, workdir);

  await mkdir(repoAppPath, { recursive: true });
  await cp(workspaceAppPath, repoAppPath, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const relative = path.relative(workspaceAppPath, sourcePath);
      if (!relative || relative === ".") {
        return true;
      }

      const segments = relative.split(path.sep);
      return !segments.includes("target") && !segments.includes("node_modules");
    }
  });
}

async function stageAndCommit(repoPath: string, appWorkdir: string, branch: string, message: string): Promise<boolean> {
  const checkout = await runShell(`git checkout -B ${branch}`, repoPath);
  if (checkout.exitCode !== 0) {
    throw new Error(`failed to checkout branch '${branch}': ${checkout.stderr || checkout.stdout}`);
  }

  const add = await runShell(`git add "${appWorkdir}"`, repoPath);
  if (add.exitCode !== 0) {
    throw new Error(`failed to stage changes: ${add.stderr || add.stdout}`);
  }

  const staged = await runShell("git diff --cached --name-only", repoPath);
  if (staged.exitCode !== 0) {
    throw new Error(`failed to inspect staged changes: ${staged.stderr || staged.stdout}`);
  }

  if (staged.stdout.trim().length === 0) {
    return false;
  }

  const commit = await runShell(`git commit -m "${message.replace(/"/g, '\\"')}"`, repoPath);
  if (commit.exitCode !== 0) {
    throw new Error(`failed to create commit: ${commit.stderr || commit.stdout}`);
  }

  return true;
}

async function openPullRequest(repoPath: string, branch: string, base: string, title: string, run: AgentRun): Promise<string> {
  const push = await runShell(`git push -u origin ${branch}`, repoPath);
  if (push.exitCode !== 0) {
    throw new Error(`failed to push branch: ${push.stderr || push.stdout}`);
  }

  const body = [
    "## Summary",
    `- automated run-to-PR output for ${run.metadata.name}`,
    `- issue: ${run.spec.issue.title}`,
    "",
    "## Evidence",
    `- run artifact: artifacts/${run.metadata.name}/run.json`,
    `- triage artifact: artifacts/${run.metadata.name}/triage.json`,
    `- patch artifact: artifacts/${run.metadata.name}/patch.diff`,
    `- validation artifact: artifacts/${run.metadata.name}/validation.log`,
    `- result artifact: artifacts/${run.metadata.name}/result.json`
  ].join("\n");

  const create = await runShell(
    `gh pr create --base "${base}" --head "${branch}" --title "${title.replace(/"/g, '\\"')}" --body "${body
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")}"`,
    repoPath
  );

  if (create.exitCode !== 0) {
    throw new Error(`failed to create PR: ${create.stderr || create.stdout}`);
  }

  return create.stdout.trim();
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runPath = resolveRunPath(options.run);
  const runDir = path.dirname(runPath);
  const appPath = path.join(runDir, "app.json");

  const [run, app] = await Promise.all([
    readJsonFile<AgentRun>(runPath),
    readJsonFile<AgentApp>(appPath)
  ]);

  if (run.status.phase !== "succeeded") {
    throw new Error(`run must be succeeded before PR creation (current phase: ${run.status.phase})`);
  }

  const repoPath = toAbsoluteRepoPath(options.repo);

  if (!options.allowDirty) {
    await ensureCleanRepo(repoPath);
  }

  await syncWorkspaceToRepo(run, app, repoPath);

  const branch = options.branch ?? run.spec.workspace.branch ?? `agent/${run.metadata.name}`;
  const commitMessage = `fix: ${run.spec.issue.title}`;
  const committed = await stageAndCommit(repoPath, app.spec.repo.workdir, branch, commitMessage);

  if (!committed) {
    console.log(
      JSON.stringify(
        {
          message: "no changes detected in app workdir; skipping PR creation",
          run: run.metadata.name,
          repo: repoPath,
          workdir: app.spec.repo.workdir
        },
        null,
        2
      )
    );
    return;
  }

  const prTitle = options.title ?? `Fix: ${run.spec.issue.title}`;
  const base = options.base ?? app.spec.repo.defaultBranch;
  const prUrl = await openPullRequest(repoPath, branch, base, prTitle, run);

  console.log(
    JSON.stringify(
      {
        message: "run-to-pr completed",
        run: run.metadata.name,
        branch,
        base,
        prUrl
      },
      null,
      2
    )
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "run-to-pr failed";
  console.error(message);
  process.exitCode = 1;
});
