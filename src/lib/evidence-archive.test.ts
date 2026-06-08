import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { archiveSignalEvidence } from "./evidence-archive.js";
import type { Signal } from "./rrpair-stats.js";
import type { ArchiveResult } from "./snapshot-archive.js";

async function makeSnapshotWithExamples(): Promise<{ dir: string; examples: string[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "af-ev-test-"));
  const host = "radar.speedscale.com_3000";
  await mkdir(path.join(dir, host), { recursive: true });
  const examples: string[] = [];
  for (let i = 0; i < 2; i++) {
    const rel = path.join(host, `0000${i}.json`);
    await writeFile(path.join(dir, rel), JSON.stringify({ l7protocol: "http", duration: 1200, n: i }));
    examples.push(rel);
  }
  return { dir, examples };
}

function signalWith(examples: string[]): Signal {
  return {
    kind: "slow-endpoint",
    severity: "high",
    fingerprint: "deadbeef",
    title: "Slow endpoint",
    details: "",
    evidence: { host: "radar.speedscale.com", pattern: "GET:/api/x", count: 2, examples },
  };
}

test("archiveSignalEvidence tars the example files and uploads keyed by fingerprint", async () => {
  const { dir, examples } = await makeSnapshotWithExamples();

  let uploadedKey = "";
  let uploadedFileExists = false;
  const fakeArchive = async (localFile: string, key: string): Promise<ArchiveResult> => {
    uploadedKey = key;
    uploadedFileExists = (await stat(localFile)).size > 0;
    return { uri: `s3://test-bucket/${key}`, bytes: 123 };
  };

  const result = await archiveSignalEvidence(
    signalWith(examples),
    dir,
    "agent-factory/stream-evidence/radar",
    "20260608T120000Z",
    fakeArchive,
  );

  assert.equal(result.skipped, undefined, "should not be skipped");
  assert.equal(result.fingerprint, "deadbeef");
  assert.equal(result.fileCount, 2);
  assert.equal(result.key, "agent-factory/stream-evidence/radar/deadbeef-20260608T120000Z.tgz");
  assert.equal(uploadedKey, result.key);
  assert.ok(uploadedFileExists, "uploaded tarball should be non-empty");
  assert.equal(result.uri, `s3://test-bucket/${result.key}`);
});

test("archiveSignalEvidence skips when the signal has no examples", async () => {
  const { dir } = await makeSnapshotWithExamples();
  let called = false;
  const fakeArchive = async (): Promise<ArchiveResult> => { called = true; return { skipped: true }; };

  const result = await archiveSignalEvidence(signalWith([]), dir, "p", "ts", fakeArchive);

  assert.equal(result.skipped, true);
  assert.equal(result.fileCount, 0);
  assert.equal(called, false, "archive should not be called when there are no examples");
});

test("archiveSignalEvidence reports skipped when the archive backend is not configured", async () => {
  const { dir, examples } = await makeSnapshotWithExamples();
  const fakeArchive = async (): Promise<ArchiveResult> => ({ skipped: true });

  const result = await archiveSignalEvidence(signalWith(examples), dir, "p", "ts", fakeArchive);

  assert.equal(result.skipped, true);
  assert.equal(result.fileCount, 2, "files were staged even though upload no-oped");
});
