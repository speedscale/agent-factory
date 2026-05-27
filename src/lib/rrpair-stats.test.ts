import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { analyzeSnapshot, DEFAULT_THRESHOLDS } from "./rrpair-stats.js";

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeHttpJson(opts: {
  ts?: string;
  direction?: "IN" | "OUT";
  host?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
}): string {
  const ts = opts.ts ?? "2026-05-26T23:45:00Z";
  return JSON.stringify({
    msgType: "rrpair",
    resource: "radar",
    ts,
    l7protocol: "http",
    duration: opts.duration ?? 10,
    direction: opts.direction ?? "IN",
    tech: "JSON",
    status: String(opts.statusCode ?? 200),
    http: {
      request: {
        method: opts.method ?? "GET",
        url: `https://${opts.host ?? "radar.speedscale.com"}:3000${opts.path ?? "/api/test"}`,
      },
      response: { statusCode: opts.statusCode ?? 200 },
    },
  });
}

function makeSqlJson(opts: {
  ts?: string;
  host?: string;
  operation?: string;
  query?: string;
  duration?: number;
  status?: string;
}): string {
  const query = opts.query ?? "SELECT id FROM accounts WHERE id = $1";
  return JSON.stringify({
    msgType: "rrpair",
    resource: "radar",
    ts: opts.ts ?? "2026-05-26T23:45:00Z",
    l7protocol: "postgres",
    duration: opts.duration ?? 1,
    direction: "OUT",
    tech: "Postgres",
    command: opts.operation ?? "Prepare Statement",
    location: query,
    status: opts.status ?? "OK",
    mutableSignature: { "postgres:query": query },
  });
}

async function makeSnapshot(files: Array<{ name: string; content: string }>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "af-rrpair-test-"));
  for (const f of files) {
    const fullPath = path.join(dir, f.name);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, f.content, "utf8");
  }
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("empty snapshot returns zero signals", async () => {
  const dir = await makeSnapshot([]);
  const stats = await analyzeSnapshot(dir);
  assert.equal(stats.signals.length, 0);
  assert.equal(stats.parsedOk, 0);
});

test("N+1 detected when OUT call count exceeds threshold", async () => {
  const files = Array.from({ length: 25 }, (_, i) => ({
    name: `gmail.googleapis.com/${i.toString().padStart(5, "0")}.json`,
    content: makeHttpJson({
      direction: "OUT",
      host: "gmail.googleapis.com",
      method: "GET",
      // Realistic Gmail message IDs are long alphanumeric (≥16 chars)
      path: `/gmail/v1/users/me/messages/${(1000000000000000 + i).toString(16)}`,
      duration: 150,
    }),
  }));
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir);

  const n1 = stats.signals.find((s) => s.kind === "n+1");
  assert.ok(n1, "expected n+1 signal");
  assert.equal(n1.evidence.count, 25);
  assert.ok(n1.evidence.host.includes("gmail.googleapis.com"), `host should contain gmail.googleapis.com, got: ${n1.evidence.host}`);
});

test("N+1 NOT flagged when count is below threshold", async () => {
  const files = Array.from({ length: 5 }, (_, i) => ({
    name: `gmail.googleapis.com/${i}.json`,
    content: makeHttpJson({
      direction: "OUT",
      host: "gmail.googleapis.com",
      method: "GET",
      path: `/gmail/v1/users/me/messages/msg${i}`,
    }),
  }));
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir);
  assert.ok(!stats.signals.find((s) => s.kind === "n+1"), "should not flag N+1 for 5 calls");
});

test("slow-endpoint detected when p95 exceeds threshold", async () => {
  // 20 inbound requests with durations that put p95 over 1000ms
  const durations = [
    ...Array(18).fill(200),   // fast
    1500, 2000,               // two slow ones → p95 ≈ 1500
  ];
  const files = durations.map((dur, i) => ({
    name: `localhost/${i.toString().padStart(3, "0")}.json`,
    content: makeHttpJson({ direction: "IN", path: "/api/accounts", duration: dur }),
  }));
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir);

  const slow = stats.signals.find((s) => s.kind === "slow-endpoint");
  assert.ok(slow, "expected slow-endpoint signal");
  assert.ok(slow.evidence.latency!.p95 >= 1000, "p95 should be ≥ 1000ms");
});

test("high-frequency SQL query detected", async () => {
  const query = "SELECT contactEmail, MAX(date) FROM touches WHERE accountId = $1 GROUP BY contactEmail";
  const files = Array.from({ length: 150 }, (_, i) => ({
    name: `postgres/${i.toString().padStart(5, "0")}.json`,
    content: makeSqlJson({ query }),
  }));
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir);

  const hf = stats.signals.find((s) => s.kind === "high-freq-query");
  assert.ok(hf, "expected high-freq-query signal");
  assert.equal(hf.evidence.count, 150);
});

