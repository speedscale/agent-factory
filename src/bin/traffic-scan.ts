/**
 * traffic-scan — continuous traffic monitoring CLI for agent-factory.
 *
 * Pass 1: programmatic RRPair analysis (rrpair-stats.ts)
 * Pass 2: LLM signal interpretation + Linear ticket creation (traffic-scanner.ts)
 *
 * Usage:
 *   node dist/bin/traffic-scan.js \
 *     --snapshot <dir>          proxymock snapshot directory (required)
 *     [--repo    <dir>]         source repo for code-locus hints
 *     [--service <name>]        filter signals to one service (default: all)
 *     [--min-severity high|medium|low]  default: medium
 *     [--max-tickets <n>]       cap tickets per run (default: 5)
 *     [--dedup-window <days>]   skip if filed in last N days (default: 7)
 *     [--create-tickets]        actually create Linear tickets (default: dry-run)
 *     [--output <file>]         write findings JSON to file
 *     [--provider anthropic|openrouter|ds4|omlx]
 *     [--model <id>]
 *     [--verbose]
 *
 * Environment variables:
 *   LINEAR_API_KEY     required when --create-tickets
 *   LINEAR_TEAM_ID     required when --create-tickets
 *   LINEAR_LABEL_IDS   comma-separated label IDs to apply (optional)
 *   AF_ENGINE_KIND     LLM provider (overridden by --provider)
 *   AF_ENGINE_MODEL    LLM model   (overridden by --model)
 *
 * Exit codes:
 *   0   success (findings may be empty)
 *   1   fatal error (snapshot unreadable, LLM failure, etc.)
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveEngineConfig } from "../lib/engine-config.js";
import { defaultModelFor, type LLMProvider } from "../lib/llm-providers.js";
import { analyzeSnapshot, type ScanThresholds, type Severity } from "../lib/rrpair-stats.js";
import { interpretAndFile } from "../lib/traffic-scanner.js";
import { getInstanceConfig } from "../lib/instance-config.js";

// ── CLI arg helpers ───────────────────────────────────────────────────────────

function getArg(argv: string[], flags: string[]): string | undefined {
  const i = argv.findIndex((v) => flags.includes(v));
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], flags: string[]): boolean {
  return argv.some((v) => flags.includes(v));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const snapshotDir = getArg(argv, ["--snapshot", "-s"]);
  if (!snapshotDir) {
    console.error("error: --snapshot <dir> is required");
    console.error("usage: traffic-scan --snapshot <dir> [--repo <dir>] [--create-tickets] [--min-severity medium] [--max-tickets 5]");
    process.exit(1);
  }

  const repoDir = getArg(argv, ["--repo", "-r"]);
  const outputFile = getArg(argv, ["--output", "-o"]);
  const verbose = hasFlag(argv, ["--verbose", "-v"]);
  const createTickets = hasFlag(argv, ["--create-tickets"]);

  const minSeverityRaw = getArg(argv, ["--min-severity"]) ?? "medium";
  if (!["high", "medium", "low"].includes(minSeverityRaw)) {
    console.error(`error: --min-severity must be high, medium, or low (got: ${minSeverityRaw})`);
    process.exit(1);
  }
  const minSeverity = minSeverityRaw as Severity;
  const maxTickets = parseInt(getArg(argv, ["--max-tickets"]) ?? "5", 10);
  const dedupWindowDays = parseInt(getArg(argv, ["--dedup-window"]) ?? "7", 10);

  // Threshold overrides (optional, for power users)
  const thresholds: Partial<ScanThresholds> = {};
  const n1Min = getArg(argv, ["--n1-min-count"]);
  if (n1Min) thresholds.n1MinCount = parseInt(n1Min, 10);
  const slowP95 = getArg(argv, ["--slow-endpoint-p95-ms"]);
  if (slowP95) thresholds.slowEndpointP95Ms = parseInt(slowP95, 10);
  const slowSql = getArg(argv, ["--slow-query-ms"]);
  if (slowSql) thresholds.slowQueryMs = parseInt(slowSql, 10);
  const hiFreq = getArg(argv, ["--high-freq-min-count"]);
  if (hiFreq) thresholds.highFreqSqlMinCount = parseInt(hiFreq, 10);

  // Engine config
  const envCfg = resolveEngineConfig(process.env);
  const providerFlag = getArg(argv, ["--provider", "-p"]);
  const modelFlag = getArg(argv, ["--model", "-m"]);
  let provider: LLMProvider;
  if (providerFlag && ["anthropic", "openrouter", "ds4", "omlx"].includes(providerFlag)) {
    provider = providerFlag as LLMProvider;
  } else {
    provider = envCfg.provider;
  }
  const model: string = modelFlag ?? (providerFlag ? defaultModelFor(provider) : envCfg.model);

  // Linear config
  const linearApiKey = process.env.LINEAR_API_KEY;
  const linearTeamId = process.env.LINEAR_TEAM_ID;
  const linearLabelIds = (process.env.LINEAR_LABEL_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (createTickets && (!linearApiKey || !linearTeamId)) {
    console.error("error: --create-tickets requires LINEAR_API_KEY and LINEAR_TEAM_ID env vars");
    process.exit(1);
  }

  const instanceCfg = getInstanceConfig();
  console.log(JSON.stringify({
    phase: "start",
    instance: instanceCfg.instance,
    snapshotDir: path.resolve(snapshotDir),
    repoDir: repoDir ? path.resolve(repoDir) : null,
    minSeverity,
    maxTickets,
    dedupWindowDays,
    createTickets,
    provider,
    model,
  }));

  // ── Pass 1: programmatic analysis ──────────────────────────────────────────
  console.log("\n=== PASS 1: PROGRAMMATIC ANALYSIS ===");
  let stats;
  try {
    stats = await analyzeSnapshot(path.resolve(snapshotDir), thresholds);
  } catch (e) {
    console.error(`fatal: snapshot analysis failed: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    phase: "analyzed",
    totalFiles: stats.totalFiles,
    parsedOk: stats.parsedOk,
    windowStart: stats.windowStart,
    windowEnd: stats.windowEnd,
    signalsFound: stats.signals.length,
    signalsByKind: countByKey(stats.signals, "kind"),
    signalsBySeverity: countByKey(stats.signals, "severity"),
  }, null, 2));

  if (stats.signals.length === 0) {
    console.log("\nNo signals above thresholds. Done.");
    if (outputFile) {
      await writeFile(outputFile, JSON.stringify({ stats, hypotheses: [] }, null, 2));
    }
    return;
  }

  // Print signal list
  console.log("\nSignals:");
  for (const s of stats.signals) {
    console.log(`  [${s.severity.toUpperCase()}] [${s.kind}] ${s.title}`);
  }

  // ── Pass 2: LLM interpretation + ticket creation ───────────────────────────
  console.log("\n=== PASS 2: LLM INTERPRETATION ===");
  let scanResult;
  try {
    scanResult = await interpretAndFile(
      stats.signals,
      repoDir ? path.resolve(repoDir) : undefined,
      path.resolve(snapshotDir),
      {
        provider,
        model,
        minSeverity,
        maxTickets,
        dedupWindowDays,
        createTickets,
        linearApiKey,
        linearTeamId,
        linearLabelIds,
        verbose,
      },
    );
  } catch (e) {
    console.error(`fatal: LLM interpretation failed: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    phase: "complete",
    signalsConsidered: scanResult.signalsConsidered,
    hypothesesProduced: scanResult.hypotheses.length,
    ticketsCreated: scanResult.ticketsCreated,
    ticketsSkipped: scanResult.ticketsSkipped,
  }, null, 2));

  // Print per-hypothesis summary
  console.log("\nResults:");
  for (const h of scanResult.hypotheses) {
    const status = h.linearIssueUrl
      ? `✓ ${h.linearIssueUrl}`
      : h.skippedReason
        ? `⊘ skipped (${h.skippedReason})`
        : "○ dry-run";
    console.log(`  [${h.severity.toUpperCase()}] ${h.title}`);
    console.log(`         ${status}`);
    if (verbose && h.body) {
      console.log(`         locus: ${h.codeLocus ?? "(unknown)"}`);
    }
  }

  // Write output file if requested
  if (outputFile) {
    await writeFile(
      outputFile,
      JSON.stringify({ stats, scanResult }, null, 2),
    );
    console.log(`\nOutput written to ${outputFile}`);
  }

  // Final summary line — machine-parseable for the cron wrapper
  console.log(JSON.stringify({
    phase: "summary",
    created: scanResult.ticketsCreated,
    skipped: scanResult.ticketsSkipped,
    dryRun: !createTickets,
  }));
}

function countByKey<T>(
  arr: T[],
  key: keyof T & string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const v = String((item as Record<string, unknown>)[key]);
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

main().catch((e: unknown) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
