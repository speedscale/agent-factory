import type {
  AgentApp,
  AgentKind,
  AgentRun,
  QualityReport,
  TrafficEvidence,
  TrafficFingerprint,
  TrafficSource,
} from "../contracts/index.js";

export type AgentInputSchema = Record<string, unknown>;

export interface AgentRunContext {
  app: AgentApp;
  run: AgentRun;
  trafficSources: TrafficSource[];
  runDir: string;
  logger: AgentLogger;
}

export interface AgentLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface AgentRunOutput {
  summary: string;
  fingerprint?: TrafficFingerprint;
  evidence?: TrafficEvidence;
  qualityReport?: QualityReport;
  artifacts?: Record<string, string>;
}

export interface AgentDef<TInput = unknown> {
  id: AgentKind;
  description: string;
  inputSchema: AgentInputSchema;
  run(input: TInput, ctx: AgentRunContext): Promise<AgentRunOutput>;
}

export class AgentNotImplementedError extends Error {
  constructor(agentId: AgentKind) {
    super(`agent "${agentId}" is declared but not yet implemented`);
    this.name = "AgentNotImplementedError";
  }
}
