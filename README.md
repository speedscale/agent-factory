# Agent Factory

Agent Factory is a public reference architecture for an autonomous inner dev loop:

`issue -> plan -> build -> validate`

The goal is simple: take a bug report, generate a plan, attempt a fix in an isolated workspace, and validate the result against recorded traffic with `proxymock`.

This repo is intentionally focused on the tight inner loop, not full CI/CD or production deployment.

The core design keeps three boundaries clear:

- **app**: the target codebase
- **agent**: planning and code execution
- **validation**: replay-based proof

Apps should be onboarded declaratively through a small manifest instead of being hardcoded into the control plane.

The current repo contains the initial design docs and onboarding contract for the first implementation pass.

- [Architecture](docs/architecture.md)
- [Plan](docs/plan.md)
- [Golden Path Demo](docs/demo.md)
- [Sample `AgentApp`](examples/apps/demo-node/agentapp.yaml)
