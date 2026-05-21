export interface TrafficFingerprint {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "TrafficFingerprint";
  metadata: {
    name: string;
  };
  spec: {
    sliceRef: {
      name: string;
    };
    generatedAt: string;
    sampleCount: number;
    endpoints: Array<{
      method: string;
      path: string;
      requestCount: number;
      errorRate: number;
      statusBreakdown: Record<string, number>;
      latency: {
        p50Ms: number;
        p90Ms: number;
        p95Ms: number;
        p99Ms: number;
        maxMs: number;
      };
      burstPatterns?: Array<{
        windowMs: number;
        peakRequestCount: number;
        observedAt: string;
      }>;
      schemaVariants?: Array<{
        variantId: string;
        sampleCount: number;
        notableFields?: string[];
      }>;
    }>;
    overallErrorRate: number;
    notes?: string[];
  };
}
