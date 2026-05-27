/**
 * traffic-scanner — LLM interpretation layer and Linear ticket creation.
 *
 * Pass 2 of the traffic-scan pipeline, executed after rrpair-stats.ts
 * produces a structured Signal list.
 *
 * What this module does:
 *   1. Takes the Signal list + optional repo path.
 *   2. Makes ONE LLM call with a compact stats summary (not raw RRPair files).
 *      The LLM localizes each signal to a specific file:function, produces a
 *      one-line Linear ticket title, and writes a short body with hypothesis +
 *      fix direction.
 *   3. Deduplicates against existing open Linear issues by fingerprint.
 *   4. Creates one Linear ticket per surviving signal.
 *
 * Noise controls:
 *   - minSeverity threshold: skip low-severity signals by default
 *   - maxTickets cap: never create more than N tickets per scan run
 *   - dedup: signals whose fingerprint matches an open ticket are skipped
 *   - LLM is told explicitly: one ticket per signal, no bundling, no speculation
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { callLLM, type LLMProvider } from "./llm-providers.js";
import { type Signal, type Severity } from "./rrpair-stats.js";

// ── Public API ────────────────────────────────────────────────────────────────

export interface ScannerOptions {
  provider: LLMProvider;
  model: string;
  /** Only process signals at or above this severity. Default: medium */
  minSeverity?: Severity;
  /** Maximum tickets to create per scan run. Default: 5 */
  maxTickets?: number;
  /** Skip signals whose fingerprint is found in open Linear tickets filed
   *  within this many days. Default: 7 */
  dedupWindowDays?: number;
  /** If false, interpret signals but do not create tickets. Default: true */
  createTickets?: boolean;
  /** Linear API key. Required when createTickets=true. */
  linearApiKey?: string;
  /** Linear team ID to file tickets against. Required when createTickets=true. */
  linearTeamId?: string;
  /**
   * Linear label IDs to apply.  auto-fix is required; performance/bug are
   * optional extras.  Pass empty array to skip labels.
   */
  linearLabelIds?: string[];
  verbose?: boolean;
}

export interface TicketHypothesis {
  signalFingerprint: string;
  title: string;
  /** Markdown body ready to paste into Linear */
  body: string;
  /** file:line or file:function hinted by the LLM */
  codeLocus?: string;
  severity: Severity;
  /** Assigned after ticket is filed */
  linearIssueId?: string;
  linearIssueUrl?: string;
  /** Why this signal was skipped (dedup, severity, cap) */
  skippedReason?: string;
}

export interface ScannerResult {
  signalsConsidered: number;
  hypotheses: TicketHypothesis[];
  ticketsCreated: number;
  ticketsSkipped: number;
}

// ── LLM prompt ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a performance and reliability analyst for a Node.js web application.

You receive a list of traffic signals detected by a programmatic analysis tool — each signal is a confirmed anomaly (N+1 call pattern, slow endpoint, high-frequency DB query, error rate spike) extracted from a production traffic snapshot.

Your job: for each signal, produce a precise Linear ticket — one ticket, one signal, no bundling.

Rules:
- Title: ≤80 chars, imperative ("Fix Gmail N+1 in listReceivedMessages"), includes the key metric
- Body: 3–5 sentences maximum. State the observed problem, name the most likely code location (file + function if you can infer it), and suggest the fix direction. Do NOT speculate beyond what the evidence supports.
- codeLocus: the most likely file:function or file:line to fix, or null if truly unknown
- Severity mapping: high → P1, medium → P2, low → P3

Do NOT bundle multiple signals into one ticket.
Do NOT create tickets for signals you cannot relate to a specific code pattern.
Do NOT add recommendations beyond what the traffic evidence shows.

