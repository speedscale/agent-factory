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
    };
    issue?: {
      labels?: {
        include?: string[];
      };
    };
    build: {
      install: string;
      test: string;
      start: string;
    };
    validate: {
      proxymock: {
        dataset: string;
        mode: string;
        command: string;
        service?: {
          command?: string;
          host?: string;
          port: number;
          startupTimeoutSeconds?: number;
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
