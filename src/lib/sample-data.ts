import type { AgentPlan, AgentRun } from "../contracts/index.js";

export const sampleRun: AgentRun = {
  apiVersion: "agents.speedscale.io/v1alpha1",
  kind: "AgentRun",
  metadata: {
    name: "run-demo-node-404-status"
  },
  spec: {
    appRef: {
      name: "demo-node"
    },
    issue: {
      id: "bug-404-status",
      title: "Node demo returns 500 instead of upstream 404",
      body: "When the upstream dependency returns 404, the app responds with 500. Preserve the expected client-visible behavior for this path.",
      url: "https://github.com/speedscale/demo/issues/123"
    },
    workspace: {
      root: ".work/run-demo-node-404-status",
      branch: "agent/run-demo-node-404-status"
    }
  },
  status: {
    phase: "queued",
    artifacts: {}
  }
};

export const samplePlan: AgentPlan = {
  apiVersion: "agents.speedscale.io/v1alpha1",
  kind: "AgentPlan",
  metadata: {
    name: "plan-demo-node-404-status"
  },
  spec: {
    runRef: {
      name: "run-demo-node-404-status"
    },
    summary: "Preserve upstream 404 behavior instead of converting it to 500.",
    hypothesis:
      "Error handling in the outbound dependency path is collapsing all upstream failures into a generic internal error.",
    steps: [
      {
        id: "inspect-handler",
        action: "inspect",
        description: "Review the route handler and outbound dependency wrapper.",
        targetPaths: ["node/"]
      },
      {
        id: "edit-error-mapping",
        action: "edit",
        description: "Adjust the error mapping so known upstream 404 responses are preserved.",
        targetPaths: ["node/"]
      },
      {
        id: "build-node",
        action: "build",
        description: "Run the configured test command for the app.",
        command: "npm test"
      },
      {
        id: "validate-traffic",
        action: "validate",
        description: "Replay the captured traffic set against the patched app.",
        command: "proxymock replay"
      }
    ],
    validation: {
      command: "proxymock replay",
      successCriteria: "The replay no longer produces generic 500 responses for the captured 404 path."
    }
  }
};
