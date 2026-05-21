import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface CoverageFillInput {
  slice: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  codeSurface: {
    repoUrl: string;
    branch?: string;
    pathGlobs?: string[];
  };
  generateRRPairs?: boolean;
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["slice", "codeSurface"],
  properties: {
    slice: { type: "object", required: ["sourceRef", "service", "timeWindow"] },
    codeSurface: {
      type: "object",
      required: ["repoUrl"],
      properties: {
        repoUrl: { type: "string", format: "uri" },
        branch: { type: "string" },
        pathGlobs: { type: "array", items: { type: "string" } },
      },
    },
    generateRRPairs: { type: "boolean", default: false },
  },
};

export const coverageFillAgent: AgentDef<CoverageFillInput> = {
  id: "coverage-fill",
  description:
    "Diff an RRPair set against a code surface; report uncovered endpoints; optionally generate a representative RRPair per gap, validate against the build, and store tagged as agent-generated.",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("coverage-fill");
  },
};
