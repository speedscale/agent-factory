import path from "node:path";
import { sampleRun } from "../lib/sample-data.js";
import { writeJsonFile } from "../lib/io.js";
import { loadValidatorContext, runValidationStage } from "../lib/validator.js";

function getRunInput(argv: string[]): string | undefined {
  const flagIndex = argv.findIndex((value) => value === "--run" || value === "-r");
  if (flagIndex >= 0 && typeof argv[flagIndex + 1] === "string") {
    return argv[flagIndex + 1];
  }

  return argv.find((value) => !value.startsWith("-"));
}

async function runValidator(runInput: string): Promise<unknown> {
  const context = await loadValidatorContext(runInput);
  const startedRun = {
    ...context.run,
    status: {
      ...context.run.status,
      phase: "validating" as const,
      summary: "Running proxymock validation command."
    }
  };

  await writeJsonFile(path.join(context.runDir, "run.json"), startedRun);

  const { result, run } = await runValidationStage({ ...context, run: startedRun });

  return {
    message: "validator executed the proxymock command",
    run: run.metadata.name,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    phase: run.status.phase
  };
}

async function main(): Promise<void> {
  const runInput = getRunInput(process.argv.slice(2));

  if (!runInput) {
    console.log(
      JSON.stringify(
        {
          message: "validator stub",
          actions: [
            "start proxymock validation flow",
            "run configured replay command",
            "collect validation logs",
            "emit validation artifact"
          ],
          run: sampleRun.metadata.name
        },
        null,
        2
      )
    );
    return;
  }

  const output = await runValidator(runInput);
  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "validator failed";
  console.error(message);
  process.exitCode = 1;
});
