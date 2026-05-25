import { test } from "node:test";
import assert from "node:assert/strict";
import { runBuildCommands, type CommandResult } from "./runner.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function ok(command: string): CommandResult {
  return { command, exitCode: 0, stdout: `${command} stdout`, stderr: "" };
}

function fail(command: string, exitCode = 1): CommandResult {
  return { command, exitCode, stdout: "", stderr: `${command} stderr` };
}

/**
 * Build a fake runCmd that returns scripted results in order, recording every
 * invocation so tests can assert which commands were attempted.
 */
function scriptedRunner(results: Record<"install" | "build", CommandResult | undefined>) {
  const calls: Array<{ command: string; stageName: "install" | "build" }> = [];
  const runCmd = async (command: string, stageName: "install" | "build"): Promise<CommandResult> => {
    calls.push({ command, stageName });
    const result = results[stageName];
    if (!result) throw new Error(`runCmd("${command}", "${stageName}") had no scripted result`);
    return result;
  };
  return { calls, runCmd };
}

// ── runBuildCommands ─────────────────────────────────────────────────────────

test("runBuildCommands: install runs before test when set", async () => {
  const { calls, runCmd } = scriptedRunner({
    install: ok("npm ci"),
    build: ok("npm test"),
  });

  const { stageResults, result, failedStage } = await runBuildCommands("npm ci", "npm test", runCmd);

  assert.deepEqual(
    calls.map((c) => [c.stageName, c.command]),
    [["install", "npm ci"], ["build", "npm test"]],
    "install must run before build, in order",
  );
  assert.equal(stageResults.length, 2);
  assert.equal(result.command, "npm test");
  assert.equal(failedStage, null);
});

test("runBuildCommands: install is skipped when undefined", async () => {
  const { calls, runCmd } = scriptedRunner({ install: undefined, build: ok("go test ./...") });

  const { stageResults, failedStage } = await runBuildCommands(undefined, "go test ./...", runCmd);

  assert.deepEqual(calls.map((c) => c.stageName), ["build"], "no install call when command is undefined");
  assert.equal(stageResults.length, 1);
  assert.equal(failedStage, null);
});

test("runBuildCommands: install is skipped when empty string", async () => {
  const { calls, runCmd } = scriptedRunner({ install: undefined, build: ok("npm test") });

  await runBuildCommands("", "npm test", runCmd);

  assert.deepEqual(calls.map((c) => c.stageName), ["build"]);
});

test("runBuildCommands: install is skipped when whitespace-only", async () => {
  const { calls, runCmd } = scriptedRunner({ install: undefined, build: ok("npm test") });

  await runBuildCommands("   \t  ", "npm test", runCmd);

  assert.deepEqual(calls.map((c) => c.stageName), ["build"]);
});

test("runBuildCommands: install command is trimmed before being passed to runCmd", async () => {
  const { calls, runCmd } = scriptedRunner({
    install: ok("npm ci"),
    build: ok("npm test"),
  });

  await runBuildCommands("  npm ci  ", "npm test", runCmd);

  assert.equal(calls[0].command, "npm ci", "leading/trailing whitespace stripped");
});

test("runBuildCommands: test is NOT run when install fails", async () => {
  const { calls, runCmd } = scriptedRunner({
    install: fail("go mod download", 2),
    build: ok("go test ./..."),
  });

  const { stageResults, result, failedStage } = await runBuildCommands(
    "go mod download",
    "go test ./...",
    runCmd,
  );

  assert.deepEqual(
    calls.map((c) => c.stageName),
    ["install"],
    "build must not run when install fails",
  );
  assert.equal(stageResults.length, 1);
  assert.equal(result.command, "go mod download");
  assert.equal(result.exitCode, 2);
  assert.equal(failedStage, "install");
});

test("runBuildCommands: failedStage is 'build' when install passes but test fails", async () => {
  const { runCmd } = scriptedRunner({
    install: ok("npm ci"),
    build: fail("npm test", 1),
  });

  const { stageResults, result, failedStage } = await runBuildCommands("npm ci", "npm test", runCmd);

  assert.equal(stageResults.length, 2);
  assert.equal(result.command, "npm test");
  assert.equal(failedStage, "build");
});

test("runBuildCommands: stageResults preserves order (install then build)", async () => {
  const { runCmd } = scriptedRunner({
    install: ok("pip install -r requirements.txt"),
    build: ok("pytest"),
  });

  const { stageResults } = await runBuildCommands(
    "pip install -r requirements.txt",
    "pytest",
    runCmd,
  );

  assert.equal(stageResults[0].command, "pip install -r requirements.txt");
  assert.equal(stageResults[1].command, "pytest");
});

test("runBuildCommands: stageName 'install' is propagated to runCmd (for stage-specific logging)", async () => {
  const { calls, runCmd } = scriptedRunner({
    install: fail("go mod download"),
    build: ok("ignored"),
  });

  await runBuildCommands("go mod download", "go test", runCmd);

  assert.equal(calls[0].stageName, "install", "runCmd must receive stageName=install for the install command");
});
