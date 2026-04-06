# Implementation Plan

## Objective

Build a minimal public demo of the autonomous inner loop:

`issue -> plan -> build -> validate`

The first working version does not need full CI/CD. It needs one believable golden path against one simple app.

## Demo Outcome

The first demo is successful when the system can:

1. accept a bug report for a configured app
2. create a machine-readable run record
3. produce a structured plan
4. execute a patch attempt in an isolated workspace
5. run build and validation commands
6. emit artifacts that show what happened

## Work Plan

### Task 1: Define the contracts

Status: complete

Purpose:

- make app onboarding explicit
- define what a run looks like
- define what the planner must output

Deliverables:

- `AgentApp` schema
- `AgentRun` schema
- `AgentPlan` schema
- sample manifests and sample artifacts

Acceptance criteria:

- a new app can be described without changing control-plane code
- a run has explicit states and artifact locations
- the planner output is structured enough for a runner to consume

### Task 2: Scaffold the local control plane

Status: complete

Purpose:

- create the smallest code layout for the first runnable prototype

Deliverables:

- `package.json`
- `tsconfig.json`
- `src/bin/intake-api.ts`
- `src/bin/planner.ts`
- `src/bin/runner.ts`
- `src/bin/validator.ts`
- shared contract types under `src/contracts`

Acceptance criteria:

- repository has runnable Node.js entrypoints
- contract types are shared instead of duplicated
- local development flow is obvious from the repo layout

### Task 3: Implement issue intake

Status: complete

Purpose:

- turn an issue payload into a persisted `AgentRun`

Deliverables:

- local HTTP endpoint or CLI shim for issue submission
- run creation logic
- artifact directory initialization

Acceptance criteria:

- submitting a sample issue creates a valid run record
- the run is linked to an `AgentApp`

### Task 4: Implement planner stub

Status: complete

Purpose:

- produce a deterministic first-pass plan before any real coding agent is added

Deliverables:

- planner input contract
- planner output file
- basic heuristics for target files and validation steps

Acceptance criteria:

- planner emits a valid `AgentPlan`
- planner output includes candidate paths, commands, and validation intent

### Task 5: Implement sandbox runner

Status: complete

Purpose:

- execute the plan inside an isolated workspace

Deliverables:

- workspace creation
- repo clone or worktree setup
- command execution wrapper
- artifact capture for logs and diff

Acceptance criteria:

- runner can execute build commands from `AgentApp`
- runner stores logs and patch output in the run artifacts

### Task 6: Implement proxymock validator

Status: complete

Purpose:

- turn traffic-based validation into a first-class step

Deliverables:

- validator interface
- proxymock command wrapper
- validation result artifact

Acceptance criteria:

- validator runs commands declared by the app contract
- validation result is attached to the run record

### Task 7: Wire the golden path

Status: complete

Purpose:

- connect intake, planner, runner, and validator into one local flow

Deliverables:

- one documented demo path
- one sample app
- one sample issue

Acceptance criteria:

- one command or short sequence can execute the full loop locally
- generated artifacts are understandable without private dependencies

## Current Priority

The initial golden path is complete and now extended with an operational hardening track.

## Operational Hardening Track

### Task 8: Add local run operations and worker claiming

Status: complete

Purpose:

- make local service operation practical for day-to-day use
- prevent duplicate run processing when multiple workers are started

Deliverables:

- run listing and retry operations
- run claim file protocol with stale-claim TTL handling
- updated runbook docs for operator workflows

Acceptance criteria:

- operators can list runs by phase and requeue runs from CLI
- worker instances do not process the same run concurrently

### Task 9: Provide Kubernetes deployment base

Status: complete

Purpose:

- enable early cluster execution with the same intake/worker architecture

Deliverables:

- kustomize base for intake service and worker deployment
- shared persistent storage wiring for artifacts and workspace
- Kubernetes deployment guide

Acceptance criteria:

- manifests apply cleanly to a cluster
- intake endpoint is reachable through service/port-forward
- worker can process runs using shared run/artifact state

### Task 10: Implement distributed queue backend

Status: complete

Purpose:

- remove single-filesystem queue bottleneck before multi-replica worker scaling

Deliverables:

- Redis-backed run queue implementation
- backend selection docs and migration notes
- worker behavior validation for filesystem vs Redis modes

Acceptance criteria:

- workers can consume queued runs via Redis without duplicate processing
- filesystem mode remains a supported local default

### Task 11: Add durable run result summary

Status: complete

Purpose:

- make run outcomes easy to consume by operators and external automation

Deliverables:

- final `result.json` artifact per run
- standardized fields for phase outcome, key commands, and artifact pointers
- docs for using `result.json` in local and Kubernetes operation

Acceptance criteria:

- every completed run has a machine-readable result summary
- operators can determine success/failure without parsing logs

### Task 12: Expose run status via service API

Status: in progress

Purpose:

- allow operators and automation to query run progress without direct filesystem access

Deliverables:

- read-only API endpoints for run list/detail
- optional phase filtering and basic pagination behavior
- documentation updates for local and Kubernetes operation

Acceptance criteria:

- operators can query run state from intake service
- API reflects run phases and artifact pointers consistently
