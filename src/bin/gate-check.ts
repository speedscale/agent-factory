import path from "node:path";
import type { GateReport } from "../contracts/index.js";
import { readJsonFile, resolveFromRepo } from "../lib/io.js";

interface GateCheckOptions {
  runName?: string;
  gateFile?: string;
}

function getArg(argv: string[], flags: string[]): string | undefined {
  const index = argv.findIndex((value) => flags.includes(value));
  if (index >= 0 && typeof argv[index + 1] === "string") {
    return argv[index + 1];
  }

  return undefined;
}

function parseOptions(argv: string[]): GateCheckOptions {
  const runName = getArg(argv, ["--run", "-r"]);
  const gateFile = getArg(argv, ["--file", "-f"]);
  const positional = argv.find((value) => !value.startsWith("-"));

  if (gateFile) {
    return { gateFile };
  }

  if (runName) {
    return { runName };
  }

  if (positional) {
    if (positional.endsWith(".json") || positional.includes("/")) {
      return { gateFile: positional };
    }

    return { runName: positional };
  }

  throw new Error("usage: npm run gate:check -- --run <run-name> | --file <path-to-gate.json>");
}

function resolveGatePath(options: GateCheckOptions): string {
  if (options.gateFile) {
    return path.isAbsolute(options.gateFile) ? options.gateFile : resolveFromRepo(options.gateFile);
  }

  const runName = options.runName;
  if (!runName) {
    throw new Error("run name required when --file is not provided");
  }

  return resolveFromRepo("artifacts", runName, "gate.json");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const gatePath = resolveGatePath(options);
  const gate = await readJsonFile<GateReport>(gatePath);

  const verdict = gate.spec.verdict;
  const blocking = gate.spec.blocking;

  console.log(
    JSON.stringify(
      {
        run: gate.spec.runRef.name,
        verdict,
        blocking,
        reasonCodes: gate.spec.reasonCodes,
        summary: gate.spec.summary,
        gatePath: path.relative(resolveFromRepo("."), gatePath) || gatePath
      },
      null,
      2
    )
  );

  if (blocking) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "gate check failed";
  console.error(message);
  process.exitCode = 1;
});
