export type AgentKind =
  | "triage"
  | "bug-fix"
  | "perf-investigation"
  | "coverage-fill"
  | "pr-replay-check"
  | "mock-generation"
  | "migration-safety"
  | "traffic-monitor"
  | "reproduce";

export const AGENT_KINDS: readonly AgentKind[] = [
  "triage",
  "bug-fix",
  "perf-investigation",
  "coverage-fill",
  "pr-replay-check",
  "mock-generation",
  "migration-safety",
  "traffic-monitor",
  "reproduce",
] as const;

export interface AgentEnablement {
  enabled: boolean;
  autoCreatePR?: boolean;
  autoMergeThreshold?: number;
  blockMerge?: boolean;
  ciTimeout?: string;
}
