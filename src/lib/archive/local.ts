/**
 * Filesystem-backed ArchiveStorage.
 *
 * Default backend on workstations and in cluster pods that don't have
 * GCS creds wired up. Root directory defaults:
 *
 *   - workstation: ~/.agent-factory/archive
 *   - cluster:     /var/lib/agent-factory/archive (set via AF_ARCHIVE_PATH)
 *
 * Layout under the root mirrors GCS object keys exactly so a directory
 * tree can be `gsutil rsync`'d up later without rewriting any caller.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ArchiveStorage, ArchiveListEntry } from "./storage.js";

export interface LocalArchiveOptions {
  root?: string;
}

export function defaultLocalRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AF_ARCHIVE_PATH) return env.AF_ARCHIVE_PATH;
  return path.join(os.homedir(), ".agent-factory", "archive");
}

export class LocalArchiveStorage implements ArchiveStorage {
  readonly root: string;

  constructor(opts: LocalArchiveOptions = {}) {
    this.root = opts.root ?? defaultLocalRoot();
  }

  async put(key: string, body: string | Buffer): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }

  async get(key: string): Promise<Buffer> {
    const abs = this.resolve(key);
    return fs.readFile(abs);
  }

  async *list(prefix: string): AsyncIterable<ArchiveListEntry> {
    // GCS treats `prefix` as a string-match, not a directory. We honor
    // that by walking from the deepest existing directory ancestor of
    // the prefix and filtering by string-prefix on the relative key.
    const absPrefix = this.resolve(prefix);
    let walkRoot = absPrefix;
    let stat;
    try {
      stat = await fs.stat(walkRoot);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      // Walk from the nearest existing directory ancestor.
      walkRoot = path.dirname(absPrefix);
      try {
        const s = await fs.stat(walkRoot);
        if (!s.isDirectory()) return;
      } catch {
        return;
      }
    }

    for await (const entry of walk(walkRoot)) {
      const rel = path.relative(this.root, entry.abs);
      // Normalize to forward slashes so keys behave like GCS object
      // keys even on Windows-style filesystems.
      const key = rel.split(path.sep).join("/");
      if (!key.startsWith(prefix)) continue;
      yield {
        key,
        size: entry.size,
        ts: entry.mtime,
      };
    }
  }

  private resolve(key: string): string {
    // Block path traversal — keys must be relative and contained.
    if (key.startsWith("/") || key.includes("..")) {
      throw new Error(`invalid archive key: ${key}`);
    }
    return path.join(this.root, key);
  }
}

async function* walk(
  dir: string,
): AsyncIterable<{ abs: string; size: number; mtime: Date }> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(abs);
    } else if (e.isFile()) {
      const s = await fs.stat(abs);
      yield { abs, size: s.size, mtime: s.mtime };
    }
  }
}
