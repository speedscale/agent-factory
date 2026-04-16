export type GateVerdict = "PASS" | "FAIL_REGRESSION" | "FAIL_SYSTEM" | "FAIL_NO_BASELINE";

export interface GateReport {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "GateReport";
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
    mode: "comparison" | "baseline";
    verdict: GateVerdict;
    blocking: boolean;
    reasonCodes: string[];
    summary: string;
    metrics: {
      buildExitCode: number;
      validationExitCode?: number;
      baselineBuildExitCode?: number;
      baselineValidationExitCode?: number;
      buildStderrLineDelta?: number;
      validationStderrLineDelta?: number;
    };
    evidencePaths: {
      qualityReportJson: string;
      qualityReportMarkdown: string;
      buildLog?: string;
      validationLog?: string;
      baselineStorePath: string;
    };
    nextActions: string[];
  };
}
