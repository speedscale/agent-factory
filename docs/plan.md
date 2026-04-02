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

Status: next

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

Status: pending

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

Task 6 is the next implementation step.
