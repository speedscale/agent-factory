# Reference Architecture

## Overview

Agent Factory is designed around a tight autonomous inner loop:

`issue -> plan -> build -> validate`

The system should operate on arbitrary onboarded applications by reading a declarative app manifest instead of encoding app-specific behavior in the control plane.

## Planes

### App Plane

The app plane contains:

- application source code
- tests
- build commands
- runtime manifests
- an onboarding manifest that tells Agent Factory how to work with the app

The app plane must not contain agent orchestration logic.

### Agent Plane

The agent plane contains:

- issue intake
- triage
- planning
- sandbox execution
- run state tracking
- artifact collection

The agent plane decides what to try, but it does not define whether a fix is valid.

### Validation Plane

The validation plane contains:

- replay datasets
- mock configuration
- replay execution
- result reporting

The validation plane is the evidence layer. It should answer whether the proposed fix behaved correctly against known traffic.

## Control Flow

1. Intake receives an issue and creates a run.
2. Planner produces a structured plan.
3. Runner creates an isolated workspace for the target app.
4. Runner applies a patch and executes declared build and test commands.
5. Validator runs `proxymock`-based validation against the patched app.
6. The system stores artifacts and marks the run as passed or failed.

## Key Contracts

### AgentApp

Each target app is represented by a manifest that declares:

- repository location
- working directory
- build and test commands
- startup command
- proxymock validation inputs
- policy flags

### Run Artifacts

Each run should emit:

- normalized issue summary
- plan document
- patch or diff
- build and test logs
- validation logs
- final decision summary

## Design Constraints

- apps must be loadable without changing the control plane
- runner environments must be isolated
- validation must be replay-based where possible
- private internal dependencies should not be required for the public demo
