import type { AgentDef, AgentInputSchema } from "./types.js";
import { AgentNotImplementedError } from "./types.js";

export interface PrReplayCheckInput {
  pullRequest: {
    repository: string;
    number: number;
    headSha: string;
    baseSha: string;
  };
  slice: {
    sourceRef: string;
    service: string;
    timeWindow: { start: string; end: string };
  };
  failOnAny?: Array<"status" | "schema" | "latency-regression">;
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["pullRequest", "slice"],
  properties: {
    pullRequest: {
      type: "object",
      required: ["repository", "number", "headSha", "baseSha"],
      properties: {
        repository: { type: "string" },
        number: { type: "integer", minimum: 1 },
        headSha: { type: "string" },
        baseSha: { type: "string" },
      },
    },
    slice: { type: "object", required: ["sourceRef", "service", "timeWindow"] },
    failOnAny: {
      type: "array",
      items: { enum: ["status", "schema", "latency-regression"] },
    },
  },
};

export const prReplayCheckAgent: AgentDef<PrReplayCheckInput> = {
  id: "pr-replay-check",
  description:
    "Build the PR head, replay the slice's RRPairs against it, diff with compare_rrpair_files, and report pass/fail to SCM. Gate for merge.",
  inputSchema,
  async run(_input, _ctx) {
    throw new AgentNotImplementedError("pr-replay-check");
  },
};
