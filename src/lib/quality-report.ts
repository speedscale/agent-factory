import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentApp, AgentRun } from "../contracts/index.js";
import type { QualityBaseline, QualityReport } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo, writeJsonFile } from "./io.js";

interface CommandSnapshot {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WriteQualityArtifactsInput {
  run: AgentRun;
  app: AgentApp;
  build: CommandSnapshot;
  validation?: CommandSnapshot;
}

interface QualityTarget {
  name: string;
  workdir: string;
  baselineRef?: string;
}

export interface QualityReportOutcome {
  outcome: "pass" | "warning" | "regression";
  summary: string;
}

function toSafeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function resolveQualityTarget(run: AgentRun, app: AgentApp): QualityTarget {
  if (run.spec.qualityTarget) {
    return run.spec.qualityTarget;
  }

  const configured = app.spec.quality?.baseline?.targets?.[0];
  if (configured) {
    return {
      name: configured.name,
      workdir: configured.workdir,
      baselineRef: configured.baselineRef
    };
  }

  return {
    name: app.metadata.name,
    workdir: app.spec.repo.workdir
  };
}

function resolveBaselineStorePath(app: AgentApp, target: QualityTarget): string {
  const ref = target.baselineRef ?? `${app.metadata.name}/${target.name}`;
  return path.posix.join("artifacts", "baselines", `${ref.replace(/^\/+/, "")}.json`);
}

function resolveReportPaths(run: AgentRun): { baseline: string; json: string; markdown: string } {
  const base = path.posix.join("artifacts", run.metadata.name);
  return {
    baseline: run.status.artifacts.baseline ?? path.posix.join(base, "baseline.json"),
    json: run.status.artifacts.qualityReportJson ?? path.posix.join(base, "quality-report.json"),
    markdown: run.status.artifacts.qualityReportMarkdown ?? path.posix.join(base, "quality-report.md")
  };
}

function toMarkdown(report: QualityReport): string {
  const validationSection = report.spec.comparedCommands.validation
    ? `- validation baseline/current: ${String(report.spec.comparedCommands.validation.baselineExitCode ?? "n/a")} -> ${report.spec.comparedCommands.validation.currentExitCode}`
    : "- validation baseline/current: n/a";

  return [
    "# Quality Report",
    "",
    `- run: ${report.spec.runRef.name}`,
    `- app: ${report.spec.appRef.name}`,
    `- target: ${report.spec.target.name} (${report.spec.target.workdir})`,
    `- mode: ${report.spec.mode}`,
    `- outcome: ${report.spec.outcome}`,
    `- summary: ${report.spec.summary}`,
    `- build baseline/current: ${String(report.spec.comparedCommands.build.baselineExitCode ?? "n/a")} -> ${report.spec.comparedCommands.build.currentExitCode}`,
    `- build stderr lines baseline/current: ${String(report.spec.comparedCommands.build.baselineStderrLines ?? "n/a")} -> ${report.spec.comparedCommands.build.currentStderrLines}`,
    validationSection,
    `- baseline store: ${report.spec.target.baselineStorePath}`,
    report.spec.highlights.length > 0 ? "- highlights:" : "- highlights: none",
    ...report.spec.highlights.map((entry) => `  - ${entry}`),
    ""
  ].join("\n");
}

function countLines(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }

  return normalized.split(/\r?\n/).length;
}

function firstUsefulLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  return line;
}

