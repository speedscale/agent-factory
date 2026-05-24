/**
 * Storage abstraction for the archive substrate.
 *
 * Every model trace, eval run, and judgment is written through this
 * interface. Two implementations exist today:
 *
 *   - LocalArchiveStorage — fs/promises rooted at AF_ARCHIVE_PATH
 *   - GcsArchiveStorage   — @google-cloud/storage bucket
 *
 * The selection happens in ./index.ts so callers don't bind to a concrete
 * impl. New backends (S3, Azure Blob, etc.) only need to satisfy this
 * interface; everything downstream — recorder hook, eval runner, judge —
 * is backend-agnostic.
 */

export interface ArchiveListEntry {
  key: string;
  size: number;
  ts: Date;
}

export interface ArchiveStorage {
  /** Write `body` at `key`. Overwrites any existing object. */
  put(key: string, body: string | Buffer): Promise<void>;

  /** Read the object at `key`. Throws if absent. */
  get(key: string): Promise<Buffer>;

  /** Stream entries under `prefix`. Ordering is impl-defined. */
  list(prefix: string): AsyncIterable<ArchiveListEntry>;
}
