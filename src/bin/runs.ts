import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentRunPhase } from "../contracts/index.js";
import type { AgentApp } from "../contracts/index.js";
import { listRuns, requeueRun } from "../lib/run-admin.js";
import { createRunQueueFromEnv } from "../lib/run-queue.js";
import { createRunFromRequest } from "../lib/run-store.js";

const phases: AgentRunPhase[] = [
  "queued",
  "planned",
  "building",
  "validating",
  "succeeded",
  "failed"
];

function getArg(argv: string[], flagNames: string[]): string | undefined {
  const index = argv.findIndex((value) => flagNames.includes(value));
  if (index >= 0 && typeof argv[index + 1] === "string") {
    return argv[index + 1];
  }

  return undefined;
}

function hasFlag(argv: string[], flagNames: string[]): boolean {
  return argv.some((value) => flagNames.includes(value));
}

function parsePhase(argv: string[]): AgentRunPhase | undefined {
  const value = getArg(argv, ["--phase", "-p"]);
  if (!value) {
    return undefined;
  }

  if (!phases.includes(value as AgentRunPhase)) {
    throw new Error(`unsupported phase '${value}'`);
  }

  return value as AgentRunPhase;
}

function printUsage(): void {
  console.log(
    JSON.stringify(
      {
        message: "run operations",
        usage: [
          "npm run runs -- list [--phase <phase>]",
          "npm run runs -- retry <run-name> [--force]",
          "npm run runs -- baseline <app-manifest-path> [--target <name>] [--id <custom-id>]"
        ],
        phases
      },
      null,
      2
    )
  );
}

function resolveTarget(app: AgentApp, targetName?: string): { name: string; workdir: string; baselineRef?: string } {
  const configuredTargets = app.spec.quality?.baseline?.targets ?? [];

  if (configuredTargets.length === 0) {
    return {
      name: app.metadata.name,
      workdir: app.spec.repo.workdir
    };
  }

  if (targetName) {
    const selected = configuredTargets.find((target) => target.name.toLowerCase() === targetName.toLowerCase());
    if (!selected) {
      throw new Error(`quality target '${targetName}' not found in manifest`);
    }

    return {
      name: selected.name,
      workdir: selected.workdir,
      baselineRef: selected.baselineRef
    };
  }

  if (configuredTargets.length > 1) {
    throw new Error("manifest has multiple quality targets; provide --target <name>");
  }

  const selected = configuredTargets[0];
  return {
    name: selected.name,
    workdir: selected.workdir,
    baselineRef: selected.baselineRef
  };
}

async function loadAgentAppFromManifest(manifestPath: string): Promise<AgentApp> {
  const absolutePath = path.resolve(manifestPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = absolutePath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid manifest payload: ${manifestPath}`);
  }

  const candidate = parsed as AgentApp;
  if (!candidate.metadata?.name || !candidate.spec?.repo?.workdir) {
    throw new Error(`manifest missing required fields: ${manifestPath}`);
  }

  return candidate;
}

async function runBaseline(argv: string[]): Promise<void> {
  const manifestPath = argv[1];
  if (!manifestPath) {
    throw new Error("baseline requires <app-manifest-path>");
  }

  const targetName = getArg(argv, ["--target", "-t"]);
  const customId = getArg(argv, ["--id"]);
  const app = await loadAgentAppFromManifest(manifestPath);
  const target = resolveTarget(app, targetName);
  const issueId = customId ?? `baseline-${target.name}-${Date.now()}`;

  const run = await createRunFromRequest({
    app,
    issue: {
      id: issueId,
      title: `Baseline capture: ${app.metadata.name}/${target.name}`,
      body: "Onboarding baseline capture request",
      url: undefined
    },
    request: {
      source: "developer",
      mode: "baseline"
    },
    qualityTarget: target
  });

  console.log(
    JSON.stringify(
      {
        message: "baseline run queued",
        run: run.metadata.name,
        app: app.metadata.name,
        qualityTarget: target.name,
        workdir: target.workdir
      },
      null,
      2
    )
  );
}

async function runList(argv: string[]): Promise<void> {
  const phase = parsePhase(argv);
  const runs = await listRuns(phase);

  console.log(
    JSON.stringify(
      {
        count: runs.length,
        phase: phase ?? "all",
        runs: runs.map((run) => ({
          name: run.metadata.name,
          app: run.spec.appRef.name,
          issue: run.spec.issue.id,
          status: run.status.phase,
          summary: run.status.summary ?? ""
        }))
      },
      null,
      2
    )
  );
}

async function runRetry(argv: string[]): Promise<void> {
  const runName = argv[1];
  if (!runName) {
    throw new Error("retry requires a run name");
  }

  const force = hasFlag(argv, ["--force"]);
  const run = await requeueRun(runName, force);
  const queue = createRunQueueFromEnv();
  try {
    await queue.enqueueRun(run.metadata.name);
  } finally {
    await queue.close();
  }

  console.log(
    JSON.stringify(
      {
        message: "run requeued",
        run: run.metadata.name,
        status: run.status.phase,
        summary: run.status.summary
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "list") {
    await runList(argv.slice(1));
    return;
  }

  if (command === "retry") {
    await runRetry(argv);
    return;
  }

  if (command === "baseline") {
    await runBaseline(argv);
    return;
  }

  throw new Error(`unsupported command '${command}'`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "runs command failed";
  console.error(message);
  process.exitCode = 1;
});
