# Custom Resource Definitions

Three CRDs in the `agents.speedscale.io/v1alpha1` API group:

| CRD            | Purpose |
|----------------|---------|
| `TrafficSource` | Binding to an RRPair store (cluster scope, DLP policy, auth). |
| `AgentApp`      | Declarative onboarding for an application the factory operates on. |
| `AgentRun`      | A single execution of an agent against an app. |

The TypeScript counterparts live in `src/contracts/`:
`traffic-source.ts`, `agent-app.ts`, `agent-run.ts`.

## Install

```bash
kubectl apply -k crds/
```

The Helm chart at `charts/agent-factory/` installs the same CRDs as a chart
hook; use one or the other, not both.

## Schema notes

- `AgentApp` keeps the legacy `build`/`validate`/`quality` shape as
  `x-kubernetes-preserve-unknown-fields: true` so existing v0.1 apps continue
  to validate while the multi-agent fields (`agents`, `trafficSources`,
  `approvers`, `scm`) are adopted.
- `AgentRun.spec.input` and `AgentRun.spec.issue` likewise preserve unknown
  fields — per-agent input shapes are validated at admission against the JSON
  Schemas in `src/agents/*.ts`, not in the CRD itself.
- `TrafficSource` is net-new — no legacy shape to accommodate.
