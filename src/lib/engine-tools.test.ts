import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { toolListSnapshotDir, toolRunShell, dispatchToolHardened, setupWorktree, TOOLS } from "./llm-engine.js";
import { buildWorktreeGuard, MUTATING_TOOLS, PASSTHROUGH_TOOLS } from "./worktree-guard.js";

const execAsync = promisify(exec);

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "engine-tools-test-"));
}

// ---------- toolListSnapshotDir ----------

test("toolListSnapshotDir: detects misinvocation on a host RRPair dir", async () => {
  const dir = await makeTmp();
  try {
    // All entries are files — simulates a host dir
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(dir, `rrpair-${i}.md`), "x");
    }
    const out = await toolListSnapshotDir(dir);
    assert.match(out, /^error:/);
    assert.match(out, /host RRPair directory/);
    assert.match(out, /5 files/);
    assert.match(out, /read_rrpair/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toolListSnapshotDir: caps host output to LIST_SNAPSHOT_MAX_HOSTS", async () => {
  const dir = await makeTmp();
  try {
    // 150 host subdirs (> cap of 100)
    for (let i = 0; i < 150; i++) {
      const host = path.join(dir, `host-${i}.example.com`);
      await mkdir(host);
      await writeFile(path.join(host, "rrpair.md"), "x");
    }
    const out = await toolListSnapshotDir(dir);
    // Count the host header lines (format: "host-N: 1 RRPairs"). The cap
    // also adds a trailing "... and N more hosts" summary.
    const hostHeaderLines = out.split("\n").filter((l) => /^host-\d+\.example\.com: \d+ RRPairs$/.test(l));
    assert.equal(hostHeaderLines.length, 100);
    assert.match(out, /\.\.\. and 50 more hosts \(output capped at 100\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toolListSnapshotDir: normal case — small snapshot returns full listing", async () => {
  const dir = await makeTmp();
  try {
    for (const host of ["a.example.com", "b.example.com"]) {
      const hostDir = path.join(dir, host);
      await mkdir(hostDir);
      for (let i = 0; i < 5; i++) {
        await writeFile(path.join(hostDir, `${i}.md`), "x");
      }
    }
    const out = await toolListSnapshotDir(dir);
    assert.match(out, /a\.example\.com: 5 RRPairs/);
    assert.match(out, /b\.example\.com: 5 RRPairs/);
    assert.match(out, /\.\.\. and 2 more$/m); // 5 files, show first 3
    assert.doesNotMatch(out, /^error:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toolListSnapshotDir: nonexistent dir returns error:", async () => {
  const out = await toolListSnapshotDir("/nonexistent/snapshot/dir/xyz123");
  assert.match(out, /^error:/);
});

// ---------- toolRunShell ----------

test("toolRunShell: success returns plain output (no error prefix)", async () => {
  const out = await toolRunShell("echo hello");
  assert.equal(out, "hello");
});

test("toolRunShell: non-zero exit gets error: prefix (classified as executionError by dispatch)", async () => {
  const out = await toolRunShell("exit 7");
  assert.match(out, /^error:/);
});

test("toolRunShell: unknown command gets error: prefix", async () => {
  const out = await toolRunShell("this-command-does-not-exist-anywhere-12345");
  assert.match(out, /^error:/);
});

test("toolRunShell: BSD/GNU sed mismatch on macOS is surfaced as error", async () => {
  // BSD sed (macOS) rejects the `Na\\` insert syntax with "bad flag". GNU
  // sed accepts it. The Worker would otherwise burn loop budget retrying.
  const out = await toolRunShell("sed -i '1a\\foo' /tmp/__nonexistent_engine_tools_test_file");
  assert.match(out, /^error:/);
});

// ---------- worktree write guard (dispatch-level regression) ----------
//
// Regression for the 2026-06-09/10 incidents: the engine tools accept
// absolute paths, and the Worker/Planner wrote through the original --source
// path into the operator's live checkout despite the worktree. The guard in
// dispatchToolHardened must reroot live-checkout writes into the worktree and
// reject everything else outside it.

test("guarded dispatch: write_file into the live checkout lands in the worktree, live file untouched", async () => {
  const tmp = await makeTmp();
  try {
    const liveRepo = path.join(tmp, "live-checkout");
    const liveSrc = path.join(liveRepo, "src");
    const workDir = path.join(tmp, "work");
    const worktree = path.join(workDir, "repo");
    const worktreeSrc = path.join(worktree, "src");
    await mkdir(liveSrc, { recursive: true });
    await mkdir(worktreeSrc, { recursive: true });
    await writeFile(path.join(liveSrc, "server.js"), "original", "utf8");
    await writeFile(path.join(worktreeSrc, "server.js"), "original", "utf8");

    const guard = buildWorktreeGuard({
      worktreePath: worktree,
      workDir,
      repoDir: liveRepo,
      sourceDir: liveSrc,
      worktreeSourceDir: worktreeSrc
    });

    // The Worker tries to write its patch through the live checkout path.
    const outcome = await dispatchToolHardened(
      { name: "write_file", input: { path: path.join(liveSrc, "server.js"), content: "patched" } },
      TOOLS,
      new Set(),
      guard
    );
    assert.equal(outcome.kind, "ok");
    assert.match(outcome.content, /READ-ONLY/);
    assert.equal(await readFile(path.join(liveSrc, "server.js"), "utf8"), "original");
    assert.equal(await readFile(path.join(worktreeSrc, "server.js"), "utf8"), "patched");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("guarded dispatch: write_file outside the worktree is a softError and writes nothing", async () => {
  const tmp = await makeTmp();
  try {
    const worktree = path.join(tmp, "work", "repo");
    await mkdir(worktree, { recursive: true });
    const guard = buildWorktreeGuard({
      worktreePath: worktree,
      workDir: path.join(tmp, "work"),
      repoDir: path.join(tmp, "live-checkout")
    });

    const target = path.join(tmp, "elsewhere", "file.js");
    const outcome = await dispatchToolHardened(
      { name: "write_file", input: { path: target, content: "x" } },
      TOOLS,
      new Set(),
      guard
    );
    assert.equal(outcome.kind, "softError");
    assert.match(outcome.content, /write_file blocked/);
    await assert.rejects(readFile(target, "utf8"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("guarded dispatch: run_shell touching the live checkout is blocked; worktree commands run", async () => {
  const tmp = await makeTmp();
  try {
    const liveRepo = path.join(tmp, "live-checkout");
    const workDir = path.join(tmp, "work");
    const worktree = path.join(workDir, "repo");
    await mkdir(liveRepo, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const guard = buildWorktreeGuard({ worktreePath: worktree, workDir, repoDir: liveRepo });

    const blocked = await dispatchToolHardened(
      { name: "run_shell", input: { command: `touch ${path.join(liveRepo, "stray.txt")}` } },
      TOOLS,
      new Set(),
      guard
    );
    assert.equal(blocked.kind, "softError");
    assert.match(blocked.content, /run_shell blocked/);
    await assert.rejects(readFile(path.join(liveRepo, "stray.txt"), "utf8"));

    // cwd defaults to the worktree when omitted.
    const ok = await dispatchToolHardened(
      { name: "run_shell", input: { command: "pwd" } },
      TOOLS,
      new Set(),
      guard
    );
    assert.equal(ok.kind, "ok");
    assert.match(ok.content, new RegExp(`${worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`, "m"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("guarded dispatch: read_file from the live checkout stays allowed", async () => {
  const tmp = await makeTmp();
  try {
    const liveRepo = path.join(tmp, "live-checkout");
    const worktree = path.join(tmp, "work", "repo");
    await mkdir(liveRepo, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(liveRepo, "readme.txt"), "live content", "utf8");
    const guard = buildWorktreeGuard({ worktreePath: worktree, workDir: path.join(tmp, "work"), repoDir: liveRepo });

    const outcome = await dispatchToolHardened(
      { name: "read_file", input: { path: path.join(liveRepo, "readme.txt") } },
      TOOLS,
      new Set(),
      guard
    );
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.content, "live content");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("every engine tool is classified by the worktree guard (exhaustiveness)", () => {
  // A tool in neither set is blocked at runtime while a worktree is active
  // (fail closed), and this test makes the omission a CI failure: adding a
  // new tool to TOOLS requires classifying it in worktree-guard.ts.
  for (const tool of TOOLS) {
    assert.ok(
      MUTATING_TOOLS.has(tool.name) || PASSTHROUGH_TOOLS.has(tool.name),
      `tool "${tool.name}" is not classified in worktree-guard.ts (MUTATING_TOOLS or PASSTHROUGH_TOOLS)`
    );
  }
});

// ---------- setupWorktree self-healing ----------

async function makeGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const git = (cmd: string) => execAsync(`git -C ${JSON.stringify(dir)} ${cmd}`);
  await execAsync(`git init -b main ${JSON.stringify(dir)}`);
  await git(`config user.email test@example.com`);
  await git(`config user.name Test`);
  await writeFile(path.join(dir, "file.txt"), "hello", "utf8");
  await git(`add .`);
  await git(`commit -m init`);
}

test("setupWorktree: re-dispatch after a crashed run self-heals the stale worktree and branch", async () => {
  const tmp = await makeTmp();
  try {
    const repo = path.join(tmp, "repo");
    const workDir = path.join(tmp, "work");
    await makeGitRepo(repo);
    await mkdir(workDir, { recursive: true });

    // First run creates the worktree; simulate a crash by NOT tearing down.
    const first = await setupWorktree(repo, workDir, "agent/test-fix", repo);
    assert.equal(first.branchName, "agent/test-fix");

    // Re-dispatch with the same title → same branch name. Must succeed.
    const second = await setupWorktree(repo, workDir, "agent/test-fix", repo);
    assert.equal(second.worktreePath, path.join(workDir, "repo"));
    const { stdout } = await execAsync(`git -C ${JSON.stringify(second.worktreePath)} rev-parse --abbrev-ref HEAD`);
    assert.equal(stdout.trim(), "agent/test-fix");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("setupWorktree: refuses to delete a same-named branch that has unique commits", async () => {
  const tmp = await makeTmp();
  try {
    const repo = path.join(tmp, "repo");
    const workDir = path.join(tmp, "work");
    await makeGitRepo(repo);
    await mkdir(workDir, { recursive: true });
    const git = (cmd: string) => execAsync(`git -C ${JSON.stringify(repo)} ${cmd}`);

    // A branch with real work on it (not a disposable leftover).
    await git(`checkout -b agent/busy`);
    await writeFile(path.join(repo, "work.txt"), "important", "utf8");
    await git(`add .`);
    await git(`commit -m "real work"`);
    await git(`checkout main`);

    await assert.rejects(
      setupWorktree(repo, workDir, "agent/busy", repo),
      /already exists .* and has commits not on main/s
    );
    // The branch and its commit survive.
    const { stdout } = await execAsync(`git -C ${JSON.stringify(repo)} log --oneline agent/busy`);
    assert.match(stdout, /real work/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