Output: JSON array, one object per signal. Exact shape:
[
  {
    "signalFingerprint": "<fingerprint from input>",
    "title": "<≤80-char imperative title>",
    "body": "<3–5 sentence markdown body>",
    "codeLocus": "<file:function or null>"
  }
]`;

// ── Repo file tree helper ─────────────────────────────────────────────────────

/**
 * Return a compact src-tree listing of the repo, limited to source files.
 * Used as context for the LLM's code-locus inference.
 */
async function getRepoTree(repoDir: string, maxLines = 120): Promise<string> {
  const lines: string[] = [];
  async function walk(dir: string, depth = 0) {
    if (lines.length >= maxLines) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const SKIP = new Set(["node_modules", ".git", "dist", "coverage", "public-dist", ".claude", "proxymock"]);
    for (const e of entries) {
      if (lines.length >= maxLines) break;
      if (SKIP.has(e.name)) continue;
      if (e.name.startsWith(".")) continue;
      const indent = "  ".repeat(depth);
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        await walk(path.join(dir, e.name), depth + 1);
      } else if (/\.(ts|js|mjs|cjs|sql|prisma)$/.test(e.name)) {
        lines.push(`${indent}${e.name}`);
      }
    }
  }
  await walk(repoDir);
  return lines.join("\n");
}

// ── Linear helpers ────────────────────────────────────────────────────────────

const LINEAR_API = "https://api.linear.app/graphql";

async function linearRequest(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const payload = await res.json() as { data?: unknown; errors?: unknown };
  if (payload.errors) throw new Error(`Linear GraphQL errors: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

/**
 * Search for open Linear issues whose description contains the given
 * fingerprint string.  Returns true if a duplicate is found.
 */
async function isDuplicate(apiKey: string, fp: string, dedupDays: number): Promise<boolean> {
  const since = new Date(Date.now() - dedupDays * 86_400_000).toISOString();
  const query = `
    query($filter: IssueFilter!) {
      issues(filter: $filter, first: 1) {
        nodes { id title createdAt }
      }
    }`;
  const filter = {
    createdAt: { gte: since },
    description: { contains: fp },
    state: { type: { in: ["unstarted", "started"] } },
  };
  try {
    const data = await linearRequest(apiKey, query, { filter }) as {
      issues?: { nodes?: Array<{ id: string }> }
    };
    return (data?.issues?.nodes?.length ?? 0) > 0;
  } catch {
    // On error be conservative: assume not duplicate (better to over-file than silently drop)
    return false;
  }
}