test("slow SQL query detected", async () => {
  const files = [
    { name: "postgres/001.json", content: makeSqlJson({ duration: 850, operation: "Prepare Statement" }) },
    { name: "postgres/002.json", content: makeSqlJson({ duration: 10, operation: "Prepare Statement" }) },
  ];
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir, { slowQueryMs: 300 });

  const slow = stats.signals.find((s) => s.kind === "slow-query");
  assert.ok(slow, "expected slow-query signal");
  assert.equal(slow.evidence.latency!.max, 850);
});

test("error signal detected on non-2xx responses", async () => {
  const files = [
    { name: "localhost/001.json", content: makeHttpJson({ direction: "IN", path: "/api/today/candidates", statusCode: 500, duration: 5000 }) },
    { name: "localhost/002.json", content: makeHttpJson({ direction: "IN", path: "/api/today/candidates", statusCode: 200, duration: 100 }) },
  ];
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir, { minErrorRate: 0.05, minErrorCount: 1 });

  const err = stats.signals.find((s) => s.kind === "errors");
  assert.ok(err, "expected errors signal");
  assert.ok(err.evidence.errorRate! > 0, "errorRate should be > 0");
});

test("signals sorted high severity first", async () => {
  // One high-count N+1 (high severity) + one slow endpoint (medium)
  const n1Files = Array.from({ length: 300 }, (_, i) => ({
    name: `ext/${i.toString().padStart(5, "0")}.json`,
    // Use numeric IDs which normalize to /{id}
    content: makeHttpJson({ direction: "OUT", host: "api.external.com", path: `/items/${10000 + i}`, duration: 200 }),
  }));
  const slowFiles = Array.from({ length: 5 }, (_, i) => ({
    name: `local/${i}.json`,
    content: makeHttpJson({ direction: "IN", path: "/api/pipeline", duration: i < 4 ? 100 : 2000 }),
  }));
  const dir = await makeSnapshot([...n1Files, ...slowFiles]);
  const stats = await analyzeSnapshot(dir);

  assert.ok(stats.signals.length >= 1);
  // First signal should be high severity (300-count N+1)
  assert.equal(stats.signals[0].severity, "high");
});

test("fingerprint is stable and differs between distinct signals", async () => {
  const files1 = Array.from({ length: 30 }, (_, i) => ({
    name: `a/${i}.json`,
    content: makeHttpJson({ direction: "OUT", host: "api.a.com", path: `/items/${i}` }),
  }));
  const files2 = Array.from({ length: 30 }, (_, i) => ({
    name: `b/${i}.json`,
    content: makeHttpJson({ direction: "OUT", host: "api.b.com", path: `/things/${i}` }),
  }));
  const dir = await makeSnapshot([...files1, ...files2]);
  const stats = await analyzeSnapshot(dir);

  const fps = stats.signals.filter((s) => s.kind === "n+1").map((s) => s.fingerprint);
  assert.equal(new Set(fps).size, fps.length, "fingerprints should be unique per distinct signal");
});

test("markdown (.md) rrpair files are parsed", async () => {
  const embeddedJson = makeHttpJson({ direction: "OUT", host: "api.test.com", path: "/v1/items/abc", duration: 200 });
  const mdContent = `### REQUEST ###
\`\`\`
GET https://api.test.com/v1/items/abc HTTP/1.1
\`\`\`

### RESPONSE ###
\`\`\`
HTTP/1.1 200 OK
\`\`\`

\`\`\`
json: ${embeddedJson}
\`\`\`
`;
  // Create 25 identical .md files so the N+1 threshold triggers
  const files = Array.from({ length: 25 }, (_, i) => ({
    name: `api.test.com/${String(i).padStart(3, "0")}.md`,
    content: mdContent,
  }));
  const dir = await makeSnapshot(files);
  const stats = await analyzeSnapshot(dir);

  assert.equal(stats.parsedOk, 25, "all .md files should parse");
  const n1 = stats.signals.find((s) => s.kind === "n+1");
  assert.ok(n1, "N+1 should be detected from .md files");
});

test("custom thresholds override defaults", async () => {
  // Only 10 OUT calls — below default 20 but above custom threshold of 5
  const files = Array.from({ length: 10 }, (_, i) => ({
    name: `svc/${i}.json`,
    content: makeHttpJson({ direction: "OUT", host: "api.narrow.com", path: `/x/${1000 + i}`, duration: 50 }),
  }));
  const dir = await makeSnapshot(files);

  const statsDefault = await analyzeSnapshot(dir);
  assert.ok(!statsDefault.signals.find((s) => s.kind === "n+1"), "should not flag at default threshold");

  const statsCustom = await analyzeSnapshot(dir, { n1MinCount: 5 });
  assert.ok(statsCustom.signals.find((s) => s.kind === "n+1"), "should flag at custom threshold");
});
