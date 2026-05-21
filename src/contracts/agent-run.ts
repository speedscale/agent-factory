import type { AgentKind } from "./agent-kind.js";

export type AgentRunPhase =
  | "queued"
  | "planned"
  | "building"
  | "validating"
  | "generating"
  | "deploying"
  | "reporting"
  | "succeeded"
  | "failed";

export interface AgentRun {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "AgentRun";
  metadata: {
    name: string;
    [key: string]: unknown;
  };
  spec: {
    appRef: {
      name: string;
    };
    agent?: AgentKind;
    input?: unknown;
    engine?: {
      kind: "claude-sdk" | "generic-llm" | "private-llm";
      model?: string;
      endpoint?: string;
    };
    pinnedSpec?: {
      binaryVersion: string;
      agentDefVersion?: string;
      chartValuesHash?: string;
    };
    request?: {
      source: "pull_request" | "manual" | "agent" | "developer";
      mode: "comparison" | "baseline";
      url?: string;
      pullRequest?: {
        repository: string;
        number: number;
        headSha?: string;
        baseSha?: string;
      };
    };
    issue: {
      id: string;
      title: string;
      body: string;
      url?: string;
    };
    qualityTarget?: {
      name: string;
      workdir: string;
      baselineRef?: string;
    };
    workspace: {
      root: string;
      branch?: string;
    };
  };
  status: {
    phase: AgentRunPhase;
    summary?: string;
    lastTransitionAt?: string;
    artifacts: {
      evidence?: string;
      triage?: string;
      plan?: string;
      patch?: string;
      baseline?: string;
      buildLog?: string;
      validationReport?: string;
      qualityReportJson?: string;
      qualityReportMarkdown?: string;
      gateReport?: string;
      result?: string;
    };
  };
}