/** Create a Linear issue. Returns { id, url }. */
async function createLinearIssue(
  apiKey: string,
  teamId: string,
  title: string,
  description: string,
  labelIds: string[],
  priority: number,
): Promise<{ id: string; url: string }> {
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id url }
      }
    }`;
  const input: Record<string, unknown> = { teamId, title, description, priority };
  if (labelIds.length > 0) input.labelIds = labelIds;

  const data = await linearRequest(apiKey, mutation, { input }) as {
    issueCreate?: { success?: boolean; issue?: { id: string; url: string } }
  };
  const issue = data?.issueCreate?.issue;
  if (!issue) throw new Error("Linear issueCreate returned no issue");
  return issue;
}

function severityToPriority(sev: Severity): number {
  return sev === "high" ? 1 : sev === "medium" ? 2 : 3;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Interpret a list of Signals with the LLM, dedup against Linear, and
 * optionally file tickets.
 *
 * @param signals    Output of analyzeSnapshot().signals
 * @param repoDir    Optional path to the source repo for tree context
 * @param snapshotDir Path to the snapshot, included in ticket bodies
 * @param opts       Provider, thresholds, Linear credentials
 */
export async function interpretAndFile(
  signals: Signal[],
  repoDir: string | undefined,
  snapshotDir: string,
  opts: ScannerOptions,
): Promise<ScannerResult> {
  const {
    provider,
    model,
    minSeverity = "medium",
    maxTickets = 5,
    dedupWindowDays = 7,
    createTickets = true,
    linearApiKey,
    linearTeamId,
    linearLabelIds = [],
    verbose = false,
  } = opts;

  const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  const minRank = SEVERITY_RANK[minSeverity];

  // Filter by severity
  const eligible = signals.filter((s) => SEVERITY_RANK[s.severity] <= minRank);

  if (eligible.length === 0) {
    return { signalsConsidered: signals.length, hypotheses: [], ticketsCreated: 0, ticketsSkipped: 0 };
  }

  // ── Build compact stats summary for LLM ──────────────────────────────────
  const signalSummaries = eligible.map((s) => ({
    fingerprint: s.fingerprint,
    kind: s.kind,
    severity: s.severity,
    title: s.title,
    details: s.details,
    evidence: {
      host: s.evidence.host,
      pattern: s.evidence.pattern,
      count: s.evidence.count,
      ...(s.evidence.latency ? { latency: s.evidence.latency } : {}),
      ...(s.evidence.errorRate !== undefined ? { errorRate: s.evidence.errorRate } : {}),
    },
  }));

  // Optionally include repo file tree for code-locus inference
  let repoContext = "";
  if (repoDir) {
    try {
      const tree = await getRepoTree(repoDir);
      repoContext = `\n\nRepository source tree (for code-locus inference):\n${tree}`;
    } catch {
      /* non-fatal */
    }
  }

  // Also try to include a few relevant source file snippets if repo is present
  let sourceSnippets = "";
  if (repoDir) {
    sourceSnippets = await gatherSourceSnippets(repoDir, eligible);
  }

  const userContent =
    `Analyze these ${eligible.length} traffic signals and produce one Linear ticket per signal.\n\n` +
    `Snapshot window: ${snapshotDir}\n\n` +
    `Signals:\n${JSON.stringify(signalSummaries, null, 2)}` +
    repoContext +
    (sourceSnippets ? `\n\nRelevant source excerpts:\n${sourceSnippets}` : "");

  if (verbose) {
    console.error(`[traffic-scanner] calling LLM with ${eligible.length} signals, model=${model}`);
  }

  const turn = await callLLM({
    provider,
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    maxTokens: 4096,
    tools: [],
  });

  // Parse LLM output
  const rawText = turn.textBlocks.map((b) => b.text).join("");
  interface LLMHypothesis {
    signalFingerprint: string;
    title: string;
    body: string;
    codeLocus?: string | null;
  }
  let hypotheses: LLMHypothesis[];
  try {
    hypotheses = parseJsonArray(rawText) as unknown as LLMHypothesis[];
  } catch (e) {
    throw new Error(`LLM returned unparseable JSON: ${(e as Error).message}\nRaw: ${rawText.slice(0, 500)}`);
  }

  // Map back to full Signal data
  const fpToSignal = new Map(eligible.map((s) => [s.fingerprint, s]));
  const results: TicketHypothesis[] = [];
  let ticketsCreated = 0;
  let ticketsSkipped = 0;

  for (const h of hypotheses) {
    const signal = fpToSignal.get(h.signalFingerprint);
    if (!signal) continue;

    const hypo: TicketHypothesis = {
      signalFingerprint: h.signalFingerprint,
      title: h.title.slice(0, 80),
      body: buildTicketBody(h.body, signal, snapshotDir, h.codeLocus),
      codeLocus: h.codeLocus ?? undefined,
      severity: signal.severity,
    };

    // Check caps
    if (ticketsCreated >= maxTickets) {
      hypo.skippedReason = `maxTickets cap (${maxTickets}) reached`;
      ticketsSkipped++;
      results.push(hypo);
      continue;
    }

    // Dedup
    if (createTickets && linearApiKey) {
      const dup = await isDuplicate(linearApiKey, h.signalFingerprint, dedupWindowDays);
      if (dup) {
        hypo.skippedReason = `duplicate found in Linear (last ${dedupWindowDays}d)`;
        ticketsSkipped++;
        results.push(hypo);
        continue;
      }
    }

    // File ticket
    if (createTickets && linearApiKey && linearTeamId) {
      try {
        const issue = await createLinearIssue(
          linearApiKey,
          linearTeamId,
          hypo.title,
          hypo.body,
          linearLabelIds,
          severityToPriority(signal.severity),
        );
        hypo.linearIssueId = issue.id;
        hypo.linearIssueUrl = issue.url;
        ticketsCreated++;
        if (verbose) console.error(`[traffic-scanner] created ${issue.url}`);
      } catch (e) {
        hypo.skippedReason = `Linear create failed: ${(e as Error).message}`;
        ticketsSkipped++;
      }
    } else {
      // dry-run
      ticketsCreated++;
    }

    results.push(hypo);
  }

  return {
    signalsConsidered: signals.length,
    hypotheses: results,
    ticketsCreated,
    ticketsSkipped,
  };
}

// ── Source snippet helper ─────────────────────────────────────────────────────

/**
 * Heuristic: for each signal, try to find and excerpt the most relevant
 * source files.  Looks for filenames that match keywords in the signal pattern.
 * Returns at most ~3000 chars total so the LLM prompt stays bounded.
 */
async function gatherSourceSnippets(repoDir: string, signals: Signal[]): Promise<string> {
  const keywords = new Set<string>();
  for (const s of signals) {
    // Extract keywords from patterns: e.g. "gmail" from "gmail.googleapis.com"
    const words = (s.evidence.host + " " + s.evidence.pattern)
      .split(/[^a-zA-Z]+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.toLowerCase());
    words.forEach((w) => keywords.add(w));
  }

  const srcDir = path.join(repoDir, "src");
  const candidates: string[] = [];
  try {
    await collectMatchingFiles(srcDir, keywords, candidates, 8);
  } catch {
    /* non-fatal */
  }

  const snippets: string[] = [];
  let totalChars = 0;
  for (const f of candidates) {
    if (totalChars >= 3000) break;
    try {
      const content = await readFile(f, "utf8");
      const excerpt = content.slice(0, 800);
      snippets.push(`// ${path.relative(repoDir, f)}\n${excerpt}`);
      totalChars += excerpt.length;
    } catch {
      /* skip */
    }
  }
  return snippets.join("\n\n---\n\n");
}

