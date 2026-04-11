export interface QualityReport {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "QualityReport";
  metadata: {
    name: string;
    generatedAt: string;
  };
  spec: {
    runRef: {
      name: string;
    };
    appRef: {
      name: string;
    };
    target: {
      name: string;
      workdir: string;
      baselineStorePath: string;
    };
    mode: "comparison" | "baseline";
    outcome: "pass" | "warning" | "regression";
    summary: string;
    comparedCommands: {
      build: {
        baselineExitCode?: number;
        currentExitCode: number;
        baselineStdoutLines?: number;
        currentStdoutLines: number;
        baselineStderrLines?: number;
        currentStderrLines: number;
      };
      validation?: {
        baselineExitCode?: number;
        currentExitCode: number;
        baselineStdoutLines?: number;
        currentStdoutLines: number;
        baselineStderrLines?: number;
        currentStderrLines: number;
      };
    };
    highlights: string[];
  };
}
