# Agent Factory

Agent Factory runs a complete software-delivery loop — **Spec → Generate → Validate → Deploy → Observe** — driven by an LLM grounded in real captured traffic. Every fix is validated against production RRPairs via `proxymock` before a human approves it.

## What it does

1. **Spec** — ingests an issue, alert, or PR; pulls a snapshot of captured traffic; identifies the measurable metric the bug violates; confirms the bug is reproducible.
2. **Generate** — LLM reads the relevant source files and writes a minimal fix.
3. **Validate** — runs the same reproduce harness against the patched code to confirm the metric is within bound; runs regression replay via proxymock.
4. **Deploy** — opens a PR/MR with the fix, harness output, and quality report as evidence.
5. **Observe** — post-deploy snapshot comparison closes the loop.

## Deployment models

| | Speedscale Cloud | Customer BYOC |
|---|---|---|
| Traffic data | Speedscale-hosted | Customer's proxymock BYOC |
| LLM endpoint | Anthropic (Speedscale key) | Customer's choice (Anthropic, Bedrock, Azure, self-hosted) |
| Code access | Speedscale's repos | Customer's git mirror |
| Deployment | Speedscale-operated | Helm chart in customer's cluster |
| Data boundary | Speedscale VPC | Customer VPC — data never leaves |

## Quick start — LLM fix loop

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

Artifacts land in `--workdir`: `plan.json` (Planner output), `reproduce.mjs`, `confirm.mjs`, `patch.json`.

## Quick start — validation loop only

Run the existing quality baseline → regression → recovery demo:

```bash
npm install
npm run loop-demo
```

Check gate verdict for a specific run:

```bash
npm run gate:check -- --run <run-name>
```

## Documentation

- **[docs/architecture.md](docs/architecture.md)** — full system design, planes, deployment models
- **[docs/engine.md](docs/engine.md)** — LLM engine: tool catalog, agent loop, Planner/Worker phases
- **[docs/engine-hardening.md](docs/engine-hardening.md)** — tool-call hardening: rescue, escalating nudges, prereqs, compaction, error classification
- **[docs/plan.md](docs/plan.md)** — active roadmap and next steps
- **[docs/users.md](docs/users.md)** — operators: deployment, run submission, operations
- **[docs/developers.md](docs/developers.md)** — contributors: development workflow, contracts, release

## Core artifacts per run

| Artifact | Description |
|---|---|
| `plan.json` | Planner output: metric, baseline, hypothesis, target file |
| `reproduce.mjs` | Self-contained harness measuring the bug metric on unpatched code |
| `confirm.mjs` | Same harness run against patched code — the primary fix gate |
| `patch.json` | Worker output: fix, rationale, confirm result |
| `quality-report.json/.md` | Regression replay diff against baseline RRPairs |
| `result.json` | Run summary with phase outcomes |
