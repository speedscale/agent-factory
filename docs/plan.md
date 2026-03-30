# Initial Plan

## Goal

Build a public reference architecture that demonstrates a narrow autonomous developer loop:

`issue -> plan -> build -> validate`

The first version must prove that the system can accept a bug report, produce a plan, make a code change in a sandbox, and validate the fix against replayed traffic with `proxymock`.

## Non-Goals

- full CI/CD design
- production-grade deployment automation
- multi-tenant control plane
- complete support for every app framework

## Guiding Principles

- The app is pluggable.
- The agent is replaceable.
- Validation is evidence-based.
- Every step produces reviewable artifacts.

## Phase 1: Golden Path

Deliver one end-to-end path against one simple public demo app.

### Outputs

- issue intake contract
- `AgentApp` onboarding manifest
- planner output format
- runner lifecycle
- proxymock validation recipe
- artifact model for plan, patch, logs, and replay result

## Phase 2: First Runnable Prototype

Build the smallest working control plane:

- intake API
- planner service
- sandbox runner
- validator
- local state store

The prototype can use a simple queue and worker model. It does not need a full Kubernetes-native orchestration stack on day one.

## Phase 3: App Onboarding

Prove that the system can load multiple apps through configuration rather than custom code.

### Success Criteria

- adding a new app only requires a new manifest
- the runner can clone and operate on the app without bespoke logic
- validation can be configured per app through declared commands

## Phase 4: Public Reference Experience

Package the repository so an external developer can understand:

- what the platform does
- how an app is onboarded
- how the inner loop runs
- where `proxymock` fits

## First Demo Candidate

Start with one simple app from the public demo estate instead of `decoy`.

Selection criteria:

- small codebase
- straightforward startup command
- deterministic bug reproduction
- easy traffic capture and replay

## Initial Deliverables For This Repo

- architecture docs
- onboarding schema
- sample app manifest
- sample issue
- baseline repository conventions
