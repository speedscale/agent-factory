export interface AgentTriage {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "AgentTriage";
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
    };
    hypothesis: string;
    confidence: "low" | "medium" | "high";
    candidatePaths: string[];
    rationale: string[];
  };
}
