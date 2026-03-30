# Agent Factory

Agent Factory is a public reference architecture for an autonomous inner dev loop:

`issue -> plan -> build -> validate`

The goal is to show how an AI agent can pick up a bug report, generate a concrete plan, make a code change in an isolated workspace, and validate the result against recorded traffic using `proxymock`.

## Scope

This repository focuses on the tight inner loop only:

- issue intake
- planning
- sandboxed code execution
- traffic-based validation

It does not try to solve full CI/CD, release management, or production operations in the first version.

## Core Ideas

Agent Factory separates the system into three planes:

- **App plane**: the target repository being changed
- **Agent plane**: intake, planning, orchestration, and code generation
- **Validation plane**: replay-based proof that the change worked

The app should be onboarded declaratively through a small manifest, similar in spirit to how Argo CD loads applications from configuration instead of hardcoding them into the control plane.

## Planned Flow

1. An issue is submitted to a target application.
2. Agent Factory triages the issue and produces a machine-readable plan.
3. A sandboxed runner clones the app repo and attempts the fix.
4. The proposed fix is validated with `proxymock` against recorded traffic.
5. The run produces artifacts that can be reviewed by a human or used to open an MR.

## Repository Layout

```text
.
├── AGENTS.md
├── docs/
│   ├── architecture.md
│   └── plan.md
├── examples/
│   ├── apps/
│   │   └── demo-node/
│   │       └── agentapp.yaml
│   └── issues/
│       └── sample-bug.md
└── schemas/
    └── agentapp.schema.yaml
```

## First Milestone

The first believable milestone is:

- target one simple public demo app
- submit one realistic bug
- generate a plan
- produce a patch in an isolated workspace
- validate the patch with `proxymock`
- emit reviewable evidence

## Status

This repository currently contains the initial design documents and onboarding contract for the first implementation pass.

See [docs/plan.md](docs/plan.md) for the phased buildout plan and [docs/architecture.md](docs/architecture.md) for the reference design.
