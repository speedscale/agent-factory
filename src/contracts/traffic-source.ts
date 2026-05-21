export interface TrafficSource {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "TrafficSource";
  metadata: {
    name: string;
  };
  spec: {
    store: {
      kind: "speedscale-cloud" | "speedscale-onprem" | "local-fs";
      endpoint?: string;
      path?: string;
      auth?: {
        secretRef: {
          name: string;
          key: string;
        };
      };
    };
    scope: {
      clusters: string[];
      services?: string[];
      retention?: string;
      timeWindows?: Array<{
        start: string;
        end: string;
      }>;
    };
    dlp: {
      profile: "standard" | "strict" | "none";
      profileRef?: {
        name: string;
      };
    };
    tags?: Record<string, string>;
  };
}
