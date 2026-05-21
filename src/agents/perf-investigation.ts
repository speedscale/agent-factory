import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface PerfInvestigationInput {
  slice: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  baselineSlice?: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  latencyPercentile?: "p50" | "p90" | "p95" | "p99";
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["slice"],
  properties: {
    slice: { type: "object", required: ["sourceRef", "service", "timeWindow"] },
    baselineSlice: { type: "object", required: ["sourceRef", "service", "timeWindow"] },
    latencyPercentile: { enum: ["p50", "p90", "p95", "p99"], default: "p95" },
  },
};

export const perfInvestigationAgent: AgentDef<PerfInvestigationInput> = {
  id: "perf-investigation",
  description:
    "Build a latency fingerprint of a traffic slice (optionally compared against a baseline slice), identify the dominant offending endpoint, and propose a measurement harness for confirming a fix.",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("perf-investigation");
  },
};
