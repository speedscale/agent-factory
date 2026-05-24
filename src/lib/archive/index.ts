/**
 * Archive factory. Picks gcs vs local based on env, exactly once per
 * process. Callers use `getArchiveStorage()` rather than newing up a
 * backend directly so the same code path works on workstations,
 * BYOC clusters, and SOS.
 *
 * Selection rules:
 *   - AF_ARCHIVE_BACKEND=gcs   → GcsArchiveStorage
 *   - AF_ARCHIVE_BACKEND=local → LocalArchiveStorage
 *   - else if AF_ARCHIVE_BUCKET set → GcsArchiveStorage
 *   - else → LocalArchiveStorage with a startup warn (so we don't
 *     silently lose history if the operator forgot to wire creds).
 */

import { createLogger, type Logger } from "../logger.js";
import { LocalArchiveStorage } from "./local.js";
import { GcsArchiveStorage } from "./gcs.js";
import type { ArchiveStorage } from "./storage.js";

export type { ArchiveStorage, ArchiveListEntry } from "./storage.js";
export { LocalArchiveStorage } from "./local.js";
export { GcsArchiveStorage } from "./gcs.js";

let cached: ArchiveStorage | null = null;

export interface GetArchiveOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Force a fresh resolution (tests). */
  fresh?: boolean;
}

export function getArchiveStorage(opts: GetArchiveOptions = {}): ArchiveStorage {
  if (cached && !opts.fresh) return cached;
  const env = opts.env ?? process.env;
  const log = opts.logger ?? createLogger({ component: "archive" });

  const backend = (env.AF_ARCHIVE_BACKEND ?? "").toLowerCase();
  const bucket = env.AF_ARCHIVE_BUCKET;

  let storage: ArchiveStorage;
  if (backend === "gcs" || (backend === "" && bucket)) {
    storage = new GcsArchiveStorage();
    log.info("archive backend: gcs", { bucket: bucket ?? "ken-ai-agent-factory-archive" });
  } else if (backend === "local") {
    storage = new LocalArchiveStorage();
    log.info("archive backend: local", { path: env.AF_ARCHIVE_PATH ?? "(default)" });
  } else {
    storage = new LocalArchiveStorage();
    log.warn(
      "archive backend defaulted to local — set AF_ARCHIVE_BUCKET or AF_ARCHIVE_BACKEND=gcs to persist beyond this host",
      { path: env.AF_ARCHIVE_PATH ?? "(default)" },
    );
  }
  cached = storage;
  return storage;
}

/** Test/utility hook: drop the cached archive so the next call re-resolves. */
export function resetArchiveCache(): void {
  cached = null;
}
