import * as http from "node:http";
import { createRequire } from "node:module";
import { AgentRunWatcher } from "../lib/controller/agent-run-watcher.js";
import { makeClients } from "../lib/controller/k8s.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

async function main(): Promise<void> {
  const namespace = process.env.AF_WATCH_NAMESPACE || undefined;
  const runRootDir = process.env.AF_RUN_ROOT_DIR || "/app/.work/runs";
  const healthzPort = Number(process.env.AF_HEALTHZ_PORT || "8081");

  console.log(`agent-factory controller v${pkg.version}`);
  console.log(
    namespace
      ? `[controller] scoped to namespace: ${namespace}`
      : "[controller] watching all namespaces (cluster-scoped)",
  );
  console.log(`[controller] run root dir: ${runRootDir}`);

  const clients = makeClients();
  const watcher = new AgentRunWatcher({
    clients,
    runRootDir,
    binaryVersion: pkg.version,
    namespace,
  });

  const healthz = startHealthz(healthzPort);

  const shutdown = (signal: string): void => {
    console.log(`[controller] received ${signal}, shutting down`);
    watcher.stop();
    healthz.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await watcher.start();
}

function startHealthz(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => console.log(`[controller] healthz on :${port}`));
  return server;
}

main().catch((err) => {
  console.error("[controller] fatal:", err);
  process.exit(1);
});
