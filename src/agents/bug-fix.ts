import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface BugFixInput {
  issue: {
    id: string;
    title: string;
    body?: string;
    url?: string;
  };
  slice: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  metric: {
    name: string;
    threshold: number;
    comparator: "lt" | "lte" | "gt" | "gte" | "eq";
    unit?: string;
  };
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["issue", "slice", "metric"],
  properties: {
    issue: {
      type: "object",
      required: ["id", "title"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        url: { type: "string", format: "uri" },
      },
    },
    slice: {
      type: "object",
      required: ["sourceRef", "service", "timeWindow"],
    },
    metric: {
      type: "object",
      required: ["name", "threshold", "comparator"],
      properties: {
        name: { type: "string" },
        threshold: { type: "number" },
        comparator: { enum: ["lt", "lte", "gt", "gte", "eq"] },
        unit: { type: "string" },
      },
    },
  },
};

export const bugFixAgent: AgentDef<BugFixInput> = {
  id: "bug-fix",
  description:
    "Reproduce a bug against a traffic slice, generate a candidate patch, validate the named metric is back within bound on the patched build, and open a PR with the evidence.",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("bug-fix");
  },
};
