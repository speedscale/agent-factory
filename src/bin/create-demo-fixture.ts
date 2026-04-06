import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveFromRepo } from "../lib/io.js";

interface FixtureOutput {
  message: string;
  root: string;
  sourceDir: string;
  binDir: string;
}

async function main(): Promise<void> {
  const root = resolveFromRepo(".work", "demo-fixture");
  const sourceDir = path.join(root, "node");
  const binDir = path.join(root, "bin");

  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(binDir, { recursive: true })
  ]);

  await writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "agent-factory-demo-fixture",
        private: true,
        scripts: {
          test: "true"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const proxymockPath = path.join(binDir, "proxymock");
  await writeFile(proxymockPath, "#!/bin/sh\necho proxymock replay ok\n", "utf8");
  await chmod(proxymockPath, 0o755);

  const output: FixtureOutput = {
    message: "created local demo fixture",
    root,
    sourceDir: root,
    binDir
  };

  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed to create fixture";
  console.error(message);
  process.exitCode = 1;
});
