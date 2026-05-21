import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getAgent } from "../../agents/index.js";
import { AgentNotImplementedError } from "../../agents/types.js";
import type { AgentLogger, AgentRunContext } from "../../agents/types.js";
import type {
  AgentApp,
  AgentRun,
  TrafficSource,
} from "../../contracts/index.js";
import { AGENTS_API_VERSION, type K8sClients } from "./k8s.js";
import { validateInput } from "./schema-validator.js";
import { patchAgentRunStatus } from "./status-updater.js";

export interface DispatcherOptions {
  clients: K8sClients;
  runRootDir: string;
  binaryVersion: string;
}

export async function dispatchAgentRun(
  run: AgentRun,
  opts: DispatcherOptions,
): Promise<void> {
  const namespace = (run.metadata as { namespace?: string }).namespace ?? "default";
  const runName = run.metadata.name;
  const logger = makeLogger(runName);

  if (!run.spec.agent) {
    await fail(opts, namespace, runName, "MissingAgent", "spec.agent is required");
    return;
  }

  let agent;
  try {
    agent = getAgent(run.spec.agent);
  } catch (err) {
    await fail(opts, namespace, runName, "UnknownAgent", String(err));
    return;
  }

  const validation = validateInput(agent.inputSchema, run.spec.input ?? {});
  if (!validation.valid) {
    await fail(
      opts,
      namespace,
      runName,
      "InvalidInput",
      `input validation failed: ${(validation.errors ?? []).join("; ")}`,
    );
    return;
  }

  let app: AgentApp;
  try {
    app = await loadAgentApp(opts.clients, namespace, run.spec.appRef.name);
  } catch (err) {
    await fail(opts, namespace, runName, "AppRefUnresolved", String(err));
    return;
  }

  const enablement = app.spec.agents?.[run.spec.agent];
  if (!enablement?.enabled) {
    await fail(
      opts,
      namespace,
      runName,
      "AgentNotEnabled",
      `agent ${run.spec.agent} is not enabled on AgentApp ${app.metadata.name}`,
    );
    return;
  }

  let trafficSources: TrafficSource[];
  try {
    trafficSources = await loadTrafficSources(opts.clients, namespace, app);
  } catch (err) {
    await fail(opts, namespace, runName, "TrafficSourceUnresolved", String(err));
    return;
  }

  await patchAgentRunStatus(opts.clients, namespace, runName, {
    phase: "planned",
    summary: `dispatching ${run.spec.agent}`,
    conditions: [okCondition("Validated", "InputValid")],
  });

  const runDir = path.join(opts.runRootDir, namespace, runName);
  await fs.mkdir(runDir, { recursive: true });

  const ctx: AgentRunContext = {
    app,
    run,
    trafficSources,
    runDir,
    logger,
  };

  await patchAgentRunStatus(opts.clients, namespace, runName, {
    phase: "generating",
    conditions: [okCondition("Dispatched", "Running")],
  });

  try {
    const output = await agent.run(run.spec.input ?? {}, ctx);
    await patchAgentRunStatus(opts.clients, namespace, runName, {
      phase: "succeeded",
      summary: output.summary,
      artifacts: output.artifacts,
      conditions: [okCondition("Succeeded", "AgentReturned")],
    });
  } catch (err) {
    const reason = err instanceof AgentNotImplementedError ? "AgentNotImplemented" : "AgentError";
    await fail(opts, namespace, runName, reason, String(err));
  }
}

async function loadAgentApp(
  clients: K8sClients,
  namespace: string,
  name: string,
): Promise<AgentApp> {
  const obj = await clients.objects.read({
    apiVersion: AGENTS_API_VERSION,
    kind: "AgentApp",
    metadata: { name, namespace },
  });
  return obj as unknown as AgentApp;
}

async function loadTrafficSources(
  clients: K8sClients,
  namespace: string,
  app: AgentApp,
): Promise<TrafficSource[]> {
  const refs = app.spec.trafficSources ?? [];
  const out: TrafficSource[] = [];
  for (const ref of refs) {
    const obj = await clients.objects.read({
      apiVersion: AGENTS_API_VERSION,
      kind: "TrafficSource",
      metadata: { name: ref.name, namespace },
    });
    out.push(obj as unknown as TrafficSource);
  }
  return out;
}

async function fail(
  opts: DispatcherOptions,
  namespace: string,
  name: string,
  reason: string,
  message: string,
): Promise<void> {
  await patchAgentRunStatus(opts.clients, namespace, name, {
    phase: "failed",
    summary: `${reason}: ${message}`,
    conditions: [
      {
        type: "Failed",
        status: "True",
        reason,
        message,
        lastTransitionTime: new Date().toISOString(),
      },
    ],
  });
}

function okCondition(type: string, reason: string): {
  type: string;
  status: "True";
  reason: string;
  lastTransitionTime: string;
} {
  return {
    type,
    status: "True",
    reason,
    lastTransitionTime: new Date().toISOString(),
  };
}

function makeLogger(runName: string): AgentLogger {
  const prefix = `[run=${runName}]`;
  return {
    info: (msg, fields) => console.log(prefix, msg, fields ? JSON.stringify(fields) : ""),
    warn: (msg, fields) => console.warn(prefix, msg, fields ? JSON.stringify(fields) : ""),
    error: (msg, fields) => console.error(prefix, msg, fields ? JSON.stringify(fields) : ""),
  };
}
