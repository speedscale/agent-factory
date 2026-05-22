import * as https from "node:https";
import { URL } from "node:url";
import type { AgentRun, AgentRunPhase } from "../../contracts/index.js";
import { AGENTS_GROUP, AGENTS_VERSION, type K8sClients } from "./k8s.js";

// CustomObjectsApi.patchNamespacedCustomObjectStatus picks
// `application/json-patch+json` as its default Content-Type (first entry in
// the OpenAPI `consumes:` list). That format expects a list of operations,
// not a merge document — so a merge-shaped body is silently rejected by
// the API server, leaving the status field unchanged. Hand-roll the
// HTTPS request via Node's https module so we can pin Content-Type to
// application/merge-patch+json. Global fetch can't be used here because
// `kc.applyToFetchOptions()` returns an undici-style dispatcher that
// Node's built-in fetch doesn't honor.

export interface StatusCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface AgentRunStatusPatch {
  phase?: AgentRunPhase;
  summary?: string;
  lastTransitionAt?: string;
  artifacts?: Record<string, string>;
  conditions?: StatusCondition[];
}

export async function patchAgentRunStatus(
  clients: K8sClients,
  namespace: string,
  name: string,
  status: AgentRunStatusPatch,
): Promise<void> {
  const body = {
    status: {
      ...status,
      lastTransitionAt: status.lastTransitionAt ?? new Date().toISOString(),
    },
  };
  const cluster = clients.kc.getCurrentCluster();
  if (!cluster) throw new Error("no current k8s cluster configured");
  const path = `/apis/${AGENTS_GROUP}/${AGENTS_VERSION}/namespaces/${encodeURIComponent(namespace)}/agentruns/${encodeURIComponent(name)}/status?fieldManager=agent-factory-controller`;
  const url = new URL(cluster.server.replace(/\/+$/, "") + path);
  const payload = JSON.stringify(body);

  // applyToHTTPSOptions decorates with CA bundle + client cert + bearer
  // header in-place. Result is a plain Node https.RequestOptions.
  const opts: https.RequestOptions = {
    method: "PATCH",
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    headers: {
      "Content-Type": "application/merge-patch+json",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(payload).toString(),
    },
  };
  await clients.kc.applyToHTTPSOptions(opts);

  await new Promise<void>((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let chunks = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { chunks += c; });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return resolve();
        reject(new Error(`patchAgentRunStatus ${status} ${res.statusMessage ?? ""}: ${chunks.slice(0, 300)}`));
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export function isTerminalPhase(phase: AgentRunPhase | undefined): boolean {
  return phase === "succeeded" || phase === "failed";
}

export function isInProgressPhase(phase: AgentRunPhase | undefined): boolean {
  if (!phase) return false;
  return ["planned", "building", "validating", "generating", "deploying", "reporting"].includes(
    phase,
  );
}

export function summarizeForStatus(run: AgentRun): string {
  const agent = run.spec.agent ?? "(no agent)";
  const app = run.spec.appRef.name;
  return `${agent} on ${app}`;
}
