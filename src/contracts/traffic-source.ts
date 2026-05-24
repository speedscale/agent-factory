export interface TrafficSource {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "TrafficSource";
  metadata: {
    name: string;
  };
  spec: {
    store: {
      kind: "speedscale-cloud" | "speedscale-onprem" | "local-fs" | "loki";
      endpoint?: string;
      path?: string;
      auth?: {
        secretRef: {
          name: string;
          key: string;
        };
      };
      /**
       * Loki-only: LogQL query used to select the slice of RRPair traffic.
       * Required when kind is "loki". See speedscale/demo's
       * reference-architectures/grafana/scripts/loki-gather.py for the
       * label set the BYOC forwarder produces.
       */
      logql?: string;
      /**
       * Loki-only: time window passed to loki-gather (e.g. "-1h", "-15m",
       * or an RFC3339 timestamp). Optional; defaults to "-1h" when
       * unset. Same syntax as loki-gather's --start flag.
       */
      window?: string;
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
