export interface TrafficSource {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "TrafficSource";
  metadata: {
    name: string;
  };
  spec: {
    store: {
      kind: "speedscale-cloud" | "speedscale-onprem" | "local-fs" | "loki" | "elasticsearch";
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
       * When set, overrides scope.clusters / scope.services label filters.
       * See speedscale/demo's reference-architectures/grafana/scripts/loki-gather.py
       * for the label set the BYOC forwarder produces.
       */
      logql?: string;
      /**
       * Elasticsearch-only: raw ES Query DSL JSON clause passed to es-gather's
       * --query flag. When set, overrides scope.clusters / scope.services filters.
       * See speedscale/demo's reference-architectures/elasticsearch/scripts/es-gather.py.
       */
      query?: string;
      /**
       * Time window for gather scripts (loki-gather --start, es-gather --start).
       * Accepts relative offsets like "-1h", "-15m", or RFC3339 timestamps.
       * Defaults to "-1h" when unset.
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
