import type { AgentEnablement, AgentKind } from "./agent-kind.js";

export interface AgentApp {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "AgentApp";
  metadata: {
    name: string;
    [key: string]: unknown;
  };
  spec: {
    repo: {
      provider: "github" | "gitlab";
      url: string;
      defaultBranch: string;
      workdir: string;
      dependencies?: Array<{
        provider: "github" | "gitlab";
        url: string;
      }>;
    };
    trafficSources?: Array<{
      name: string;
      services?: string[];
    }>;
    agents?: Partial<Record<AgentKind, AgentEnablement>>;
    approvers?: {
      groups?: string[];
      users?: string[];
    };
    scm?: {
      branchPrefix?: string;
      prLabels?: string[];
      prTemplate?: string;
      autoMergeThreshold?: number;
    };
    issue?: {
      labels?: {
        include?: string[];
      };
    };
    quality?: {
      trigger?: {
        pullRequest?: boolean;
        manualRequest?: boolean;
        prePrRequest?: boolean;
      };
      baseline?: {
        strategy?: "single" | "multi-project";
        targets: Array<{
          name: string;
          workdir: string;
          baselineRef?: string;
          command?: string;
        }>;
      };
      reporting?: {
        formats?: Array<"json" | "markdown">;
        failOnRegression?: boolean;
        thresholds?: {
          maxBuildStderrLineDelta?: number;
          maxValidationStderrLineDelta?: number;
        };
      };
    };
    build: {
      /**
       * Dependency-install command run before `test` (e.g. `npm ci`, `go mod
       * download`, `pip install -r requirements.txt`). Optional — an empty
       * string or omitted field skips the install step. Shares the same
       * timeoutSeconds / maxNoOutputSeconds / retries as `test`.
       */
      install?: string;
      test: string;
      start: string;
      timeoutSeconds?: number;
      maxNoOutputSeconds?: number;
      retries?: number;
    };
    validate: {
      proxymock: {
        dataset: string;
        mode: string;
        command: string;
        timeoutSeconds?: number;
        maxNoOutputSeconds?: number;
        retries?: number;
        service?: {
          command?: string;
          host?: string;
          port: number;
          startupTimeoutSeconds?: number;
        };
        dependencies?: {
          setupCommand?: string;
          teardownCommand?: string;
        };
      };
    };
    policy?: {
      autoBranch?: boolean;
      autoMr?: boolean;
      autoMerge?: boolean;
    };
  };
}
