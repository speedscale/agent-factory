/**
 * Agent-run recorder.
 *
 * Writes one JSON blob per AgentRun completion to the archive substrate,
 * under the key:
 *
 *   agent-runs/<YYYY-MM-DD>/<run-id>.json
 *
 * The blob is the full trace we wish we'd had for the first 5 historical
 * `triage-s-*` runs — ticket text, prompts, raw model response, parsed
 * verdict, posted comment, phase transitions, and timings.
 *
 * Today the only agent that wires this in is `triage` (its `TriageResult`
 * carries `rawResponse`). Other agents may pass null `rawResponse`/`parsed`
 * until they're plumbed through; the recorder still captures everything
 * else (ticket, transitions, timings) so we never silently lose history.
 *
 * Design choice: the recorder is intentionally tolerant of missing
 * fields. Calling it must never fail the run. All errors are swallowed
 * and logged — the archive is observability, not the system of record.
 */

import { createHash } from "node:crypto";
import type { AgentRun } from "../contracts/index.js";
import { createLogger, type Logger } from "./logger.js";
import { getArchiveStorage, type ArchiveStorage } from "./archive/index.js";

export interface AgentRunTransition {
  phase: string;
  ts: string;
}

export interface AgentRunRecordEnginePrompt {
  system?: string;
  user?: string;
  /** sha256 of `system + "\n" + user`. Lets us bucket by prompt revision. */
  promptSha?: string;
}

export interface AgentRunRecord {
  runId: string;
  agent: string;
  app?: string;
  ticket: {
    id?: string;
    title?: string;
    body?: string;
    labels?: string[];
    url?: string;
  };
  engine?: {
    provider?: string;
    model?: string;
    endpoint?: string;
  };
  prompts?: AgentRunRecordEnginePrompt;
  rawResponse?: string;
  parsed?: Record<string, unknown>;
  postedComment?: string;
  transitions?: AgentRunTransition[];
  timings?: {
    totalMs?: number;
    modelMs?: number;
  };
  /** Free-form extras (artifact paths, error strings, etc.). */
  extra?: Record<string, unknown>;
}

export interface RecorderOptions {
  storage?: ArchiveStorage;
  logger?: Logger;
  /** Override the keying date (tests). */
  now?: () => Date;
}

/**
 * Persist a record. Idempotent at the storage layer — the second call
 * overwrites. Never throws; logs and returns false on failure.
 */
export async function recordAgentRun(
  record: AgentRunRecord,
  opts: RecorderOptions = {},
): Promise<boolean> {
  const log =
    opts.logger ??
    createLogger({ component: "agent-run-recorder", fields: { run_id: record.runId } });
  const storage = opts.storage ?? getArchiveStorage({ logger: log });
  const now = opts.now ? opts.now() : new Date();
  const day = isoDate(now);
  const key = `agent-runs/${day}/${record.runId}.json`;

  // Fill in promptSha if the caller gave us prompts but no hash.
  if (record.prompts && !record.prompts.promptSha) {
    record.prompts.promptSha = computePromptSha(record.prompts);
  }

  try {
    const body = JSON.stringify(record, null, 2);
    await storage.put(key, body);
    log.info("agent-run recorded", { key, bytes: body.length });
    return true;
  } catch (err) {
    log.warn("agent-run recorder failed (not fatal)", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Build a partial record from an AgentRun CR. Fills the structured
 * fields the dispatcher always has; the agent body is responsible for
 * attaching prompts/rawResponse/parsed via its own follow-up call.
 */
export function buildBaseRecord(run: AgentRun): AgentRunRecord {
  return {
    runId: run.metadata.name,
    agent: run.spec.agent ?? "unknown",
    app: run.spec.appRef?.name,
    ticket: {
      id: run.spec.issue?.id,
      title: run.spec.issue?.title,
      body: run.spec.issue?.body,
      url: run.spec.issue?.url,
    },
    engine: run.spec.engine
      ? {
          provider: run.spec.engine.kind,
          model: run.spec.engine.model,
          endpoint: run.spec.engine.endpoint,
        }
      : undefined,
  };
}

export function computePromptSha(prompts: AgentRunRecordEnginePrompt): string {
  const sys = prompts.system ?? "";
  const usr = prompts.user ?? "";
  return createHash("sha256").update(sys).update("\n").update(usr).digest("hex");
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
