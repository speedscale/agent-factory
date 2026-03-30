# Repository Guidelines

## Purpose

This repository is a public reference architecture for an autonomous issue-to-fix workflow centered on the inner loop:

`issue -> plan -> build -> validate`

Keep changes aligned with that goal. Prefer small, explicit contracts over broad platform abstractions.

## Design Rules

- Keep the boundary between app, agent, and validation planes explicit.
- Do not introduce private Speedscale repository dependencies.
- Prefer doc-first changes until the first runnable golden path is clearly defined.
- Treat `proxymock` validation as evidence, not as an optional extra.
- Favor portable examples that can be understood by external users.

## Initial Implementation Direction

- The first implementation should target one simple demo application.
- The agent should operate against an app manifest rather than hardcoded repo logic.
- The initial system should emit artifacts for every step: triage, plan, patch, build logs, validation result.

## Repository Conventions

- Put reference docs in `docs/`.
- Put sample onboarding manifests in `examples/apps/`.
- Put user-facing examples and sample issues in `examples/issues/`.
- Put schemas and machine-readable contracts in `schemas/`.

## Out of Scope For Early Commits

- full production CI/CD design
- multi-cluster deployment automation
- private internal integrations
- broad framework experiments without a clear role in the inner loop
