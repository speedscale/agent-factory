import path from "node:path";
import { sampleRun } from "../lib/sample-data.js";
import { writeJsonFile } from "../lib/io.js";
import { loadRunnerContext, runBuildStage } from "../lib/runner.js";

function getArg(argv: string[], flagNames: string[]): string | undefined {
  const flagIndex = argv.findIndex((value) => flagNames.includes(value));
  if (flagIndex >= 0 && typeof argv[flagIndex + 1] === "string") {
    return argv[flagIndex + 1];
  }

  return undefined;
}

async function runRunner(runInput: string, sourceDir?: string): Promise<unknown> {
  const context = await loadRunnerContext(runInput, sourceDir);

  const startedRun = {
    ...context.run,
    status: {
      ...context.run.status,
      phase: "building" as const,
      summary: "Preparing isolated workspace and executing build commands."
    }
  };

  await writeJsonFile(path.join(context.runDir, "run.json"), startedRun);

  const { result, run } = await runBuildStage({ ...context, run: startedRun });

  return {
    message: "runner executed the build stage",
    run: run.metadata.name,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    phase: run.status.phase
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runInput = getArg(argv, ["--run", "-r"]);
  const sourceDir = getArg(argv, ["--source", "-s"]);

  if (!runInput) {
    console.log(
      JSON.stringify(
        {
          message: "runner stub",
          actions: [
            "create isolated workspace",
            "clone or prepare target app repository",
            "apply patch attempt",
            "run build commands",
            "capture logs and diff"
          ],
          run: sampleRun.metadata.name
        },
        null,
        2
      )
    );
    return;
  }

  const output = await runRunner(runInput, sourceDir);
  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "runner failed";
  console.error(message);
  process.exitCode = 1;
});
