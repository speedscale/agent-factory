# Agent Factory Developer Guide

This guide is for contributors who change Agent Factory itself.

## Design Boundaries

Keep these planes explicit:

- **app plane:** target repository and workload behavior
- **agent plane:** request handling, scope selection, quality orchestration
- **validation plane:** replay/capture evidence and pass/fail signal

The goal is trustworthy autonomy, not hidden magic.

## Source of Truth Documents

- architecture details: `docs/architecture.md`
- roadmap and current priorities: `docs/plan.md`
- autonomy contract and rubric: `docs/autonomy-mvp.md`
- run record and operator outcomes: `docs/phase-b-first-run.md`
- implementation history: `docs/history.md`
- release process: `docs/release.md`

## Core Contracts to Preserve

- `AgentApp`: app + repo + baseline target scope + quality policy
- `AgentRun`: lifecycle state, request trigger context, baseline target, artifacts
- artifact set per run: `baseline.json`, `quality-report.json`, `quality-report.md`, `build.log`, `validation.log`, `evidence.json`, `result.json`

## Development Workflow

```bash
npm install
npm run check
npm run demo
```

For service-mode checks:

```bash
npm run intake-api
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture --once
```

Manual stage debugging (when investigating a specific run):

```bash
npm run planner -- --run <run-name>
npm run runner -- --run <run-name> --source .work/demo-fixture
PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run validator -- --run <run-name>
```

## Contribution Expectations

- keep app/agent/validation boundaries clear
- prefer explicit contracts over implicit coupling
- preserve artifact-first evidence for operator decisions
- avoid introducing private/internal dependencies
- update docs when behavior changes
- do not bump `package.json` in normal PRs; CI bumps version on merge to `main`

## Agent Instruction Resolution Across Repos

When Agent Factory drives changes in a target repo, read and apply both instruction sets:

- `agent-factory/AGENTS.md`
- `<target-repo>/AGENTS.md`

Rule precedence:

1. stricter constraint wins when both can be satisfied
2. if constraints conflict, stop and request operator direction

## Release Expectations

Use `docs/release.md` checklist:

- version/tag selected
- build + checks pass
- image published and pinned
- deploy manifests updated to release tag
- post-deploy health/run/metrics verification completed
