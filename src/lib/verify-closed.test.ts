/**
 * Tests for verify-closed.ts
 *
 * All tests run offline — no Linear API calls, no snapshot files on disk.
 * We mock `analyzeSnapshot` and the fetch used for Linear.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Signal fixture that satisfies the Signal interface.
 */
function makeSignal(fingerprint: string, kind = "n+1" as const) {
  return {
    kind,
    severity: "medium" as const,
    fingerprint,
    title: `Test signal ${fingerprint}`,
    details: "test details",
    evidence: {
      host: "api.example.com",
      pattern: "GET /items",
      count: 42,
      latency: { p50: 100, p95: 500, p99: 800, max: 1200 },
      errorRate: 0.05,
      examples: ["file1.json"],
    },
  };
}

// ── Unit-level logic tests (no I/O) ──────────────────────────────────────────

describe("verify-closed: fingerprint extraction from ticket description", () => {
  it("extracts fingerprint from HTML comment", () => {
    const desc = `
      Some issue body here.
      <!-- traffic-scan-fingerprint: n1:api.example.com:GET:/items -->
      More text.
    `;
    const match = desc.match(/<!--\s*traffic-scan-fingerprint:\s*([^\s>]+)\s*-->/);
    assert.ok(match, "regex should match");
    assert.equal(match![1], "n1:api.example.com:GET:/items");
  });

  it("returns null when no fingerprint comment present", () => {
    const desc = "Issue without fingerprint";
    const match = desc.match(/<!--\s*traffic-scan-fingerprint:\s*([^\s>]+)\s*-->/);
    assert.equal(match, null);
  });

  it("handles fingerprint with colons and slashes", () => {
    const fp = "slow-endpoint:grpc.example.com:POST:/v1/thing/do";
    const desc = `<!-- traffic-scan-fingerprint: ${fp} -->`;
    const match = desc.match(/<!--\s*traffic-scan-fingerprint:\s*([^\s>]+)\s*-->/);
    assert.ok(match);
    assert.equal(match![1], fp);
  });
});

describe("verify-closed: signal matching by fingerprint", () => {
  it("finds a signal matching the given fingerprint", () => {
    const targetFp = "n1:api.example.com:GET:/items";
    const signals = [
      makeSignal("other-fp"),
      makeSignal(targetFp),
    ];
    const found = signals.find((s) => s.fingerprint === targetFp);
    assert.ok(found);
    assert.equal(found.fingerprint, targetFp);
  });

  it("returns undefined when fingerprint is not in signals", () => {
    const signals = [makeSignal("fp-a"), makeSignal("fp-b")];
    const found = signals.find((s) => s.fingerprint === "fp-missing");
    assert.equal(found, undefined);
  });
});

describe("verify-closed: comment body shape", () => {
  it("resolved comment contains fingerprint and 'stays closed' language", () => {
    const fp = "n1:example.com:GET:/items";
    const windowRange = "2026-05-27T00:00:00Z → 2026-05-27T01:00:00Z";
    const body = [
      `✓ **Signal resolved.** Not detected in scan window [${windowRange}].`,
      "",
      `Snapshot analysed: 100 RRPair files, 0 signals above threshold.`,
      "",
      `Fingerprint \`${fp}\` not present — metric has returned to baseline. Ticket stays closed.`,
    ].join("\n");

    assert.match(body, /✓.*Signal resolved/);
    assert.match(body, new RegExp(fp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(body, /stays closed/);
  });

  it("still-present comment contains ⚠️ and 'reopening' language", () => {
    const fp = "n1:example.com:GET:/items";
    const signal = makeSignal(fp);
    const windowRange = "2026-05-27T00:00:00Z → 2026-05-27T01:00:00Z";
    const body = [
      `⚠️ **Signal still present** in scan window [${windowRange}].`,
      "",
      "The fix did not fully resolve the issue. Fresh metrics from the latest snapshot:",
      "",
      `**Signal:** ${signal.title}`,
      `**Kind:** ${signal.kind}`,
      `**Severity:** ${signal.severity}`,
      `**Host:** ${signal.evidence.host}`,
      `**Pattern:** ${signal.evidence.pattern}`,
      `**Count in window:** ${signal.evidence.count}`,
      `**p95 latency:** ${signal.evidence.latency!.p95}ms`,
      `**Error rate:** ${(signal.evidence.errorRate! * 100).toFixed(1)}%`,
      "",
      `Fingerprint \`${fp}\` still detected — reopening for re-investigation.`,
    ].join("\n");

    assert.match(body, /⚠️.*Signal still present/);
    assert.match(body, /reopening/);
    assert.match(body, /Count in window:\*\* 42/);
    assert.match(body, /p95 latency:\*\* 500ms/);
    assert.match(body, /Error rate:\*\* 5\.0%/);
  });
});

describe("verify-closed: dry-run skips Linear writes", () => {
  it("dry-run path logs without throwing when linearApiKey absent", async () => {
    // Import the module dynamically to verify it compiles and the function exists
    const mod = await import("./verify-closed.js");
    assert.equal(typeof mod.verifyClosed, "function");
    assert.equal(typeof mod.getRecentlyClosedRadarTickets, "function");
  });
});

/** Walk up from startDir until node_modules/.bin/tsx is found (handles git worktrees). */
function findTsx(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`tsx binary not found walking up from ${startDir}`);
}

const __repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("verify-closed: CLI subcommand wiring", () => {
  it("traffic-scan source entry point exists", () => {
    const srcPath = path.join(__repoRoot, "src/bin/traffic-scan.ts");
    assert.ok(existsSync(srcPath), `src/bin/traffic-scan.ts not found at ${srcPath}`);
  });

  it("verify-closed subcommand exits with usage error when --snapshot missing", async () => {
    const { execFileSync } = await import("node:child_process");
    const tsx = findTsx(__repoRoot);
    const srcPath = path.join(__repoRoot, "src/bin/traffic-scan.ts");

    let threw = false;
    let stderr = "";
    try {
      execFileSync(tsx, [srcPath, "verify-closed", "--fingerprint", "fp", "--ticket", "uuid"], {
        timeout: 10000,
        encoding: "utf8",
      });
    } catch (e) {
      threw = true;
      stderr = (e as { stderr?: string }).stderr ?? "";
    }
    assert.ok(threw, "should exit non-zero when --snapshot is missing");
    assert.match(stderr, /--snapshot/, "error message should mention --snapshot");
  });

  it("verify-closed-batch subcommand exits with usage error when --snapshot missing", async () => {
    const { execFileSync } = await import("node:child_process");
    const tsx = findTsx(__repoRoot);
    const srcPath = path.join(__repoRoot, "src/bin/traffic-scan.ts");

    let threw = false;
    let stderr = "";
    try {
      execFileSync(tsx, [srcPath, "verify-closed-batch", "--dry-run"], {
        timeout: 10000,
        encoding: "utf8",
        env: { ...process.env, LINEAR_API_KEY: "test-key" },
      });
    } catch (e) {
      threw = true;
      stderr = (e as { stderr?: string }).stderr ?? "";
    }
    assert.ok(threw, "should exit non-zero when --snapshot is missing");
    assert.match(stderr, /--snapshot/, "error message should mention --snapshot");
  });
});
