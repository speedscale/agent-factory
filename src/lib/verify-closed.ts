/**
 * verify-closed — post-fix verification loop for the radar monitor.
 *
 * After a ticket is closed (agent-factory merged a fix), the next cron window
 * should confirm the signal is gone from traffic. This module:
 *
 *   1. Runs Pass 1 programmatic analysis on a fresh snapshot.
 *   2. Checks if any signal matches the given fingerprint.
 *   3. If NOT found → posts a "✓ verified resolved" comment on the Linear
 *      ticket and leaves it closed.
 *   4. If STILL FOUND → posts fresh metrics and reopens the ticket (sets state
 *      back to "Todo" so it re-enters the agent-factory queue).
 *
 * Usage (via traffic-scan.ts subcommand):
 *
 *   node dist/bin/traffic-scan.js verify-closed \
 *     --snapshot <dir>           fresh proxymock snapshot
 *     --fingerprint <fp>         fingerprint embedded in the ticket description
 *     --ticket <linear-issue-id> Linear internal UUID (not the S-XXXXX identifier)
 *     [--dry-run]                log what would happen, no Linear writes
 *     [--no-llm]                 skip LLM context (metrics only)
 *
 * The fingerprint is embedded in every ticket created by traffic-scan as:
 *   <!-- traffic-scan-fingerprint: <fp> -->
 */

import { analyzeSnapshot } from "./rrpair-stats.js";
import type { Signal } from "./rrpair-stats.js";

const LINEAR_API = "https://api.linear.app/graphql";

// ── Linear helpers ────────────────────────────────────────────────────────────

async function linearRequest(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const payload = (await res.json()) as { data?: unknown; errors?: unknown };
  if (payload.errors)
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

/**
 * Fetch a Linear issue's current state.
 * Returns { id, title, stateId, stateType } so the caller can decide whether
 * to reopen, and { teamId } so the caller can find the Todo state for that team.
 */
async function getIssue(apiKey: string, issueId: string): Promise<{
  id: string;
  title: string;
  identifier: string;
  stateId: string;
  stateType: string;
  teamId: string;
}> {
  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id title identifier
        state { id type }
        team  { id }
      }
    }`;
  const data = (await linearRequest(apiKey, query, { id: issueId })) as {
    issue?: {
      id: string;
      title: string;
      identifier: string;
      state: { id: string; type: string };
      team: { id: string };
    };
  };
  const issue = data?.issue;
  if (!issue) throw new Error(`Linear issue ${issueId} not found`);
  return {
    id: issue.id,
    title: issue.title,
    identifier: issue.identifier,
    stateId: issue.state.id,
    stateType: issue.state.type,
    teamId: issue.team.id,
  };
}

/**
 * Find the first "unstarted" (Todo) state for a given Linear team.
 * When reopening, we move the issue to this state.
 */
async function findTodoStateId(apiKey: string, teamId: string): Promise<string> {
  const query = `
    query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }`;
  const data = (await linearRequest(apiKey, query, { teamId })) as {
    team?: { states?: { nodes?: Array<{ id: string; name: string; type: string }> } };
  };
  const states = data?.team?.states?.nodes ?? [];
  const todo = states.find((s) => s.type === "unstarted");
  if (!todo) throw new Error(`No unstarted state found for team ${teamId}`);
  return todo.id;
}

/** Post a comment on a Linear issue. */
async function postComment(apiKey: string, issueId: string, body: string): Promise<void> {
  const mutation = `
    mutation PostComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`;
  await linearRequest(apiKey, mutation, { input: { issueId, body } });
}

/** Move a Linear issue to a given state (reopen). */
async function updateIssueState(
  apiKey: string,
  issueId: string,
  stateId: string,
): Promise<void> {
  const mutation = `
    mutation ReopenIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`;
  await linearRequest(apiKey, mutation, { id: issueId, input: { stateId } });
}

// ── Signal formatting ─────────────────────────────────────────────────────────

function formatSignalMetrics(signal: Signal): string {
  const lines: string[] = [];
  lines.push(`**Signal:** ${signal.title}`);
  lines.push(`**Kind:** ${signal.kind}`);
  lines.push(`**Severity:** ${signal.severity}`);
  lines.push(`**Host:** ${signal.evidence.host}`);
  lines.push(`**Pattern:** ${signal.evidence.pattern}`);
  lines.push(`**Count in window:** ${signal.evidence.count}`);
  if (signal.evidence.latency?.p95 !== undefined)
    lines.push(`**p95 latency:** ${signal.evidence.latency.p95}ms`);
  if (signal.evidence.errorRate !== undefined)
    lines.push(`**Error rate:** ${(signal.evidence.errorRate * 100).toFixed(1)}%`);
  return lines.join("\n");
}

// ── Main exported function ────────────────────────────────────────────────────

export interface VerifyClosedOptions {
  /** Path to the fresh proxymock snapshot directory. */
  snapshotDir: string;
  /** Fingerprint string embedded in the ticket description. */
  fingerprint: string;
  /** Linear internal UUID of the closed ticket. */
  ticketId: string;
  /** If true, log what would happen but make no Linear writes. */
  dryRun?: boolean;
  /** Linear API key. Required unless dryRun. */
  linearApiKey?: string;
}

export interface VerifyClosedResult {
  /** Whether the signal is still present in the new snapshot. */
  signalStillPresent: boolean;
  /** The matching signal, if found. */
  matchingSignal?: Signal;
  /** The comment body that was (or would be) posted. */
  commentBody: string;
  /** Whether the ticket was (or would be) reopened. */
  reopened: boolean;
}

export async function verifyClosed(opts: VerifyClosedOptions): Promise<VerifyClosedResult> {
  const { snapshotDir, fingerprint, ticketId, dryRun = false, linearApiKey } = opts;

  if (!dryRun && !linearApiKey) {
    throw new Error("verifyClosed: linearApiKey is required unless dryRun=true");
  }

  // ── Pass 1: analyze fresh snapshot ─────────────────────────────────────────
  console.log(JSON.stringify({ phase: "verify-scan-start", snapshotDir, fingerprint, ticketId }));
  const stats = await analyzeSnapshot(snapshotDir);
  console.log(
    JSON.stringify({
      phase: "verify-scan-complete",
      totalFiles: stats.totalFiles,
      signalsFound: stats.signals.length,
      windowStart: stats.windowStart,
      windowEnd: stats.windowEnd,
    }),
  );

  // ── Check if fingerprint still appears ─────────────────────────────────────
  const matchingSignal = stats.signals.find((s) => s.fingerprint === fingerprint);
  const signalStillPresent = matchingSignal !== undefined;

  let commentBody: string;
  let reopened = false;

  if (!signalStillPresent) {
    // ── Happy path: signal is gone ──────────────────────────────────────────
    const windowRange = `${stats.windowStart ?? "?"} → ${stats.windowEnd ?? "?"}`;
    commentBody = [
      `✓ **Signal resolved.** Not detected in scan window [${windowRange}].`,
      "",
      `Snapshot analysed: ${stats.totalFiles} RRPair files, ${stats.signals.length} signals above threshold.`,
      "",
      `Fingerprint \`${fingerprint}\` not present — metric has returned to baseline. Ticket stays closed.`,
    ].join("\n");

    console.log(JSON.stringify({ phase: "verify-result", outcome: "resolved", fingerprint }));

    if (!dryRun && linearApiKey) {
      await postComment(linearApiKey, ticketId, commentBody);
    } else {
      console.log("[dry-run] would post resolved comment:", commentBody);
    }
  } else {
    // ── Signal still present: update + reopen ───────────────────────────────
    const windowRange = `${stats.windowStart ?? "?"} → ${stats.windowEnd ?? "?"}`;
    commentBody = [
      `⚠️ **Signal still present** in scan window [${windowRange}].`,
      "",
      "The fix did not fully resolve the issue. Fresh metrics from the latest snapshot:",
      "",
      formatSignalMetrics(matchingSignal),
      "",
      `Fingerprint \`${fingerprint}\` still detected — reopening for re-investigation.`,
    ].join("\n");

    console.log(
      JSON.stringify({
        phase: "verify-result",
        outcome: "still-present",
        fingerprint,
        signalTitle: matchingSignal.title,
      }),
    );

    reopened = true;
    if (!dryRun && linearApiKey) {
      // Get the issue to find the team, then find a Todo state to move it to
      const issue = await getIssue(linearApiKey, ticketId);
      const todoStateId = await findTodoStateId(linearApiKey, issue.teamId);
      await postComment(linearApiKey, ticketId, commentBody);
      await updateIssueState(linearApiKey, ticketId, todoStateId);
    } else {
      console.log("[dry-run] would post still-present comment and reopen:", commentBody);
    }
  }

  return { signalStillPresent, matchingSignal, commentBody, reopened };
}

