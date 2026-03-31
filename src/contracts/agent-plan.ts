export type AgentPlanAction = "inspect" | "edit" | "build" | "validate";

export interface AgentPlan {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "AgentPlan";
  metadata: {
    name: string;
    [key: string]: unknown;
  };
  spec: {
    runRef: {
      name: string;
    };
    summary: string;
    hypothesis: string;
    steps: Array<{
      id: string;
      action: AgentPlanAction;
      description: string;
      targetPaths?: string[];
      command?: string;
    }>;
    validation: {
      command: string;
      successCriteria: string;
    };
  };
}
