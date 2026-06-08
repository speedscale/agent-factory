/**
 * evidence-archive — preserve the RRPairs that triggered a signal so the bug
 * stays replayable after the window's temp dir is deleted.
 *
 * The streaming window processor writes each window's records to a temp dir,
 * runs signal detection, then deletes the dir in a `finally` block. For the
 * detect → confirm → replicate loop to work, the *failing requests* must
 * survive: the reproduce worker fetches them back from S3 and replays them
 * against a proxymock mock to confirm the bug is real.
 *
 * We archive only the evidence — the up-to-3 example RRPair files each Signal
 * carries — not the whole window. That keeps each object small (a handful of
 * files) and keyed by the signal fingerprint, so item 3 (the signal→AgentRun
 * bridge) can hand the reproduce worker an exact S3 key per signal.
 *
 * Layout inside the tarball mirrors the snapshot's host-subdir structure
 * (`<host>/00001.json`) so `proxymock replay` can consume it directly.
 */

import { mkdir, rm, copyFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Signal } from "./rrpair-stats.js";
import { archiveFile, type ArchiveResult } from "./snapshot-archive.js";

const execFileAsync = promisify(execFile);

export interface EvidenceArchiveResult {
  /** The signal this evidence belongs to. */
  fingerprint: string;
  /** Number of RRPair files archived. */
  fileCount: number;
  /** True when no archive backend is configured or there were no files. */
  skipped?: boolean;
  /** s3://bucket/key of the uploaded tarball (when not skipped). */
  uri?: string;
  /** Object key of the uploaded tarball (when not skipped). */
  key?: string;
}

/**
 * Archive the example RRPair files for a single signal to the configured S3
 * bucket, keyed by signal fingerprint.
 *
 * @param signal       The detected signal whose evidence to preserve.
 * @param snapshotDir  Absolute path to the window's temp snapshot dir. The
 *                     signal's `evidence.examples` are relative to this.
 * @param keyPrefix    S3 key prefix, e.g. "agent-factory/stream-evidence/radar".
 * @param ts           Compact timestamp tag for the object key.
 */
export async function archiveSignalEvidence(
  signal: Signal,
  snapshotDir: string,
  keyPrefix: string,
  ts: string,
  archive: typeof archiveFile = archiveFile,
): Promise<EvidenceArchiveResult> {
  const examples = signal.evidence.examples ?? [];
  if (examples.length === 0) {
    return { fingerprint: signal.fingerprint, fileCount: 0, skipped: true };
  }

  const stageDir = path.join(tmpdir(), `evidence-${signal.fingerprint}-${ts}`);
  const tgzPath = `${stageDir}.tgz`;

  try {
    await mkdir(stageDir, { recursive: true });

    // Copy each example file into the stage dir, preserving its host-subdir
    // path so the tarball is a self-contained replayable snapshot.
    let copied = 0;
    for (const rel of examples) {
      const src = path.join(snapshotDir, rel);
      try {
        await access(src);
      } catch {
        continue; // example file missing (shouldn't happen) — skip it
      }
      const dest = path.join(stageDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(src, dest);
      copied++;
    }

    if (copied === 0) {
      return { fingerprint: signal.fingerprint, fileCount: 0, skipped: true };
    }

    await execFileAsync("tar", ["-czf", tgzPath, "-C", stageDir, "."]);

    const key = `${keyPrefix.replace(/\/+$/, "")}/${signal.fingerprint}-${ts}.tgz`;
    const result: ArchiveResult = await archive(tgzPath, key);

    if (result.skipped) {
      return { fingerprint: signal.fingerprint, fileCount: copied, skipped: true };
    }
    return {
      fingerprint: signal.fingerprint,
      fileCount: copied,
      uri: result.uri,
      key,
    };
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(tgzPath, { force: true }).catch(() => undefined);
  }
}
