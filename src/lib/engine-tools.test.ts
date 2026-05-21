import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolListSnapshotDir, toolRunShell } from "./llm-engine.js";

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
