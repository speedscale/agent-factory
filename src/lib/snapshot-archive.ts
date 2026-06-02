/**
 * snapshot-archive — copy a pulled traffic snapshot into the agent factory's
 * own S3-compatible bucket so a bug stays reproducible even if the source
 * (BYOC Elasticsearch, a per-cluster snapshot, or an ephemeral Speedscale
 * cloud snapshot) is later deleted.
 *
 * S3-generic on purpose: configured entirely by endpoint + credentials, so it
 * targets DigitalOcean Spaces today and AWS S3 with no code change. When the
 * bucket env isn't set the upload is a no-op (returns { skipped: true }).
 *
 * The caller tars the snapshot dir to a single .tgz and hands that here — one
 * object per snapshot (not ~50k tiny RRPair files), uploaded as a streamed
 * multipart PUT so memory stays flat regardless of size.
 *
 * Config (env, mapped from the `radar-archive-s3` k8s secret):
 *   RADAR_ARCHIVE_BUCKET             bucket name (presence = archiving enabled)
 *   RADAR_ARCHIVE_ENDPOINT          S3 endpoint, e.g. https://nyc3.digitaloceanspaces.com
 *   RADAR_ARCHIVE_REGION            SigV4 region (default us-east-1)
 *   RADAR_ARCHIVE_ACCESS_KEY_ID     access key
 *   RADAR_ARCHIVE_SECRET_ACCESS_KEY secret key
 */

import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface ArchiveConfig {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Read archive config from env, or null when archiving is not configured. */
export function archiveConfigFromEnv(): ArchiveConfig | null {
  const bucket = process.env.RADAR_ARCHIVE_BUCKET;
  const accessKeyId = process.env.RADAR_ARCHIVE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RADAR_ARCHIVE_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    endpoint: process.env.RADAR_ARCHIVE_ENDPOINT || undefined,
    region: process.env.RADAR_ARCHIVE_REGION || "us-east-1",
    accessKeyId,
    secretAccessKey,
  };
}

export interface ArchiveResult {
  skipped?: boolean;
  uri?: string;
  bytes?: number;
}

/**
 * Upload a single local file (the snapshot tarball) to <bucket>/<key>.
 * Returns { skipped: true } when no archive is configured.
 */
export async function archiveFile(
  localFile: string,
  key: string,
  cfg = archiveConfigFromEnv(),
): Promise<ArchiveResult> {
  if (!cfg) return { skipped: true };
  const k = key.replace(/^\/+/, "");

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  try {
    await new Upload({
      client,
      params: { Bucket: cfg.bucket, Key: k, Body: createReadStream(localFile) },
    }).done();
  } finally {
    client.destroy();
  }
  return { uri: `s3://${cfg.bucket}/${k}`, bytes: (await stat(localFile)).size };
}
