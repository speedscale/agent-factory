# agent-factory Helm chart

Installs the Speedscale Agent Factory and its three CRDs
(`TrafficSource`, `AgentApp`, `AgentRun`) into a Kubernetes cluster.

## Install

```bash
helm install agent-factory ./charts/agent-factory \
  --namespace agent-factory --create-namespace \
  --values ./examples/instances/internal/values/base.yaml
```

The chart's `crds/` directory installs the three CRDs before any template
renders (standard Helm behaviour). If you've already installed CRDs from
the repo-level `crds/` directory, Helm leaves them in place.

## Values overview

| Key | Default | Purpose |
|---|---|---|
| `sizing` | `medium` | `small` / `medium` / `ha` — guides default replica/resource shapes. |
| `image.repository` | `ghcr.io/speedscale/agent-factory` | Container image. |
| `engine.kind` | `claude-sdk` | LLM backend: `claude-sdk`, `generic-llm`, `private-llm`. |
| `engine.model` | `claude-opus-4-7` | Model identifier. |
| `engine.authSecret` | `anthropic-api-key/token` | Secret holding the LLM API key. Chart never reads the value. |
| `trafficSources` | `[]` | List of `TrafficSource` CRs to install. Omit to manage out-of-band via GitOps. |
| `agentDefaults` | seven defaults | Per-agent enablement; apps override via `AgentApp.spec.agents`. |
| `intakeApi.replicas` | `2` | HTTP intake replicas. |
| `worker.replicas` | `2` | Worker replicas. |
| `persistence.size` | `10Gi` | PVC size for run artifacts. |

See `values.yaml` for the full surface.

## Per-instance values

Example values files for the four instance flavors live in
`examples/instances/` at the repo root:

- `examples/instances/internal/` — Speedscale internal dogfood install
- `examples/instances/customer/` — template for customer BYOC installs
- `examples/instances/demo/` — public demo with frozen sample data
- `examples/instances/local/` — local CLI mode (no chart needed)

## Sizing profiles

`sizing` is currently advisory — defaults match `medium`. A future revision
will introduce profile-specific overlays (smaller PVC + 1 replica for
`small`, anti-affinity + PDB for `ha`).

## Engine secret

The chart references `engine.authSecret.{name,key}` but does not create
the secret. Install it separately:

```bash
kubectl create secret generic anthropic-api-key \
  --namespace agent-factory \
  --from-literal=token=$ANTHROPIC_API_KEY
```

For air-gapped or self-hosted-LLM installs, set `engine.kind=private-llm`
and point `engine.endpoint` at the internal model serving endpoint; the
chart wiring is identical.
