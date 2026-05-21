export interface TrafficEvidence {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "TrafficEvidence";
  metadata: {
    name: string;
  };
  spec: {
    sliceRef: {
      name: string;
    };
    fingerprintRef?: {
      name: string;
    };
    dlpProfile: "standard" | "strict" | "none";
    tokenBudget: number;
    estimatedTokens: number;
    excerpts: Array<{
      rrpairId: string;
      endpoint: string;
      method: string;
      statusCode: number;
      occurredAt: string;
      request: {
        headers?: Record<string, string>;
        bodyExcerpt?: string;
        bodyTruncated?: boolean;
      };
      response: {
        headers?: Record<string, string>;
        bodyExcerpt?: string;
        bodyTruncated?: boolean;
      };
      maskedFields?: string[];
    }>;
    droppedForBudget?: number;
  };
}