async function collectMatchingFiles(
  dir: string,
  keywords: Set<string>,
  out: string[],
  limit: number,
) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
  for (const e of entries) {
    if (out.length >= limit) break;
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await collectMatchingFiles(full, keywords, out, limit);
    } else if (/\.(ts|js|mjs)$/.test(e.name)) {
      const nameLower = e.name.toLowerCase();
      const matches = [...keywords].some((kw) => nameLower.includes(kw));
      if (matches) out.push(full);
    }
  }
}

// ── Ticket body builder ───────────────────────────────────────────────────────

function buildTicketBody(
  llmBody: string,
  signal: Signal,
  snapshotDir: string,
  codeLocus?: string | null,
): string {
  const lines: string[] = [
    llmBody,
    "",
    "---",
    `**Signal:** \`${signal.kind}\` | **Severity:** ${signal.severity} | **Count:** ${signal.evidence.count}`,
  ];
  if (signal.evidence.latency) {
    const { p50, p95, p99 } = signal.evidence.latency;
    lines.push(`**Latency:** p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
  }
  if (codeLocus) lines.push(`**Code locus:** \`${codeLocus}\``);
  lines.push(`**Snapshot:** \`${snapshotDir}\``);
  // Embed fingerprint for dedup on future scans
  lines.push(`<!-- traffic-scan-fingerprint: ${signal.fingerprint} -->`);
  return lines.join("\n");
}

// ── JSON parse helper ─────────────────────────────────────────────────────────

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  let text = raw.trim();
  // Strip ```json fences
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1].trim();
  // Find first [ ... ]
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("no JSON array found");
  return JSON.parse(text.slice(start, end + 1)) as Array<Record<string, unknown>>;
}
