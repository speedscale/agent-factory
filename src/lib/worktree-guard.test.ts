import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorktreeGuard, guardToolCall, findForbiddenReference, MUTATING_TOOLS, PASSTHROUGH_TOOLS } from "./worktree-guard.js";

// Mirrors the observed incident layout: llm-run invoked with
// --source /Users/op/dev/radar/src --repo /Users/op/dev/radar
// --workdir /tmp/llm-run-work, worktree at /tmp/llm-run-work/repo.
const LIVE_REPO = "/Users/op/dev/radar";
const LIVE_SRC = "/Users/op/dev/radar/src";
const WORK_DIR = "/tmp/llm-run-work";
const WORKTREE = "/tmp/llm-run-work/repo";
const WORKTREE_SRC = "/tmp/llm-run-work/repo/src";

function makeGuard() {
  return buildWorktreeGuard({
    worktreePath: WORKTREE,
    workDir: WORK_DIR,
    repoDir: LIVE_REPO,
    sourceDir: LIVE_SRC,
    worktreeSourceDir: WORKTREE_SRC
  });
}

// ---------- write_file ----------

test("regression: Worker write through --source into the live checkout is rerooted into the worktree", () => {
  // Run 1 (2026-06-09): the Worker applied its patch to the live checkout's
  // src/server.js in addition to the worktree.
  const guard = makeGuard();
  const res = guardToolCall(guard, "write_file", { path: `${LIVE_SRC}/server.js`, content: "patched" });
  assert.ok(res.ok);
  assert.equal(res.input.path, `${WORKTREE_SRC}/server.js`);
  assert.match(res.note ?? "", /READ-ONLY/);
  assert.match(res.note ?? "", /redirected into the run worktree/);
});

test("regression: Planner harness write into the live checkout tests/ is rerooted via the repo mapping", () => {
  // Run 2 (2026-06-10): the source-mode Planner wrote its harness test into
  // the live checkout's tests/ directory (outside --source, inside --repo).
  const guard = makeGuard();
  const res = guardToolCall(guard, "write_file", { path: `${LIVE_REPO}/tests/storage.test.js`, content: "test" });
  assert.ok(res.ok);
  assert.equal(res.input.path, `${WORKTREE}/tests/storage.test.js`);
  assert.match(res.note ?? "", /READ-ONLY/);
});

test("write_file inside the worktree passes through unchanged", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "write_file", { path: `${WORKTREE_SRC}/services/storage.js`, content: "x" });
  assert.ok(res.ok);
  assert.equal(res.input.path, `${WORKTREE_SRC}/services/storage.js`);
  assert.equal(res.note, undefined);
});

test("write_file inside the workDir (scratch harness) passes through unchanged", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "write_file", { path: `${WORK_DIR}/confirm-harness.mjs`, content: "x" });
  assert.ok(res.ok);
  assert.equal(res.input.path, `${WORK_DIR}/confirm-harness.mjs`);
});

test("write_file to an unrelated absolute path is rejected with a retry hint", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "write_file", { path: "/Users/op/other-project/file.js", content: "x" });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /write_file blocked/);
    assert.match(res.error, new RegExp(WORKTREE.replace(/\//g, "\\/")));
  }
});

test("write_file to a sibling dir sharing the repo's name prefix is rejected, not rerooted", () => {
  // /Users/op/dev/radar-archive is NOT under /Users/op/dev/radar.
  const guard = makeGuard();
  const res = guardToolCall(guard, "write_file", { path: "/Users/op/dev/radar-archive/file.js", content: "x" });
  assert.equal(res.ok, false);
});

// ---------- run_shell ----------

test("run_shell command referencing the live checkout is blocked with the worktree path suggested", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_shell", { command: `npm test --prefix ${LIVE_REPO}` });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /run_shell blocked/);
    assert.match(res.error, new RegExp(WORKTREE.replace(/\//g, "\\/")));
  }
});

test("run_shell command referencing a live-checkout source file suggests the rerooted file", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_shell", { command: `node ${LIVE_SRC}/server.js` });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, new RegExp(`${WORKTREE_SRC}/server.js`.replace(/\//g, "\\/")));
});

test("run_shell with no cwd defaults cwd to the worktree", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_shell", { command: "npm test" });
  assert.ok(res.ok);
  assert.equal(res.input.cwd, WORKTREE);
});

test("run_shell with cwd in the live checkout is rerooted into the worktree", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_shell", { command: "npm test", cwd: LIVE_REPO });
  assert.ok(res.ok);
  assert.equal(res.input.cwd, WORKTREE);
  assert.match(res.note ?? "", /ran in the worktree instead/);
});

test("run_shell with cwd outside both roots is blocked", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_shell", { command: "npm test", cwd: "/Users/op/other-project" });
  assert.equal(res.ok, false);
});

test("run_shell referencing worktree paths is allowed", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_shell", { command: `node ${WORKTREE_SRC}/server.js`, cwd: WORKTREE });
  assert.ok(res.ok);
  assert.equal(res.note, undefined);
});

