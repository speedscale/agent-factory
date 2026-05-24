import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalArchiveStorage, defaultLocalRoot } from "./local.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "af-archive-"));
}

test("put + get round-trips a string", async () => {
  const root = await tmpRoot();
  const s = new LocalArchiveStorage({ root });
  await s.put("a/b/c.json", JSON.stringify({ k: 1 }));
  const buf = await s.get("a/b/c.json");
  assert.equal(buf.toString("utf8"), '{"k":1}');
});

test("put + get round-trips a Buffer", async () => {
  const root = await tmpRoot();
  const s = new LocalArchiveStorage({ root });
  const body = Buffer.from([0x01, 0x02, 0x03]);
  await s.put("bin.dat", body);
  const got = await s.get("bin.dat");
  assert.deepEqual(Uint8Array.from(got), Uint8Array.from(body));
});

test("put creates intermediate directories", async () => {
  const root = await tmpRoot();
  const s = new LocalArchiveStorage({ root });
  await s.put("deep/nested/path/x.txt", "hello");
  const got = await s.get("deep/nested/path/x.txt");
  assert.equal(got.toString("utf8"), "hello");
});

test("list yields entries under prefix with metadata", async () => {
  const root = await tmpRoot();
  const s = new LocalArchiveStorage({ root });
  await s.put("agent-runs/2026-05-23/a.json", "x");
  await s.put("agent-runs/2026-05-23/b.json", "yy");
  await s.put("agent-runs/2026-05-22/c.json", "zzz");
  await s.put("other/d.json", "q");

  const entries = [];
  for await (const e of s.list("agent-runs/2026-05-23/")) entries.push(e);
  const keys = entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ["agent-runs/2026-05-23/a.json", "agent-runs/2026-05-23/b.json"]);
  for (const e of entries) {
    assert.ok(e.size > 0);
    assert.ok(e.ts instanceof Date);
  }
});

test("list with prefix that has no matching directory yields nothing", async () => {
  const root = await tmpRoot();
  const s = new LocalArchiveStorage({ root });
  const entries = [];
  for await (const e of s.list("nope/")) entries.push(e);
  assert.equal(entries.length, 0);
});

test("rejects absolute and traversal keys", async () => {
  const root = await tmpRoot();
  const s = new LocalArchiveStorage({ root });
  await assert.rejects(s.put("/etc/passwd", "no"), /invalid archive key/);
  await assert.rejects(s.put("../escape", "no"), /invalid archive key/);
});

test("defaultLocalRoot honors AF_ARCHIVE_PATH", () => {
  assert.equal(defaultLocalRoot({ AF_ARCHIVE_PATH: "/custom/x" }), "/custom/x");
});

test("defaultLocalRoot falls back to ~/.agent-factory/archive", () => {
  const r = defaultLocalRoot({});
  assert.ok(r.endsWith(path.join(".agent-factory", "archive")));
});
