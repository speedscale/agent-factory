import type { AgentRunPhase } from "../contracts/index.js";
import { listRuns, requeueRun } from "../lib/run-admin.js";

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
          "npm run runs -- retry <run-name> [--force]"
        ],
        phases
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

  throw new Error(`unsupported command '${command}'`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "runs command failed";
  console.error(message);
  process.exitCode = 1;
});
