import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface MigrationSafetyInput {
  oldBuild: {
    repoUrl: string;
    ref: string;
  };
  newBuild: {
    repoUrl: string;
    ref: string;
  };
  slice: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  ignoreFieldPaths?: string[];
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["oldBuild", "newBuild", "slice"],
  properties: {
    oldBuild: {
      type: "object",
      required: ["repoUrl", "ref"],
      properties: {
        repoUrl: { type: "string", format: "uri" },
        ref: { type: "string" },
      },
    },
    newBuild: {
      type: "object",
      required: ["repoUrl", "ref"],
      properties: {
        repoUrl: { type: "string", format: "uri" },
        ref: { type: "string" },
      },
    },
    slice: { type: "object", required: ["sourceRef", "service", "timeWindow"] },
    ignoreFieldPaths: { type: "array", items: { type: "string" } },
  },
};

export const migrationSafetyAgent: AgentDef<MigrationSafetyInput> = {
  id: "migration-safety",
  description:
    "Replay the same slice against an old build and a new build; report response-shape divergence (status, schema, latency) field-by-field. Use for migration cutover go/no-go.",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("migration-safety");
  },
};
