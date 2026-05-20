/**
 * Tool-call hardening utilities for the agent loop.
 *
 * Pure helpers, no I/O. Inspired by antoinezambelli/forge — middleware-style
 * reliability guardrails for multi-step tool-calling. The agent loop in
 * llm-engine.ts wires these in; everything testable lives here.
 *
 * Five techniques:
 *   1. Rescue parsing — recover a fenced-JSON tool call from text when the
 *      model emits one as prose instead of a structured tool_use block.
 *   2. Error classification — distinguish bad args (ToolResolutionError) from
 *      runtime failures (ToolExecutionError); only the latter counts toward
 *      the consecutive-error abort budget.
 *   3. Per-tool prerequisites — ToolDef.requires lists tools that must have
 *      been called first in this run; checkPrerequisites returns a soft error.
 *   4. Escalating nudges — tier1 gentle / tier2 sharp+history / tier3 hard
 *      force via tool_choice. nudgeTierFor maps loops -> tier.
 *   5. Tiered deterministic compaction — phase 1/2/3 progressively shrink
 *      ConvMessage[] without an LLM call. compactMessages is pure.
 */

import type { ConvMessage, ToolDef, ToolUse } from "./llm-providers.js";

// ---------- (1) Rescue parsing ----------

/**
 * Scan assistant text blocks for fenced JSON tool calls and reconstruct them
 * as ToolUse objects. Some models — especially weaker open-weights — emit a
 * tool call as markdown like:
 *
 *     I'll read the file.
 *     ```json
 *     {"tool": "read_file", "input": {"path": "/foo/bar"}}
 *     ```
 *
 * instead of a structured tool_use block. Without rescue, the engine sees
 * stopReason=end_turn with empty toolUses and burns a loop iteration on a
 * re-prompt. Rescue catches the call inline, no extra round trip.
 *
 * Accepted shapes inside the fence:
 *   {"tool": "<name>", "input": {...}}
 *   {"name": "<name>", "input": {...}}
 *   {"name": "<name>", "arguments": {...}}  // OpenAI-style
 *
 * Returns one ToolUse per matched fence whose `name`/`tool` matches a known
 * tool. Unknown tool names are ignored. IDs are synthetic ("rescued-<n>") so
 * they don't collide with real provider-issued IDs.
 */
export function rescueToolCall(
  text: string,
  toolDefs: ToolDef[]
): ToolUse[] {
  if (!text) return [];
  const knownNames = new Set(toolDefs.map((t) => t.name));
  const rescued: ToolUse[] = [];
  // Match ```json ... ``` or ``` ... ``` with a JSON object inside.
  const fenceRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = fenceRe.exec(text)) !== null) {
    const blob = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const name = (obj.tool ?? obj.name) as string | undefined;
    if (!name || !knownNames.has(name)) continue;
    const input = (obj.input ?? obj.arguments) as Record<string, string> | undefined;
    if (!input || typeof input !== "object") continue;
    rescued.push({ id: `rescued-${idx++}`, name, input });
  }
  return rescued;
}

// ---------- (2) Error classification ----------

/**
 * The model sent a tool call we can't even bind to a tool implementation:
 * unknown name, missing required argument, wrong type. The agent should be
 * able to self-correct without burning the consecutive-error budget.
 */
export class ToolResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolResolutionError";
  }
}

/**
 * Tool was bound and invoked, but the underlying operation failed:
 * file not found, command exited non-zero, network error. Counts against
 * the consecutive-error budget — repeated execution failures mean the
 * model is stuck and the loop should abort.
 */
export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/**
 * Validate that a tool call has all required args of the right primitive
 * type. Throws ToolResolutionError on mismatch. Args are stringly-typed at
 * the boundary (Record<string,string>) so we only check presence and that
 * any declared array fields look array-shaped.
 */
export function validateToolArgs(
  toolDef: ToolDef,
  input: Record<string, unknown>
): void {
  const required = toolDef.inputSchema.required ?? [];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      throw new ToolResolutionError(
        `tool ${toolDef.name}: missing required arg "${key}"`
      );
    }
  }
}

// ---------- (3) Per-tool prerequisites ----------

/**
 * Check whether a tool's prerequisites have all been called in this run.
 * Returns a soft-error string if any prereq is unmet (the engine will hand
 * this back as the tool_result without incrementing the error budget).
 * Returns null when the tool is good to dispatch.
 *
 * Catches the "blind edit" failure mode where weaker models call write_file
 * on a path they haven't read_file'd first.
 */
