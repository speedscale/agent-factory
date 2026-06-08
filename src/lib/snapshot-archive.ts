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
 * Config (env, mapped from the traffic-archive k8s secret). Distinct from the
 * AF_ARCHIVE_* family in src/lib/archive/, which configures the GCS/local
 * run-artifact store — this is the S3-compatible bug-traffic/findings archive.
 *   AF_TRAFFIC_ARCHIVE_BUCKET             bucket name (presence = archiving enabled)
 *   AF_TRAFFIC_ARCHIVE_ENDPOINT           S3 endpoint, e.g. https://nyc3.digitaloceanspaces.com
 *   AF_TRAFFIC_ARCHIVE_REGION             SigV4 region (default us-east-1)
 *   AF_TRAFFIC_ARCHIVE_ACCESS_KEY_ID      access key
 *   AF_TRAFFIC_ARCHIVE_SECRET_ACCESS_KEY  secret key
 *
 * The legacy RADAR_ARCHIVE_* names (a holdover from the radar pilot) are still
 * read as a fallback so a new image keeps working against an older chart that
 * projects the old names — the rename rolls out without a flag-day.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface ArchiveConfig {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Read a traffic-archive env var, preferring the AF_TRAFFIC_ARCHIVE_* name and
 * falling back to the legacy RADAR_ARCHIVE_* name from the radar pilot. Kept
 * deliberately separate from the AF_ARCHIVE_* names in src/lib/archive/.
 */
export function archiveEnv(suffix: string): string | undefined {
  return process.env[`AF_TRAFFIC_ARCHIVE_${suffix}`] ?? process.env[`RADAR_ARCHIVE_${suffix}`];
}

/** Read archive config from env, or null when archiving is not configured. */
export function archiveConfigFromEnv(): ArchiveConfig | null {
  const bucket = archiveEnv("BUCKET");
  const accessKeyId = archiveEnv("ACCESS_KEY_ID");
  const secretAccessKey = archiveEnv("SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    endpoint: archiveEnv("ENDPOINT") || undefined,
    region: archiveEnv("REGION") || "us-east-1",
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

export interface FetchResult {
  skipped?: boolean;
  /** Local path the object was written to (when not skipped). */
  localFile?: string;
}

/**
 * Download a single object from <bucket>/<key> to a local file. The inverse of
 * archiveFile — used by the reproduce worker to pull back the failing traffic
 * it needs to replay. Returns { skipped: true } when no archive is configured.
 */
export async function fetchArchive(
  key: string,
  localFile: string,
  cfg = archiveConfigFromEnv(),
): Promise<FetchResult> {
  if (!cfg) return { skipped: true };
  const k = key.replace(/^\/+/, "");

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: k }));
    if (!res.Body) throw new Error(`empty object body for ${k}`);
    await pipeline(res.Body as Readable, createWriteStream(localFile));
  } finally {
    client.destroy();
  }
  return { localFile };
}
