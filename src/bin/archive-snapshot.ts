/**
 * archive-snapshot — upload a snapshot tarball to the factory's own
 * S3-compatible archive bucket. Called by the radar-monitor only when a scan
 * filed a ticket, so the bug's traffic survives deletion of the source.
 *
 * Usage:
 *   node dist/bin/archive-snapshot.js --file <snapshot.tgz> --key <objectKey>
 *
 * No-op (exit 0) when the archive bucket isn't configured. Upload failure
 * exits non-zero, but the caller treats it as non-fatal — the ticket is
 * already filed; a missing archive just means that one bug isn't replayable.
 */

import { archiveFile } from "../lib/snapshot-archive.js";

function getArg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const file = getArg(argv, "--file");
  const key = getArg(argv, "--key");
  if (!file || !key) {
    console.error("usage: archive-snapshot --file <snapshot.tgz> --key <objectKey>");
    process.exit(2);
  }
  try {
    const r = await archiveFile(file, key);
    if (r.skipped) {
      console.log(JSON.stringify({ phase: "archive", skipped: true, reason: "no AF_TRAFFIC_ARCHIVE_BUCKET" }));
    } else {
      console.log(JSON.stringify({ phase: "archive", uri: r.uri, bytes: r.bytes }));
    }
  } catch (e) {
    console.error(`archive failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

void main();
