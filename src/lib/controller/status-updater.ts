import { PatchStrategy } from "@kubernetes/client-node";
import type { AgentRun, AgentRunPhase } from "../../contracts/index.js";
import { AGENTS_API_VERSION, type K8sClients } from "./k8s.js";

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
    apiVersion: AGENTS_API_VERSION,
    kind: "AgentRun",
    metadata: { name, namespace },
    status: {
      ...status,
      lastTransitionAt: status.lastTransitionAt ?? new Date().toISOString(),
    },
  };
  await clients.objects.patch(
    body,
    undefined,
    undefined,
    "agent-factory-controller",
    undefined,
    PatchStrategy.MergePatch,
  );
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
