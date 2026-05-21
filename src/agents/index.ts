import type { AgentKind } from "../contracts/index.js";
import { bugFixAgent } from "./bug-fix.js";
import { coverageFillAgent } from "./coverage-fill.js";
import { migrationSafetyAgent } from "./migration-safety.js";
import { mockGenerationAgent } from "./mock-generation.js";
import { perfInvestigationAgent } from "./perf-investigation.js";
import { prReplayCheckAgent } from "./pr-replay-check.js";
import { triageAgent } from "./triage.js";
import type { AgentDef } from "./types.js";

export const agentRegistry: Record<AgentKind, AgentDef> = {
  "triage": triageAgent,
  "bug-fix": bugFixAgent,
  "perf-investigation": perfInvestigationAgent,
  "coverage-fill": coverageFillAgent,
  "pr-replay-check": prReplayCheckAgent,
  "mock-generation": mockGenerationAgent,
  "migration-safety": migrationSafetyAgent,
};

export function getAgent(kind: AgentKind): AgentDef {
  const agent = agentRegistry[kind];
  if (!agent) {
    throw new Error(`unknown agent kind: ${String(kind)}`);
  }
  return agent;
}

export type {
  AgentDef,
  AgentInputSchema,
  AgentLogger,
  AgentRunContext,
  AgentRunOutput,
} from "./types.js";
export { AgentNotImplementedError } from "./types.js";
