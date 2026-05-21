# Agent Factory User Guide

This guide is for operators and integrators who run Agent Factory.

## What Agent Factory Does

Agent Factory executes the **Spec → Generate → Validate → Deploy → Observe** loop, driven by an LLM grounded in real captured traffic (RRPairs via proxymock). Every fix is validated against production evidence before a human approves it.

## Quick start — local LLM fix loop

```bash
npm install
export ANTHROPIC_API_KEY=<your-key>

npm run llm-run -- \
  --title "Service X returning 429 errors on /api/sync" \
  --body  "Errors cluster in short bursts suggesting a concurrency problem." \
  --snapshot /path/to/snapshot/inner-dir \
  --source  /path/to/service/src \
  --workdir /tmp/llm-run-work \
  --verbose
```

Artifacts land in `--workdir`: `plan.json`, `reproduce.mjs`, `confirm.mjs`, `patch.json`.

## Cluster deployment — Helm

Install via the Helm chart at `charts/agent-factory/`. Sample values per flavor live in `examples/instances/`:

- `examples/instances/internal/` — Speedscale internal dogfood install
- `examples/instances/customer/` — template for customer BYOC installs
- `examples/instances/demo/` — public demo with frozen sample data
- `examples/instances/local/` — local CLI mode (no chart needed)

```bash
helm install agent-factory ./charts/agent-factory \
  --values ./examples/instances/internal/values/base.yaml
```

See `charts/agent-factory/README.md` for full chart options and CRDs.

## CRDs

Agent Factory installs three CustomResourceDefinitions (see `crds/`):

- `TrafficSource` — binding to an RRPair store (cluster scope, DLP policy, auth)
- `AgentApp` — service manifest (repo, build, validate, engine config, quality policy)
- `AgentRun` — lifecycle state and artifact pointers

## Required Evidence Quality

For real PR requests, treat successful command execution as necessary but not sufficient.

- include request context (PR URL/sha or manual request metadata)
- keep environment scope explicit (local vs staging/cluster)
- provide endpoint-level replay outcomes when performance is in scope
- keep `build.test` and `validate.proxymock.command` meaningful (no no-op placeholders)
- ensure baseline artifacts are current for each onboarded quality target
- ensure GitHub bot auth is configured so PR quality comments can be posted/updated

## Operational Baselines

- queue depth should stay near 0 in steady state
- failed-run ratio should stay below 10%
- rising queue depth or persistent failures means scale/tune workers and inspect `result.json`

## Where to Go Deeper

- LLM engine internals: `docs/engine.md`
- metrics/remediation playbook: `docs/operations.md`
- roadmap: `docs/plan.md`
