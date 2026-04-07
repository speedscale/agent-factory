export interface AgentEvidence {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "AgentEvidence";
  metadata: {
    name: string;
  };
  spec: {
    runRef: {
      name: string;
    };
    issue: {
      id: string;
      title: string;
      url?: string;
    };
    discovery: {
      source: "logs" | "speedscale-capture" | "both" | "unknown";
      notes: string;
    };
    capture: {
      dataset?: string;
      downloadCommand?: string;
      requestResponseSummary?: string;
    };
    reproduction: {
      steps: string[];
      expectedBehavior?: string;
      observedBehavior?: string;
    };
    suspectedBug?: string;
    fixSummary?: string;
    replayValidation: {
      command?: string;
      exitCode?: number;
      result?: "pass" | "fail" | "pending";
    };
  };
}
