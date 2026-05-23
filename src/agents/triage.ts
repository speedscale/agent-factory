/**
 * triage — first real agent. Reads the ticket carried on the AgentRun,
 * asks Claude whether it's fit-for-dispatch, optionally posts the verdict
 * back as a Linear comment, writes a triage.json artifact, and returns
 * a summary the dispatcher writes to status.summary.
 *
 * Zero blast radius: no git, no MR, no patch. The agent's only side
 * effect outside the run dir is one Linear comment (when the run came
 * from Linear). Picked deliberately as the smallest non-stub agent
 * exercising every layer of the loop (poller → controller → dispatcher
 * → agent → external API → status patch).
 *
 * Inputs:
 *   - ctx.run.spec.issue.title / .body / .id / .url (always present —
 *     intake paths populate this)
 *   - ctx.run.spec.issue.linearIssueId (Linear-internal UUID — present
 *     only when sourced from the Linear poller; gates comment-posting)
 *   - input.taxonomy (optional override of the dispatch/needs-info pair;
 *     reserved for future extension, ignored today)
 *
 * Outputs:
 *   - triage.json artifact under ctx.runDir
 *   - AgentRunOutput.summary one-line verdict ("classified as dispatch — ...")
 *   - AgentRunOutput.artifacts.triage pointing at the artifact path
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDef, AgentInputSchema, AgentRunContext, AgentRunOutput } from "./types.js";
import { runTriage as defaultRunTriage, formatTriageReport, type TriageResult } from "../lib/triage.js";
import {
  createLinearClient as defaultCreateLinearClient,
  linearIssueIdFrom,
  type LinearClient,
  type LinearClientOptions,
} from "../lib/linear-client.js";

/**
 * Injected dependencies. Defaults to the real LLM + Linear API. Tests
 * pass fakes; the AgentDef.run() entry point always uses defaults.
 */
export interface TriageDeps {
  runTriage?: typeof defaultRunTriage;
  createLinearClient?: (opts: LinearClientOptions) => LinearClient;
  env?: NodeJS.ProcessEnv;
}

export interface TriageInput {
  /**
   * Reserved for future extension. The dispatch/needs-info pair is the
   * only taxonomy implemented today; passing anything else has no effect.
   */
  taxonomy?: string[];
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    taxonomy: {
      type: "array",
      items: { type: "string" },
      description: "Reserved for future taxonomies. Ignored today.",
    },
  },
  additionalProperties: false,
};

export class TriageBadResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageBadResponseError";
  }
}

/**
 * The agent's run implementation, factored out so tests can inject the
 * `runTriage` and `createLinearClient` deps without ES-module reassign
 * tricks. `triageAgent.run` is a thin wrapper that uses real deps.
 */
export async function runTriageAgent(
  _input: TriageInput,
  ctx: AgentRunContext,
  deps: TriageDeps = {},
): Promise<AgentRunOutput> {
  const runTriage = deps.runTriage ?? defaultRunTriage;
  const createLinearClient = deps.createLinearClient ?? defaultCreateLinearClient;
  const env = deps.env ?? process.env;

  const issue = ctx.run.spec.issue;
  if (!issue?.title) {
    // Validated at the dispatcher level too, but defensive against bare
    // CRDs that omit the issue block entirely.
    throw new TriageBadResponseError("AgentRun.spec.issue.title is required for triage");
  }

    ctx.logger.info("triage start", {
      issue_id: issue.id,
      title_length: issue.title.length,
      body_length: (issue.body ?? "").length,
    });

    let result: TriageResult;
    try {
      result = await runTriage({ title: issue.title, body: issue.body ?? "" });
    } catch (err) {
      // Parse failures or LLM errors surface as AgentError on the run
      // (dispatcher wraps the throw). Don't retry — the operator should
      // see the failure and either improve the ticket or re-trigger.
      throw new TriageBadResponseError(
        `triage classification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    ctx.logger.info("triage verdict", {
      verdict: result.verdict,
      missing_context_count: result.missingContext.length,
      recommended_actions_count: result.recommendedActions.length,
    });

    // Write artifact first — if the Linear post fails downstream, the
    // verdict is still preserved on disk for the operator.
    const artifactPath = path.join(ctx.runDir, "triage.json");
    await fs.writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          issue: { id: issue.id, title: issue.title, url: issue.url },
          verdict: result.verdict,
          reason: result.reason,
          missingContext: result.missingContext,
          recommendedActions: result.recommendedActions,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Comment-back is opt-in: only when the run originated from Linear AND
    // a LINEAR_API_KEY is mounted on the worker. Anything else, log and skip.
    const linearIssueUuid = linearIssueIdFrom(issue);
    let commentPosted = false;
    let commentError: string | undefined;
    if (linearIssueUuid) {
      const apiKey = env.LINEAR_API_KEY?.trim();
      if (!apiKey) {
        ctx.logger.warn("LINEAR_API_KEY not set; verdict will not be posted back", {
          issue_id: issue.id,
        });
      } else {
        try {
          const client = createLinearClient({ apiKey });
          const reportBody = formatTriageReport(result);
          const commented = await client.postComment(linearIssueUuid, reportBody);
          commentPosted = true;
          ctx.logger.info("posted triage verdict to Linear", {
            issue_id: issue.id,
            comment_id: commented.id,
          });
        } catch (err) {
          // Don't fail the run on a transient Linear API error — the
          // verdict is preserved in the artifact; operators can retry
          // the comment manually if it matters. Surface the error in
          // the run summary so it's not silently dropped.
          commentError = err instanceof Error ? err.message : String(err);
          ctx.logger.warn("Linear comment post failed (verdict still recorded)", {
            issue_id: issue.id,
            error: commentError,
          });
        }
      }
    }

    const verdictBlurb = `classified as ${result.verdict}${result.reason ? ` — ${result.reason}` : ""}`;
    const commentBlurb = linearIssueUuid
      ? commentPosted
        ? "; Linear comment posted"
        : commentError
          ? `; Linear comment failed: ${commentError}`
          : "; LINEAR_API_KEY not configured"
      : "";

    const output: AgentRunOutput = {
      summary: `${verdictBlurb}${commentBlurb}`,
      artifacts: {
        triage: path.relative(ctx.runDir, artifactPath),
      },
    };
    return output;
}

export const triageAgent: AgentDef<TriageInput> = {
  id: "triage",
  description:
    "Classify a ticket as dispatch (fit for the engine) or needs-info (human review). One LLM call, optionally posts the verdict as a Linear comment.",
  inputSchema,
  async run(input, ctx) {
    return runTriageAgent(input, ctx);
  },
};
