import { test } from "node:test";
import assert from "node:assert/strict";
import { GcsArchiveStorage } from "./gcs.js";

/**
 * Fakes the @google-cloud/storage shape just enough to validate
 * GcsArchiveStorage wires put/get/list against the bucket handle. No
 * network. The injected client is a plain object with `bucket(name)`
 * returning the same fake bucket each call.
 */
function fakeClient(initial: Map<string, Buffer> = new Map()) {
  const store = initial;

  const file = (name: string) => ({
    name,
    async save(body: Buffer | string) {
      store.set(name, typeof body === "string" ? Buffer.from(body, "utf8") : body);
    },
    async download(): Promise<[Buffer]> {
      const v = store.get(name);
      if (!v) throw new Error(`not found: ${name}`);
      return [v];
    },
  });

  const bucket = {
    file,
    async getFiles({ prefix }: { prefix: string }) {
      const out = [];
      for (const [name, v] of store.entries()) {
        if (name.startsWith(prefix)) {
          out.push({
            name,
            metadata: { size: String(v.length), updated: "2026-05-23T00:00:00.000Z" },
          });
        }
      }
      return [out];
    },
  };

  return {
    bucket: (_name: string) => bucket,
    _store: store,
  };
}

test("gcs put/get round-trips via fake client", async () => {
  const c = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = new GcsArchiveStorage({ bucket: "test-bucket", client: c as any });
  await s.put("agent-runs/2026-05-23/run-1.json", '{"x":1}');
  const got = await s.get("agent-runs/2026-05-23/run-1.json");
  assert.equal(got.toString("utf8"), '{"x":1}');
});

test("gcs list yields matching prefix only", async () => {
  const c = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = new GcsArchiveStorage({ bucket: "test-bucket", client: c as any });
  await s.put("agent-runs/2026-05-23/a.json", "x");
  await s.put("agent-runs/2026-05-23/b.json", "yy");
  await s.put("eval-runs/2026-05-23-abc/run.jsonl", "zzz");

  const entries = [];
  for await (const e of s.list("agent-runs/")) entries.push(e);
  const keys = entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ["agent-runs/2026-05-23/a.json", "agent-runs/2026-05-23/b.json"]);
  for (const e of entries) {
    assert.ok(e.size > 0);
    assert.ok(e.ts instanceof Date);
  }
});

test("gcs defaults bucket to ken-ai-agent-factory-archive", () => {
  const c = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = new GcsArchiveStorage({ client: c as any });
  assert.equal(s.bucketName, "ken-ai-agent-factory-archive");
});
