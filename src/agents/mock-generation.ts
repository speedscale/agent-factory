import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface MockGenerationInput {
  slice: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  output: {
    bundleName: string;
    version?: string;
  };
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["slice", "output"],
  properties: {
    slice: { type: "object", required: ["sourceRef", "service", "timeWindow"] },
    output: {
      type: "object",
      required: ["bundleName"],
      properties: {
        bundleName: { type: "string" },
        version: { type: "string" },
      },
    },
  },
};

export const mockGenerationAgent: AgentDef<MockGenerationInput> = {
  id: "mock-generation",
  description:
    "Produce a versioned mock bundle from a traffic slice that downstream consumers can use as a stand-in for the live service.",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("mock-generation");
  },
};
