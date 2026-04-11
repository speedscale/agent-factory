import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import { resolveFromRepo } from "../lib/io.js";
import { writeQualityArtifacts } from "../lib/quality-report.js";

function createApp(): AgentApp {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentApp",
    metadata: {
      name: "integration-qa"
    },
    spec: {
      repo: {
        provider: "github",
        url: "https://github.com/speedscale/demo",
        defaultBranch: "main",
        workdir: "node"
      },
      quality: {
        baseline: {
          strategy: "single",
          targets: [
            {
              name: "node",
              workdir: "node",
              baselineRef: "integration/qa"
            }
          ]
        },
        reporting: {
          failOnRegression: true,
          formats: ["json", "markdown"]
        }
      },
      build: {
        install: "npm ci",
        test: "npm test",
        start: "npm start"
      },
      validate: {
        proxymock: {
          dataset: "integration",
          mode: "replay-with-mocks",
          command: "proxymock replay"
        }
      }
    }
  };
}

function createRun(name: string, mode: "comparison" | "baseline"): AgentRun {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "AgentRun",
    metadata: {
      name
    },
    spec: {
      appRef: {
        name: "integration-qa"
      },
      request: {
        source: "developer",
        mode
      },
      issue: {
        id: `${mode}-${name}`,
        title: `integration ${mode}`,
        body: "integration",
        url: "https://example.com"
      },
      qualityTarget: {
        name: "node",
        workdir: "node",
        baselineRef: "integration/qa"
      },
      workspace: {
        root: `.work/${name}`,
        branch: `agent/${name}`
      }
    },
    status: {
      phase: "validating",
      artifacts: {
        baseline: `artifacts/${name}/baseline.json`,
        qualityReportJson: `artifacts/${name}/quality-report.json`,
        qualityReportMarkdown: `artifacts/${name}/quality-report.md`
      }
    }
  };
}

async function ensureRunArtifacts(runName: string): Promise<void> {
  await mkdir(resolveFromRepo(path.join("artifacts", runName)), { recursive: true });
}

async function main(): Promise<void> {
  const app = createApp();
  const suffix = String(Date.now());

  const baselineRun = createRun(`run-integration-baseline-${suffix}`, "baseline");
  await ensureRunArtifacts(baselineRun.metadata.name);
  const baselineOutcome = await writeQualityArtifacts({
    run: baselineRun,
    app,
    build: {
      command: "npm test",
      exitCode: 0,
      stdout: "ok",
      stderr: ""
    },
    validation: {
      command: "proxymock replay",
      exitCode: 0,
      stdout: "replay ok",
      stderr: ""
    }
  });
  assert.equal(baselineOutcome.outcome, "pass");

  const comparisonRun = createRun(`run-integration-compare-${suffix}`, "comparison");
  await ensureRunArtifacts(comparisonRun.metadata.name);
  const comparisonOutcome = await writeQualityArtifacts({
    run: comparisonRun,
    app,
    build: {
      command: "npm test",
      exitCode: 0,
      stdout: "ok",
      stderr: ""
    },
    validation: {
      command: "proxymock replay",
      exitCode: 0,
      stdout: "replay ok",
      stderr: ""
    }
  });
  assert.equal(comparisonOutcome.outcome, "pass");

  const regressionRun = createRun(`run-integration-regression-${suffix}`, "comparison");
  await ensureRunArtifacts(regressionRun.metadata.name);
  const regressionOutcome = await writeQualityArtifacts({
    run: regressionRun,
    app,
    build: {
      command: "npm test",
      exitCode: 1,
      stdout: "",
      stderr: "failing test"
    },
    validation: {
      command: "proxymock replay",
      exitCode: 0,
      stdout: "replay ok",
      stderr: ""
    }
  });
  assert.equal(regressionOutcome.outcome, "regression");

  console.log(JSON.stringify({ message: "qa integration checks passed" }, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "qa integration failed";
  console.error(message);
  process.exitCode = 1;
});
