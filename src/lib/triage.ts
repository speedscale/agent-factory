/**
 * Pre-dispatch triage step.
 *
 * Runs once before the Planner phase to decide whether the engine has enough
 * information to attempt the ticket at all. Complements the other pre-Planner
 * safety nets:
 *
 *   - spec-classifier.ts   — traffic vs source vs mixed
 *   - repro-context-detector.ts — refuse source mode when named artifacts are absent
 *   - THIS module          — is the ticket fit-for-dispatch at all?
 *
 * Fit-for-dispatch means: the ticket describes a concrete bug, names or
 * obviously implicates the code locus, pins down what "fixed" looks like, and
 * either provides reproduction context or is genuinely source-shaped (CLI
 * ergonomics, log-line bug, init ordering — no external recording needed).
 *
 * On `needs-info` the engine prints a reviewer-ready report and exits without
 * calling the Planner. The report lists specific missing context items and
 * recommended human actions so the spec can be improved and re-dispatched.
 */

import { callLLM, defaultModelFor, type LLMProvider } from "./llm-providers.js";

export type TriageVerdict = "dispatch" | "needs-info";

export interface TriageResult {
  verdict: TriageVerdict;
  reason: string;
  missingContext: string[];
  recommendedActions: string[];
  /** Raw model output, for logging/debugging. */
  rawResponse?: string;
}

export interface TriageOptions {
  /**
   * LLM provider. Required — callers must resolve from env (e.g. via
   * `resolveEngineConfig(process.env)`) rather than letting triage silently
   * default to Anthropic. A silent default masked chart misconfiguration:
   * flipping `engine.kind` to ds4 in values.yaml had no effect because the
   * agent always called Anthropic anyway.
   */
  provider: LLMProvider;
  model?: string;
  verbose?: boolean;
}

const TRIAGE_SYSTEM = `You are the Triage step for an automated bug-fix engine.

Your job: decide whether the engine has enough information in this ticket to attempt a fix, OR whether a human needs to add more context first. Be conservative — when the engine would have to guess at the desired behavior or the bug locus, route to "needs-info" rather than letting it produce a synthetic patch.

Verdict DISPATCH when ALL of the following are true:
  - The bug is described concretely (specific behavior, error, or symptom — not a vague concern)
  - Where the bug lives is named or obvious (a file, function, command, endpoint, or unambiguous symptom that the engine can localize without speculation)
  - Success criteria are pinned (what "fixed" looks like — explicit acceptance criteria, or trivially inferable from the bug description)
  - Reproduction is either present (steps, sample input, test, recording reference) OR genuinely source-shaped (e.g. CLI ergonomics, log-line bug, init ordering — no external recording needed)

Verdict NEEDS-INFO when ANY of the following are true:
  - The desired behavior is genuinely ambiguous (multiple plausible "fixes" exist and the ticket does not pick one)
  - Where the bug lives is unclear and the ticket gives no investigation lead
  - Reproduction would require context the engine cannot acquire (a customer report URL, internal cluster access, a recording that is not attached) and no usable substitute is provided
  - The ticket is a symptom report with no diagnostic work done yet
  - The acceptance criteria cannot be checked without information not in the ticket

Bias slightly toward DISPATCH when the engine could plausibly do the work even with some details missing. Bias toward NEEDS-INFO when the engine would be guessing at the spec.

Output JSON ONLY — no prose, no code fences, no preamble. Exact shape:
{
  "verdict": "dispatch" | "needs-info",
  "reason": "one or two sentences explaining the decision",
  "missingContext": ["specific things absent from the ticket that would unblock; empty array if verdict is dispatch"],
  "recommendedActions": ["concrete asks of the human reviewer; empty array if verdict is dispatch"]
}`;

/**
 * Parse the model response into a TriageResult. Defensive: tolerates models
 * that wrap JSON in ```json fences or add a leading sentence.
 *
 * Throws if the response cannot be coerced into the required shape.
 */
export function parseTriageResponse(raw: string): TriageResult {
  if (!raw || raw.trim() === "") {
    throw new Error("triage response was empty");
  }

  // Strip ```json or ``` fences if present.
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1].trim();

  // Some models add a leading sentence before the JSON. Find the first { and
  // the matching last } and parse the slice.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error(`triage response did not contain a JSON object: ${raw.slice(0, 200)}`);
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (e) {
    throw new Error(`triage response was not valid JSON: ${(e as Error).message}\nslice: ${jsonSlice.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("triage response was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const verdict = obj.verdict;
  if (verdict !== "dispatch" && verdict !== "needs-info") {
    throw new Error(`triage verdict must be "dispatch" or "needs-info", got ${JSON.stringify(verdict)}`);
  }

  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const missingContext = Array.isArray(obj.missingContext)
    ? obj.missingContext.filter((s): s is string => typeof s === "string")
    : [];
  const recommendedActions = Array.isArray(obj.recommendedActions)
    ? obj.recommendedActions.filter((s): s is string => typeof s === "string")
    : [];

  return { verdict, reason, missingContext, recommendedActions, rawResponse: raw };
}

/**
 * Format the triage result as a reviewer-ready report. Safe to paste into a
 * Linear comment or echo to the operator's terminal.
 */
export function formatTriageReport(result: TriageResult): string {
  const lines: string[] = [];
  lines.push(`Triage verdict: ${result.verdict.toUpperCase()}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.missingContext.length > 0) {
    lines.push("");
    lines.push("Missing context:");
    for (const m of result.missingContext) lines.push(`  - ${m}`);
  }
  if (result.recommendedActions.length > 0) {
    lines.push("");
    lines.push("Recommended actions (please add to the ticket):");
    for (const a of result.recommendedActions) lines.push(`  - ${a}`);
  }
  return lines.join("\n");
}

/**
 * Run triage against a spec. Returns the verdict and supporting fields.
 *
 * Single LLM call, no tool use, no agent loop. The provider is required;
 * model defaults to the per-provider default when the caller doesn't pin
 * one. Callers should resolve the provider from env (see
 * `resolveEngineConfig` in `engine-config.ts`) rather than hardcoding it.
 */
export async function runTriage(
  spec: { title: string; body: string },
  opts: TriageOptions
): Promise<TriageResult> {
  const provider = opts.provider;
  const model = opts.model ?? defaultModelFor(provider);

  const userMessage =
    `Ticket title: ${spec.title}\n\n` +
    `Ticket body:\n${spec.body}\n\n` +
    `Decide the verdict and respond with JSON only.`;

  const turn = await callLLM({
    provider,
    model,
    system: TRIAGE_SYSTEM,
    tools: [],
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 1024
  });

  const raw = turn.textBlocks.map((t) => t.text).join("").trim();
  if (opts.verbose) {
    console.log("[triage] raw response:", raw);
  }
  return parseTriageResponse(raw);
}

