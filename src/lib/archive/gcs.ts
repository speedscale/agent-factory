/**
 * GCS-backed ArchiveStorage.
 *
 * Default bucket: `ken-ai-agent-factory-archive` (project
 * `ken-ai-agent-factory`). Override the bucket via AF_ARCHIVE_BUCKET.
 * Auth is Application Default Credentials — works for both gcloud-auth
 * on workstations and Workload Identity in-cluster.
 *
 * The @google-cloud/storage import is dynamic so test environments and
 * the local backend never need to bundle it. Callers that don't set
 * AF_ARCHIVE_BUCKET (or AF_ARCHIVE_BACKEND=gcs) will never load this
 * module.
 */

import type { Storage as GcsStorage, Bucket } from "@google-cloud/storage";
import type { ArchiveStorage, ArchiveListEntry } from "./storage.js";

export const DEFAULT_BUCKET = "ken-ai-agent-factory-archive";
export const DEFAULT_PROJECT = "ken-ai-agent-factory";

export interface GcsArchiveOptions {
  bucket?: string;
  project?: string;
  /** Inject a pre-built Storage client (used by tests). */
  client?: GcsStorage;
}

export class GcsArchiveStorage implements ArchiveStorage {
  readonly bucketName: string;
  private bucketHandle: Bucket | null = null;
  private clientPromise: Promise<GcsStorage> | null = null;

  constructor(opts: GcsArchiveOptions = {}) {
    this.bucketName = opts.bucket ?? process.env.AF_ARCHIVE_BUCKET ?? DEFAULT_BUCKET;
    if (opts.client) {
      this.bucketHandle = opts.client.bucket(this.bucketName);
    } else {
      const project = opts.project ?? DEFAULT_PROJECT;
      this.clientPromise = import("@google-cloud/storage").then((mod) => {
        const client = new mod.Storage({ projectId: project });
        this.bucketHandle = client.bucket(this.bucketName);
        return client;
      });
    }
  }

  private async bucket(): Promise<Bucket> {
    if (!this.bucketHandle) {
      if (!this.clientPromise) {
        throw new Error("gcs archive: no client and no init promise (logic error)");
      }
      await this.clientPromise;
    }
    if (!this.bucketHandle) {
      throw new Error("gcs archive: bucket failed to initialize");
    }
    return this.bucketHandle;
  }

  async put(key: string, body: string | Buffer): Promise<void> {
    const b = await this.bucket();
    const file = b.file(key);
    const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    await file.save(buf, { resumable: false });
  }

  async get(key: string): Promise<Buffer> {
    const b = await this.bucket();
    const file = b.file(key);
    const [contents] = await file.download();
    return contents;
  }

  async *list(prefix: string): AsyncIterable<ArchiveListEntry> {
    const b = await this.bucket();
    const [files] = await b.getFiles({ prefix });
    for (const f of files) {
      const meta = f.metadata;
      const size = typeof meta.size === "string" ? Number(meta.size) : (meta.size ?? 0);
      const updated = meta.updated ? new Date(meta.updated) : new Date(0);
      yield { key: f.name, size, ts: updated };
    }
  }
}
