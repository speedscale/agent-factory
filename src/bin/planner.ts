import path from "node:path";
import { samplePlan, sampleRun } from "../lib/sample-data.js";
import { writeJsonFile } from "../lib/io.js";
import { buildPlan, loadPlannerContext, writePlanArtifact, writeTriageArtifact } from "../lib/planner.js";

function getRunInput(argv: string[]): string | undefined {
  const flagIndex = argv.findIndex((value) => value === "--run" || value === "-r");
  if (flagIndex >= 0 && typeof argv[flagIndex + 1] === "string") {
    return argv[flagIndex + 1];
  }

  const positional = argv.find((value) => !value.startsWith("-"));
  return positional;
}

async function runPlanner(runInput: string): Promise<unknown> {
  const context = await loadPlannerContext(runInput);
  const plan = buildPlan(context);
  const runJsonPath = path.join(context.runDir, "run.json");
  const updatedRun = {
    ...context.run,
    status: {
      ...context.run.status,
      phase: "planned" as const,
      summary: plan.spec.summary,
      artifacts: {
        ...context.run.status.artifacts,
        plan:
          context.run.status.artifacts.plan ??
          path.posix.join("artifacts", path.basename(context.runDir), "plan.yaml")
      }
    }
  };

  await Promise.all([
    writePlanArtifact(context.runDir, plan),
    writeTriageArtifact(context, plan),
    writeJsonFile(runJsonPath, updatedRun)
  ]);

  return {
    message: "planner produced a structured plan",
    run: context.run.metadata.name,
    plan
  };
}

async function main(): Promise<void> {
  const runInput = getRunInput(process.argv.slice(2));

  if (!runInput) {
    console.log(
      JSON.stringify(
        {
          message: "planner stub produced a deterministic plan",
          run: sampleRun.metadata.name,
          plan: samplePlan
        },
        null,
        2
      )
    );
    return;
  }

  const output = await runPlanner(runInput);
  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "planner failed";
  console.error(message);
  process.exitCode = 1;
});
