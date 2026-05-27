/**
 * traffic-scan — continuous traffic monitoring CLI for agent-factory.
 *
 * Subcommands:
 *   scan (default)   Pass 1 + Pass 2: analyze snapshot → file Linear tickets
 *   verify           Check whether a previously-filed signal is still present
 *   suppress         Add a fingerprint to the suppress list (not-a-bug)
 *
 * Scan usage:
 *   node dist/bin/traffic-scan.js \
 *     --snapshot <dir>          proxymock snapshot directory (required)
 *     [--repo    <dir>]         source repo for code-locus hints
 *     [--baseline-dir <dir>]    directory for rolling baseline files
 *     [--service <name>]        service name for baseline tracking (default: radar)
 *     [--min-severity high|medium|low]  default: medium
 *     [--max-tickets <n>]       cap tickets per run (default: 5)
 *     [--dedup-window <days>]   skip if filed in last N days (default: 7)
 *     [--create-tickets]        actually create Linear tickets (default: dry-run)
 *     [--no-correlate]          disable signal correlation
 *     [--output <file>]         write findings JSON to file
 *     [--provider anthropic|openrouter|ds4|omlx]
 *     [--model <id>]
 *     [--verbose]
 *
 * Verify usage:
 *   node dist/bin/traffic-scan.js verify \
 *     --snapshot <dir>          snapshot to check against
 *     --fingerprint <fp>        fingerprint from ticket description
 *     --ticket <linear-id>      Linear issue ID
 *     [--dry-run]               log only, don't touch Linear
 *
 * Suppress usage:
 *   node dist/bin/traffic-scan.js suppress \
 *     --fingerprint <fp>        fingerprint to suppress
 *     --baseline-dir <dir>      baseline directory
 *
 * Environment variables:
 *   LINEAR_API_KEY     required when --create-tickets or verify
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
import { interpretAndFile, verifySignalResolved, getRecentlyClosedSignalTickets } from "../lib/traffic-scanner.js";
import { correlateSignals } from "../lib/signal-correlator.js";
import { BaselineStore, buildWindowStats } from "../lib/baseline-store.js";
import { getInstanceConfig } from "../lib/instance-config.js";

// ── CLI arg helpers ───────────────────────────────────────────────────────────

function getArg(argv: string[], flags: string[]): string | undefined {
  const i = argv.findIndex((v) => flags.includes(v));
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], flags: string[]): boolean {
  return argv.some((v) => flags.includes(v));
}

// ── Subcommand: suppress ──────────────────────────────────────────────────────

async function runSuppress(argv: string[]): Promise<void> {
  const fp = getArg(argv, ["--fingerprint", "-f"]);
  const baselineDir = getArg(argv, ["--baseline-dir"]) ?? process.env.BASELINE_DIR;
  if (!fp) {
    console.error("error: suppress requires --fingerprint <fp>");
    process.exit(1);
  }
  if (!baselineDir) {
    console.error("error: suppress requires --baseline-dir <dir> or BASELINE_DIR env var");
    process.exit(1);
  }
  const store = new BaselineStore(baselineDir);
  await store.addSuppress(fp);
  console.log(`Suppressed fingerprint: ${fp}`);
}

// ── Subcommand: verify ────────────────────────────────────────────────────────

async function runVerify(argv: string[]): Promise<void> {
  const snapshotDir = getArg(argv, ["--snapshot", "-s"]);
  const fingerprint = getArg(argv, ["--fingerprint", "-f"]);
  const ticketId = getArg(argv, ["--ticket", "-t"]);
  const dryRun = hasFlag(argv, ["--dry-run"]);
  const verbose = hasFlag(argv, ["--verbose", "-v"]);
  const linearApiKey = process.env.LINEAR_API_KEY;

  if (!snapshotDir || !fingerprint || !ticketId) {
    console.error("error: verify requires --snapshot <dir> --fingerprint <fp> --ticket <id>");
    process.exit(1);
  }
  if (!dryRun && !linearApiKey) {
    console.error("error: verify requires LINEAR_API_KEY env var (or use --dry-run)");
    process.exit(1);
  }

  const stats = await analyzeSnapshot(path.resolve(snapshotDir));
  const result = await verifySignalResolved(
    fingerprint, ticketId,
    stats.signals, stats.windowStart, stats.windowEnd,
    { linearApiKey: linearApiKey ?? "", dryRun, verbose },
  );

  console.log(JSON.stringify({ phase: "verify", ...result }, null, 2));
}

// ── Subcommand: scan (default) ────────────────────────────────────────────────

async function runScan(argv: string[]): Promise<void> {
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
  const noCorrelate = hasFlag(argv, ["--no-correlate"]);
  const noLLM = hasFlag(argv, ["--no-llm"]);
  const serviceName = getArg(argv, ["--service"]) ?? "radar";
  const baselineDir = getArg(argv, ["--baseline-dir"]) ?? process.env.BASELINE_DIR;

  const minSeverityRaw = getArg(argv, ["--min-severity"]) ?? "medium";
  if (!["high", "medium", "low"].includes(minSeverityRaw)) {
    console.error(`error: --min-severity must be high, medium, or low (got: ${minSeverityRaw})`);
    process.exit(1);
  }
  const minSeverity = minSeverityRaw as Severity;
  const maxTickets = parseInt(getArg(argv, ["--max-tickets"]) ?? "5", 10);
  const dedupWindowDays = parseInt(getArg(argv, ["--dedup-window"]) ?? "7", 10);

  // Threshold overrides
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

  // Baseline store
  const baseline = baselineDir ? new BaselineStore(baselineDir) : undefined;
  if (baseline) {
    await baseline.load(serviceName);
  }

  const instanceCfg = getInstanceConfig();
  console.log(JSON.stringify({
    phase: "start",
    instance: instanceCfg.instance,
    snapshotDir: path.resolve(snapshotDir),
    repoDir: repoDir ? path.resolve(repoDir) : null,
    service: serviceName,
    baselineEnabled: !!baseline,
    noLLM,
    minSeverity,
    maxTickets,
    dedupWindowDays,
    createTickets,
    provider: noLLM ? null : provider,
    model: noLLM ? null : model,
  }));

  // ── Pass 1: programmatic analysis ──────────────────────────────────────────
  console.log("\n=== PASS 1: PROGRAMMATIC ANALYSIS ===");
  let stats;
  try {
    stats = await analyzeSnapshot(path.resolve(snapshotDir), thresholds, baseline);
  } catch (e) {
    console.error(`fatal: snapshot analysis failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Append stats to baseline store for future relative threshold detection
  if (baseline && stats.endpointStats.length > 0) {
    const httpStats = stats.endpointStats
      .filter((e) => !e.key.startsWith("sql:"))
      .map((e) => ({ key: e.key, p50: e.p50, p95: e.p95, p99: e.p99, count: e.count, errorRate: e.errorRate }));
    const sqlStats = stats.endpointStats
      .filter((e) => e.key.startsWith("sql:"))
      .map((e) => ({ key: e.key.slice(4), p50: e.p50, p95: e.p95, p99: e.p99, count: e.count }));
    const windowTs = stats.windowEnd || new Date().toISOString();
    const records = buildWindowStats(serviceName, windowTs, httpStats, sqlStats);
    await baseline.append(serviceName, records);
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
    console.log(JSON.stringify({ phase: "summary", created: 0, skipped: 0, dryRun: !createTickets }));
    return;
  }

  // ── Signal correlation ─────────────────────────────────────────────────────
  let signals = stats.signals;
  if (!noCorrelate) {
    const beforeCount = signals.length;
    signals = correlateSignals(signals);
    const afterCount = signals.length;
    if (afterCount < beforeCount) {
      console.log(`\nCorrelation: merged ${beforeCount - afterCount} signal(s) into incident(s) (${beforeCount} → ${afterCount})`);
    }
  }

  // Print signal list
  console.log("\nSignals:");
  for (const s of signals) {
    const blNote = s.evidence.baseline ? ` [2×baseline p95=${s.evidence.baseline.p95}ms]` : "";
    console.log(`  [${s.severity.toUpperCase()}] [${s.kind}] ${s.title}${blNote}`);
  }

  // ── Pass 2: LLM interpretation + ticket creation ───────────────────────────
  console.log("\n=== PASS 2: LLM INTERPRETATION ===");
  let scanResult;
  try {
    scanResult = await interpretAndFile(
      signals,
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
        baseline,
        noLLM,
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

  if (outputFile) {
    await writeFile(outputFile, JSON.stringify({ stats, signals, scanResult }, null, 2));
    console.log(`\nOutput written to ${outputFile}`);
  }

  console.log(JSON.stringify({
    phase: "summary",
    created: scanResult.ticketsCreated,
    skipped: scanResult.ticketsSkipped,
    dryRun: !createTickets,
  }));
}

// ── Verify loop helper (called by radar-traffic-monitor.sh) ──────────────────

/**
 * Run verification for all recently-closed tickets.
 * Called with subcommand "verify-closed".
 */
