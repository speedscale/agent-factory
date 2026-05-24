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
import { getInstanceConfig } from "../instance-config.js";
import { createLogger, type Logger } from "../logger.js";
import { AGENTS_API_VERSION, type K8sClients } from "./k8s.js";
import { validateInput } from "./schema-validator.js";
import { patchAgentRunStatus } from "./status-updater.js";
import {
  buildBaseRecord,
  recordAgentRun,
  type AgentRunRecord,
  type AgentRunTransition,
} from "../agent-run-recorder.js";
import { materializeTrafficSources } from "../traffic-materializer.js";

export interface DispatcherOptions {
  clients: K8sClients;
  runRootDir: string;
  binaryVersion: string;
  /**
   * Structured base logger. Defaults to a controller-scoped logger seeded
   * with the current AF_INSTANCE so every dispatch line carries `instance`
   * automatically. Override for tests.
   */
  logger?: Logger;
}

export async function dispatchAgentRun(
  run: AgentRun,
  opts: DispatcherOptions,
): Promise<void> {
  const namespace = (run.metadata as { namespace?: string }).namespace ?? "default";
  const runName = run.metadata.name;
  const baseLogger =
    opts.logger ??
    createLogger({
      component: "controller",
      fields: { instance: getInstanceConfig().instance },
    });
  // Per-run child logger: every line emitted by this dispatch carries
  // run_id, namespace, agent_app, and (once known) agent. The Loki panel
  // filter on $run_id keys off these fields.
  const runLogger = baseLogger.child({
    run_id: runName,
    namespace,
    agent_app: run.spec.appRef?.name,
    agent: run.spec.agent,
  });
  const logger = adaptAgentLogger(runLogger);

  runLogger.info("dispatch start", { phase: run.status?.phase });

  if (!run.spec.agent) {
    await fail(opts, namespace, runName, "MissingAgent", "spec.agent is required", runLogger);
    return;
  }

  let agent;
  try {
    agent = getAgent(run.spec.agent);
  } catch (err) {
    await fail(opts, namespace, runName, "UnknownAgent", String(err), runLogger);
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
      runLogger,
    );
    return;
  }

  let app: AgentApp;
  try {
    app = await loadAgentApp(opts.clients, namespace, run.spec.appRef.name);
  } catch (err) {
    await fail(opts, namespace, runName, "AppRefUnresolved", String(err), runLogger);
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
      runLogger,
    );
    return;
  }

  let trafficSources: TrafficSource[];
  try {
    trafficSources = await loadTrafficSources(opts.clients, namespace, app);
  } catch (err) {
    await fail(opts, namespace, runName, "TrafficSourceUnresolved", String(err), runLogger);
    return;
  }

  const transitions: AgentRunTransition[] = [];
  const recordTransition = (phase: string) => {
    transitions.push({ phase, ts: new Date().toISOString() });
  };
  recordTransition("planned");

  await patchAgentRunStatus(opts.clients, namespace, runName, {
    phase: "planned",
    summary: `dispatching ${run.spec.agent}`,
    conditions: [okCondition("Validated", "InputValid")],
  });
  runLogger.info("status patch", { phase: "planned" });

  const runDir = path.join(opts.runRootDir, namespace, runName);
  await fs.mkdir(runDir, { recursive: true });

  // Materialise remote TrafficSources (e.g. kind=loki) into local snapshot
  // directories before the agent runs. Non-loki sources are passed through
  // unchanged.  Failures here are surfaced as a terminal run error so
  // operators see a clear "loki-gather failed" message rather than a silent
  // agent failure.
  let materializedSources: TrafficSource[];
  try {
    materializedSources = await materializeTrafficSources(trafficSources, {
      runDir,
      logger,
      namespace,
      readSecret: (ns, name, key) =>
        readK8sSecretValue(opts.clients, ns, name, key),
    });
  } catch (err) {
    await fail(opts, namespace, runName, "TrafficSourceMaterializationFailed", String(err), runLogger);
    return;
  }

  const ctx: AgentRunContext = {
    app,
    run,
    trafficSources: materializedSources,
    runDir,
    logger,
  };

  recordTransition("generating");
  await patchAgentRunStatus(opts.clients, namespace, runName, {
    phase: "generating",
    conditions: [okCondition("Dispatched", "Running")],
  });
  runLogger.info("status patch", { phase: "generating" });

  const startedAt = Date.now();
  try {
    const output = await agent.run(run.spec.input ?? {}, ctx);
    recordTransition("succeeded");
    await patchAgentRunStatus(opts.clients, namespace, runName, {
      phase: "succeeded",
      summary: output.summary,
      artifacts: output.artifacts,
      conditions: [okCondition("Succeeded", "AgentReturned")],
    });
    runLogger.info("dispatch complete", { phase: "succeeded", summary: output.summary });
    // Persist the full trace. Best-effort: recordAgentRun never throws.
    // For triage, hydrate parsed verdict from the on-disk artifact so
    // the archive has the structured outcome even without invading the
    // triage agent body to thread it through directly.
    await persistRecord({
      run,
      runDir,
      output,
      transitions,
      totalMs: Date.now() - startedAt,
      runLogger,
    });
  } catch (err) {
    const reason = err instanceof AgentNotImplementedError ? "AgentNotImplemented" : "AgentError";
    recordTransition("failed");
    await fail(opts, namespace, runName, reason, String(err), runLogger);
    await persistRecord({
      run,
      runDir,
      output: undefined,
      transitions,
      totalMs: Date.now() - startedAt,
      runLogger,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface PersistArgs {
  run: AgentRun;
  runDir: string;
  output: { summary?: string; artifacts?: Record<string, string> } | undefined;
  transitions: AgentRunTransition[];
  totalMs: number;
  runLogger: Logger;
  error?: string;
}

async function persistRecord(args: PersistArgs): Promise<void> {
  const record: AgentRunRecord = {
    ...buildBaseRecord(args.run),
    transitions: args.transitions,
    timings: { totalMs: args.totalMs },
    postedComment: args.output?.summary,
    extra: args.error ? { error: args.error } : undefined,
  };

  // Hydrate parsed verdict from the triage artifact if present. This is
  // the cleanest way to capture the structured outcome without modifying
  // the triage agent body (which is owned by a parallel engine-plumbing
  // change-set). TODO: once the engine plumbing PR lands, thread the raw
  // model response + prompts through AgentRunOutput so this read isn't
  // needed and rawResponse becomes available on the record.
  const triageArtifact = args.output?.artifacts?.triage;
  if (triageArtifact) {
    try {
      const abs = path.join(args.runDir, triageArtifact);
      const buf = await fs.readFile(abs, "utf8");
      const parsed = JSON.parse(buf) as Record<string, unknown>;
      record.parsed = parsed;
    } catch (err) {
      args.runLogger.warn("could not read triage artifact for recorder", {
        artifact: triageArtifact,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await recordAgentRun(record, { logger: args.runLogger });
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
  logger?: Logger,
): Promise<void> {
  logger?.error("dispatch failed", { reason, message });
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

/**
 * Bridge the structured `Logger` interface to the `AgentLogger` interface
 * agents see via `ctx.logger`. Agents are decoupled from the JSON
 * formatter — they only see `{info, warn, error}` — but every line they
 * emit still carries the per-run fields (`run_id`, `agent_app`, etc.)
 * because we hand them a child logger that already has them bound.
 */
function adaptAgentLogger(runLogger: Logger): AgentLogger {
  return {
    info: (msg, fields) => runLogger.info(msg, fields),
    warn: (msg, fields) => runLogger.warn(msg, fields),
    error: (msg, fields) => runLogger.error(msg, fields),
  };
}

/**
 * Read a single key from a Kubernetes Secret and return its decoded string
 * value. Throws if the secret or key does not exist.
 */
async function readK8sSecretValue(
  clients: K8sClients,
  namespace: string,
  name: string,
  key: string,
): Promise<string> {
  const obj = await clients.objects.read({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace },
  });
  // k8s Secret data values are base64-encoded strings.
  const data = (obj as unknown as { data?: Record<string, string> }).data ?? {};
  if (!(key in data)) {
    throw new Error(`Secret "${name}" in namespace "${namespace}" has no key "${key}"`);
  }
  return Buffer.from(data[key], "base64").toString("utf8");
}
