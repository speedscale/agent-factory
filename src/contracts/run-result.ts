import type { AgentRunPhase } from "./agent-run.js";

export interface AgentRunResult {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "AgentRunResult";
  metadata: {
    name: string;
    generatedAt: string;
  };
  spec: {
    runRef: {
      name: string;
    };
    appRef: {
      name: string;
    };
    issue: {
      id: string;
      title: string;
      url?: string;
    };
    phase: AgentRunPhase;
    summary: string;
    commands: {
      build?: {
        command: string;
        exitCode: number;
      };
      validation?: {
        command: string;
        exitCode: number;
      };
    };
    artifacts: {
      run: string;
      evidence?: string;
      triage?: string;
      plan?: string;
      patch?: string;
      baseline?: string;
      buildLog?: string;
      validationReport?: string;
      qualityReportJson?: string;
      qualityReportMarkdown?: string;
      result: string;
    };
  };
}
