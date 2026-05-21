export interface TrafficSlice {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "TrafficSlice";
  metadata: {
    name: string;
  };
  spec: {
    sourceRef: {
      name: string;
    };
    service: string;
    cluster?: string;
    endpoints?: string[];
    methods?: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS">;
    statusCodes?: number[];
    statusClasses?: Array<"2xx" | "3xx" | "4xx" | "5xx">;
    timeWindow: {
      start: string;
      end: string;
    };
    filters?: Array<{
      jsonPath: string;
      operator: "equals" | "contains" | "matches" | "exists";
      value?: string;
    }>;
    sampleLimit?: number;
  };
}