// ── Batch verification: query recently-closed radar tickets ──────────────────

export interface RecentlyClosedTicket {
  id: string;
  identifier: string;
  title: string;
  fingerprint: string | null;
  updatedAt: string;
}

/**
 * Query Linear for tickets that:
 *  - Have state.type = "completed"
 *  - Were updated in the last `withinDays` days
 *  - Have any of the given label IDs
 *
 * Returns only tickets whose description embeds a traffic-scan fingerprint.
 */
export async function getRecentlyClosedRadarTickets(
  apiKey: string,
  labelIds: string[],
  withinDays = 2,
): Promise<RecentlyClosedTicket[]> {
  const since = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const query = `
    query RecentlyClosed($filter: IssueFilter!, $first: Int!) {
      issues(filter: $filter, first: $first) {
        nodes {
          id identifier title description updatedAt
        }
      }
    }`;
  const filter: Record<string, unknown> = {
    state: { type: { eq: "completed" } },
    updatedAt: { gte: since },
  };
  if (labelIds.length > 0) {
    filter.labels = { id: { in: labelIds } };
  }
  const data = (await linearRequest(apiKey, query, { filter, first: 50 })) as {
    issues?: { nodes?: Array<{ id: string; identifier: string; title: string; description?: string; updatedAt: string }> };
  };

  const nodes = data?.issues?.nodes ?? [];
  return nodes.map((n) => {
    const match = n.description?.match(/<!--\s*traffic-scan-fingerprint:\s*([^\s>]+)\s*-->/);
    return {
      id: n.id,
      identifier: n.identifier,
      title: n.title,
      fingerprint: match?.[1] ?? null,
      updatedAt: n.updatedAt,
    };
  }).filter((t) => t.fingerprint !== null) as RecentlyClosedTicket[];
}