export async function writeQualityArtifacts(input: WriteQualityArtifactsInput): Promise<QualityReportOutcome> {
  const { run, app, build, validation } = input;
  const target = resolveQualityTarget(run, app);
  const mode = run.spec.request?.mode ?? "comparison";
  const baselineStorePath = resolveBaselineStorePath(app, target);
  const reportPaths = resolveReportPaths(run);
  const now = new Date().toISOString();

  const baselineDoc: QualityBaseline = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "QualityBaseline",
    metadata: {
      name: `baseline-${toSafeSegment(app.metadata.name)}-${toSafeSegment(target.name)}`,
      generatedAt: now
    },
    spec: {
      appRef: {
        name: app.metadata.name
      },
      target,
      commands: {
        build: {
          command: build.command,
          exitCode: build.exitCode,
          stdoutLines: countLines(build.stdout),
          stderrLines: countLines(build.stderr)
        },
        validation:
          typeof validation !== "undefined"
            ? {
                command: validation.command,
                exitCode: validation.exitCode,
                stdoutLines: countLines(validation.stdout),
                stderrLines: countLines(validation.stderr)
              }
            : undefined
      }
    }
  };

  await mkdir(path.dirname(resolveFromRepo(baselineStorePath)), { recursive: true });

  let outcome: QualityReport["spec"]["outcome"] = "pass";
  let summary = "Current run matches baseline expectations.";
  let baselineForCompare: QualityBaseline | undefined;

  if (mode === "baseline") {
    await writeJsonFile(resolveFromRepo(baselineStorePath), baselineDoc);
    summary = "Baseline updated from current run outputs.";
  } else {
    try {
      baselineForCompare = await readJsonFile<QualityBaseline>(resolveFromRepo(baselineStorePath));
    } catch {
      outcome = "warning";
      summary = "No baseline found for this target. Run baseline mode during onboarding before enforcing comparison results.";
    }

    if (baselineForCompare) {
      const buildChanged = baselineForCompare.spec.commands.build.exitCode !== build.exitCode;
      const validationChanged =
        typeof validation !== "undefined" &&
        typeof baselineForCompare.spec.commands.validation !== "undefined" &&
        baselineForCompare.spec.commands.validation.exitCode !== validation.exitCode;

      if (buildChanged || validationChanged) {
        outcome = "regression";
        summary = "Current run differs from baseline command outcomes.";
      }
    }
  }

  const report: QualityReport = {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "QualityReport",
    metadata: {
      name: `quality-${run.metadata.name}`,
      generatedAt: now
    },
    spec: {
      runRef: {
        name: run.metadata.name
      },
      appRef: {
        name: app.metadata.name
      },
      target: {
        name: target.name,
        workdir: target.workdir,
        baselineStorePath
      },
      mode,
      outcome,
      summary,
      comparedCommands: {
        build: {
          baselineExitCode: baselineForCompare?.spec.commands.build.exitCode,
          currentExitCode: build.exitCode,
          baselineStdoutLines: baselineForCompare?.spec.commands.build.stdoutLines,
          currentStdoutLines: countLines(build.stdout),
          baselineStderrLines: baselineForCompare?.spec.commands.build.stderrLines,
          currentStderrLines: countLines(build.stderr)
        },
        validation:
          typeof validation !== "undefined"
            ? {
                baselineExitCode: baselineForCompare?.spec.commands.validation?.exitCode,
                currentExitCode: validation.exitCode,
                baselineStdoutLines: baselineForCompare?.spec.commands.validation?.stdoutLines,
                currentStdoutLines: countLines(validation.stdout),
                baselineStderrLines: baselineForCompare?.spec.commands.validation?.stderrLines,
                currentStderrLines: countLines(validation.stderr)
              }
            : undefined
      },
      highlights: [
        firstUsefulLine(build.stderr) ? `build stderr: ${firstUsefulLine(build.stderr)}` : undefined,
        typeof validation !== "undefined" && firstUsefulLine(validation.stderr)
          ? `validation stderr: ${firstUsefulLine(validation.stderr)}`
          : undefined
      ].filter((entry): entry is string => typeof entry === "string")
    }
  };

  await Promise.all([
    writeJsonFile(resolveFromRepo(reportPaths.baseline), baselineForCompare ?? baselineDoc),
    writeJsonFile(resolveFromRepo(reportPaths.json), report),
    writeFile(resolveFromRepo(reportPaths.markdown), toMarkdown(report), "utf8")
  ]);

  return { outcome, summary };
}
