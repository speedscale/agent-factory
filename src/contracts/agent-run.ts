export type AgentRunPhase =
  | "queued"
  | "planned"
  | "building"
  | "validating"
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
    issue: {
      id: string;
      title: string;
      body: string;
      url?: string;
    };
    workspace: {
      root: string;
      branch?: string;
    };
  };
  status: {
    phase: AgentRunPhase;
    summary?: string;
    artifacts: {
      triage?: string;
      plan?: string;
      patch?: string;
      buildLog?: string;
      validationReport?: string;
      result?: string;
    };
  };
}