test("findForbiddenReference skips prefix-collisions and allowed nesting", () => {
  // Sibling dir sharing the prefix is not a reference to the live checkout.
  const guard = makeGuard();
  assert.equal(findForbiddenReference(guard, "ls /Users/op/dev/radar-archive"), undefined);
  // A workDir nested inside the repo would resolve under an allowed root.
  const nestedGuard = buildWorktreeGuard({
    worktreePath: `${LIVE_REPO}/.work/repo`,
    workDir: `${LIVE_REPO}/.work`,
    repoDir: LIVE_REPO,
    sourceDir: LIVE_SRC,
    worktreeSourceDir: `${LIVE_REPO}/.work/repo/src`
  });
  assert.equal(findForbiddenReference(nestedGuard, `node ${LIVE_REPO}/.work/harness.mjs`), undefined);
  assert.ok(findForbiddenReference(nestedGuard, `node ${LIVE_SRC}/server.js`));
});

// ---------- run_script ----------

test("run_script pointing into the live checkout is rerooted to the worktree copy", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_script", { path: `${LIVE_SRC}/harness.mjs` });
  assert.ok(res.ok);
  assert.equal(res.input.path, `${WORKTREE_SRC}/harness.mjs`);
});

test("run_script in scratch space outside both roots is allowed", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "run_script", { path: "/tmp/scratch/harness.mjs" });
  assert.ok(res.ok);
  assert.equal(res.input.path, "/tmp/scratch/harness.mjs");
});

// ---------- read-only tools ----------

test("read tools are not guarded — reads from the live checkout stay allowed", () => {
  const guard = makeGuard();
  for (const tool of ["read_file", "read_rrpair"]) {
    const res = guardToolCall(guard, tool, { path: `${LIVE_SRC}/server.js` });
    assert.ok(res.ok);
    assert.equal(res.input.path, `${LIVE_SRC}/server.js`);
  }
  const search = guardToolCall(guard, "search_code", { pattern: "foo", dir: LIVE_SRC });
  assert.ok(search.ok);
});

// ---------- symlinked roots (review finding #1) ----------

test("regression: physical-path writes into a symlinked worktree root are allowed, not rejected", async () => {
  // macOS aliases /tmp → /private/tmp. A model that runs `pwd` in the
  // worktree learns the physical form and uses it for subsequent writes;
  // lexical comparison alone rejected those as "outside the worktree".
  const base = await mkdtemp(path.join(os.tmpdir(), "wt-guard-symlink-"));
  try {
    const realBase = path.join(base, "real");
    const linkBase = path.join(base, "link");
    await mkdir(path.join(realBase, "repo", "src"), { recursive: true });
    await symlink(realBase, linkBase);

    // Guard built with the symlinked form (what the operator typed).
    const guard = buildWorktreeGuard({
      worktreePath: path.join(linkBase, "repo"),
      workDir: linkBase,
      repoDir: LIVE_REPO,
      sourceDir: LIVE_SRC,
      worktreeSourceDir: path.join(linkBase, "repo", "src")
    });

    // The model writes using the fully-resolved physical path (pwd output).
    const physicalWorktree = await realpath(path.join(linkBase, "repo"));
    assert.notEqual(physicalWorktree, path.join(linkBase, "repo"));
    const res = guardToolCall(guard, "write_file", {
      path: path.join(physicalWorktree, "src", "x.js"),
      content: "x"
    });
    assert.ok(res.ok, `physical-path write was rejected: ${res.ok ? "" : res.error}`);
    assert.equal(res.input.path, path.join(physicalWorktree, "src", "x.js"));

    // run_shell with the physical cwd is likewise allowed.
    const shell = guardToolCall(guard, "run_shell", { command: "npm test", cwd: physicalWorktree });
    assert.ok(shell.ok);
    assert.equal(shell.input.cwd, physicalWorktree);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("regression: forbidden-root references via the physical form are still caught", async () => {
  // The live checkout can be symlinked too — both forms must reroot/block.
  const base = await mkdtemp(path.join(os.tmpdir(), "wt-guard-symlink2-"));
  try {
    const realLive = path.join(base, "real-live");
    const linkLive = path.join(base, "link-live");
    await mkdir(path.join(realLive, "src"), { recursive: true });
    await symlink(realLive, linkLive);
    const worktree = path.join(base, "work", "repo");
    await mkdir(path.join(worktree, "src"), { recursive: true });

    const guard = buildWorktreeGuard({
      worktreePath: worktree,
      workDir: path.join(base, "work"),
      repoDir: linkLive,
      sourceDir: path.join(linkLive, "src"),
      worktreeSourceDir: path.join(worktree, "src")
    });

    const physicalLive = await realpath(linkLive);
    const res = guardToolCall(guard, "write_file", { path: path.join(physicalLive, "src", "server.js"), content: "x" });
    assert.ok(res.ok);
    assert.equal(res.input.path, path.join(worktree, "src", "server.js"));
    assert.match(res.note ?? "", /READ-ONLY/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------- fail-closed classification (review finding #3) ----------

test("unclassified tool is blocked while a worktree is active (fail closed)", () => {
  const guard = makeGuard();
  const res = guardToolCall(guard, "delete_file", { path: `${WORKTREE_SRC}/x.js` });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /not classified by the worktree guard/);
    assert.match(res.error, /MUTATING_TOOLS/);
  }
});

test("MUTATING_TOOLS and PASSTHROUGH_TOOLS are disjoint", () => {
  for (const t of MUTATING_TOOLS) assert.ok(!PASSTHROUGH_TOOLS.has(t), `${t} in both sets`);
});