async function runVerifyClosed(argv: string[]): Promise<void> {
  const snapshotDir = getArg(argv, ["--snapshot", "-s"]);
  const dryRun = hasFlag(argv, ["--dry-run"]);
  const verbose = hasFlag(argv, ["--verbose", "-v"]);
  const withinDays = parseInt(getArg(argv, ["--within-days"]) ?? "2", 10);
  const linearApiKey = process.env.LINEAR_API_KEY;
  const labelNames = (getArg(argv, ["--labels"]) ?? "auto-fix,radar").split(",");

  if (!snapshotDir) {
    console.error("error: verify-closed requires --snapshot <dir>");
    process.exit(1);
  }
  if (!dryRun && !linearApiKey) {
    console.error("error: verify-closed requires LINEAR_API_KEY (or use --dry-run)");
    process.exit(1);
  }

  const stats = await analyzeSnapshot(path.resolve(snapshotDir));
  const closed = await getRecentlyClosedSignalTickets(linearApiKey ?? "", labelNames, withinDays);

  if (closed.length === 0) {
    console.log(JSON.stringify({ phase: "verify-closed", checked: 0, resolved: 0, reopened: 0 }));
    return;
  }

  let resolved = 0;
  let reopened = 0;

  for (const ticket of closed) {
    if (!ticket.fingerprint) continue;
    const result = await verifySignalResolved(
      ticket.fingerprint, ticket.id,
      stats.signals, stats.windowStart, stats.windowEnd,
      { linearApiKey: linearApiKey ?? "", dryRun, verbose },
    );
    if (result.resolved) resolved++;
    if (result.reopened) reopened++;
    console.log(JSON.stringify({ phase: "verify-closed-item", ...result }));
  }

  console.log(JSON.stringify({ phase: "verify-closed", checked: closed.length, resolved, reopened }));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  if (subcommand === "verify") {
    await runVerify(argv.slice(1));
  } else if (subcommand === "verify-closed") {
    await runVerifyClosed(argv.slice(1));
  } else if (subcommand === "suppress") {
    await runSuppress(argv.slice(1));
  } else {
    // Default: scan (subcommand may be absent or "--snapshot" etc.)
    await runScan(subcommand?.startsWith("-") ? argv : argv.slice(subcommand === "scan" ? 1 : 0));
  }
}

function countByKey<T>(arr: T[], key: keyof T & string): Record<string, number> {
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