export function checkPrerequisites(
  toolDef: ToolDef & { requires?: string[] },
  calledTools: Set<string>
): string | null {
  const requires = toolDef.requires ?? [];
  const missing = requires.filter((r) => !calledTools.has(r));
  if (missing.length === 0) return null;
  return (
    `PREREQUISITE_NOT_MET: tool "${toolDef.name}" requires you to call ` +
    missing.map((m) => `"${m}"`).join(", ") +
    ` first in this run. Call the prerequisite tool(s) and then retry.`
  );
}

// ---------- (4) Escalating nudges ----------

export type NudgeTier = 0 | 1 | 2 | 3;

export interface NudgeThresholds {
  /** Fraction of maxLoops at which tier1 (gentle) fires. Default 0.50. */
  tier1: number;
  /** Fraction of maxLoops at which tier2 (sharp + history) fires. Default 0.70. */
  tier2: number;
  /** Fraction of maxLoops at which tier3 (force via tool_choice) fires. Default 0.85. */
  tier3: number;
}

export const DEFAULT_NUDGE_THRESHOLDS: NudgeThresholds = {
  tier1: 0.5,
  tier2: 0.7,
  tier3: 0.85
};

/**
 * Map loop count -> highest tier that has fired. Returns 0 before tier1 and
 * monotonically non-decreases. The agent loop uses this to pick the right
 * nudge message and to set tool_choice on tier3.
 */
export function nudgeTierFor(
  loops: number,
  maxLoops: number,
  thresholds: NudgeThresholds = DEFAULT_NUDGE_THRESHOLDS
): NudgeTier {
  const frac = loops / maxLoops;
  if (frac >= thresholds.tier3) return 3;
  if (frac >= thresholds.tier2) return 2;
  if (frac >= thresholds.tier1) return 1;
  return 0;
}

/**
 * Build the nudge message for a given tier. tier1 is a soft heads-up,
 * tier2 includes a roll-up of tools the model has called so it can see
 * what remains, tier3 is curt — the engine simultaneously forces the
 * terminal tool via tool_choice at this tier so wording matters less.
 *
 * The "[SYSTEM]" prefix is load-bearing: compactMessages uses it as a
 * sentinel to drop nudges in phase 1 of compaction.
 */
export function buildNudgeMessage(
  tier: NudgeTier,
  loops: number,
  maxLoops: number,
  terminalToolName: string,
  calledTools: string[]
): string {
  const remaining = maxLoops - loops;
  switch (tier) {
    case 1:
      return (
        `[SYSTEM] You have ${remaining} of ${maxLoops} loops remaining. ` +
        `Consider whether you have enough to call ${terminalToolName} now.`
      );
    case 2: {
      const calledSummary = calledTools.length > 0
        ? `Tools called so far: ${calledTools.join(", ")}.`
        : `No tools called yet.`;
      return (
        `[SYSTEM] ${remaining} of ${maxLoops} loops remaining. ${calledSummary} ` +
        `Stop investigating — call ${terminalToolName} with whatever findings you have.`
      );
    }
    case 3:
      return (
        `[SYSTEM] You have used ${loops} of ${maxLoops} allowed loops. ` +
        `You MUST call ${terminalToolName} now with whatever findings you have. ` +
        `Do not read any more files or call any other tools first.`
      );
    default:
      return "";
  }
}

// ---------- (5) Tiered deterministic compaction ----------

export type CompactionPhase = 1 | 2 | 3;

export interface CompactionResult {
  messages: ConvMessage[];
  /** Approximate character count of the result, used to decide whether to
   * escalate to the next phase. Not tokens — we don't want to invoke a
   * tokenizer here. ~4 chars per token is a reasonable proxy. */
  chars: number;
  /** Counts for logging/observability. */
  stats: {
    nudgesDropped: number;
    toolResultsTruncated: number;
    toolResultsDropped: number;
    reasoningBlocksStripped: number;
  };
}

const NUDGE_SENTINEL = "[SYSTEM]";
const TRUNCATE_LEN = 200;

