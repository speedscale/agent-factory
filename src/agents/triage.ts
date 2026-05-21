import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface TriageInput {
  slice: {
    sourceRef: string;
    service: string;
    cluster?: string;
    timeWindow: { start: string; end: string };
    filters?: Array<{ jsonPath: string; operator: string; value?: string }>;
  };
  topN?: number;
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["slice"],
  properties: {
    slice: {
      type: "object",
      required: ["sourceRef", "service", "timeWindow"],
      properties: {
        sourceRef: { type: "string" },
        service: { type: "string" },
        cluster: { type: "string" },
        timeWindow: {
          type: "object",
          required: ["start", "end"],
          properties: {
            start: { type: "string", format: "date-time" },
            end: { type: "string", format: "date-time" },
          },
        },
        filters: { type: "array" },
      },
    },
    topN: { type: "integer", minimum: 1, default: 10 },
  },
};

export const triageAgent: AgentDef<TriageInput> = {
  id: "triage",
  description:
    "Given a traffic slice, compute a TrafficFingerprint and return a ranked list of candidate issues (each with a measurable metric and supporting evidence).",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("triage");
  },
};
