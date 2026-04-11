export interface QualityBaseline {
  apiVersion: "agents.speedscale.io/v1alpha1";
  kind: "QualityBaseline";
  metadata: {
    name: string;
    generatedAt: string;
  };
  spec: {
    appRef: {
      name: string;
    };
    target: {
      name: string;
      workdir: string;
      baselineRef?: string;
    };
    commands: {
      build: {
        command: string;
        exitCode: number;
      };
      validation?: {
        command: string;
        exitCode: number;
      };
    };
  };
}