/**
 * Deterministically shrink the message history without an LLM call.
 *
 * Invariants preserved at every phase:
 *   - The original user message (messages[0]) is never touched.
 *   - Tool call structure (ids, names) is preserved so the provider can
 *     still match tool_results to tool_uses.
 *   - The last `recentTurns` user/assistant turn pairs (default 3) are
 *     never truncated or dropped from — only older messages compact.
 *
 * Phases:
 *   1. Drop nudge messages (starts with NUDGE_SENTINEL); truncate older
 *      tool_results to TRUNCATE_LEN chars.
 *   2. Drop older tool_results entirely (the assistant tool_use blocks
 *      stay so the provider sees the call shape).
 *   3. Strip reasoning blocks (assistant textBlocks) on older turns, keep
 *      only tool_uses.
 */
export function compactMessages(
  messages: ConvMessage[],
  phase: CompactionPhase,
  recentTurns: number = 3
): CompactionResult {
  const stats = {
    nudgesDropped: 0,
    toolResultsTruncated: 0,
    toolResultsDropped: 0,
    reasoningBlocksStripped: 0
  };
  if (messages.length === 0) {
    return { messages: [], chars: 0, stats };
  }

  // Keep the first message (original user instruction) and the last
  // `recentTurns` * 2 messages untouched. Compact everything in between.
  const head = messages[0];
  const tailStart = Math.max(1, messages.length - recentTurns * 2);
  const tail = messages.slice(tailStart);
  const middle = messages.slice(1, tailStart);

  const compactedMiddle: ConvMessage[] = [];
  for (const m of middle) {
    if (m.role === "user" && "content" in m) {
      // Phase 1+: drop nudges.
      if (phase >= 1 && m.content.startsWith(NUDGE_SENTINEL)) {
        stats.nudgesDropped++;
        continue;
      }
      compactedMiddle.push(m);
      continue;
    }
    if (m.role === "user" && "toolResults" in m) {
      // Phase 2+: drop tool_results entirely.
      if (phase >= 2) {
        stats.toolResultsDropped += m.toolResults.length;
        continue;
      }
      // Phase 1: truncate.
      const truncated = m.toolResults.map((r) => {
        if (r.content.length > TRUNCATE_LEN) {
          stats.toolResultsTruncated++;
          return {
            toolUseId: r.toolUseId,
            content: r.content.slice(0, TRUNCATE_LEN) + `... [+${r.content.length - TRUNCATE_LEN} chars dropped]`
          };
        }
        return r;
      });
      compactedMiddle.push({ role: "user", toolResults: truncated });
      continue;
    }
    // assistant turn.
    if (phase >= 3 && m.turn.textBlocks.length > 0) {
      stats.reasoningBlocksStripped += m.turn.textBlocks.length;
      compactedMiddle.push({
        role: "assistant",
        turn: {
          ...m.turn,
          textBlocks: []
        }
      });
      continue;
    }
    compactedMiddle.push(m);
  }

  const result = [head, ...compactedMiddle, ...tail];
  return {
    messages: result,
    chars: estimateChars(result),
    stats
  };
}

/**
 * Cheap character-count estimate for the message history. Used to decide
 * when compaction phases should escalate. Counts string fields recursively
 * but doesn't try to be exact about JSON overhead.
 */
export function estimateChars(messages: ConvMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user" && "content" in m) {
      n += m.content.length;
      continue;
    }
    if (m.role === "user" && "toolResults" in m) {
      for (const r of m.toolResults) n += r.content.length + r.toolUseId.length;
      continue;
    }
    for (const tb of m.turn.textBlocks) n += tb.text.length;
    for (const tu of m.turn.toolUses) {
      n += tu.name.length + tu.id.length + JSON.stringify(tu.input).length;
    }
    if (m.turn.reasoningContent) n += m.turn.reasoningContent.length;
  }
  return n;
}

/**
 * Decide whether and how aggressively to compact. Returns 0 (no action) or
 * a phase 1/2/3. Thresholds are fractions of `budgetChars`:
 *   - >= 0.70 → phase 1
 *   - >= 0.85 → phase 2
 *   - >= 0.95 → phase 3
 *
 * Tuned for an ~800k-char budget (~200k tokens) but works at any size.
 */
export function chooseCompactionPhase(
  currentChars: number,
  budgetChars: number
): CompactionPhase | 0 {
  if (budgetChars <= 0) return 0;
  const frac = currentChars / budgetChars;
  if (frac >= 0.95) return 3;
  if (frac >= 0.85) return 2;
  if (frac >= 0.7) return 1;
  return 0;
}
