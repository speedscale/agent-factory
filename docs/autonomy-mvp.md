# Real Ticket Autonomy MVP

This document defines how to run the first real autonomous ticket loop with reviewable evidence.

## Scope

MVP target is one issue on one real repository with this outcome:

`selected issue -> triage -> patch proposal -> build+validate evidence -> operator decision`

## Ticket intake contract

Required fields:

- repo owner/name
- issue id and URL
- expected behavior
- observed behavior
- impact/scope
- acceptance checks
- validation service bootstrap details when replay requires live service startup

Recommended labels:

- `agent-ready`
- `bug`
- `validation-required`

## Pass/fail rubric

Treat the run as **pass** only when all are true:

1. triage artifact includes concrete root-cause hypothesis
2. patch proposal is scoped to ticket acceptance criteria
3. build/test command passes
4. validation command passes
5. `result.json` clearly maps evidence to the ticket

Treat the run as **fail** when any criterion is missing or contradictory.

## Evidence bundle required for review

- run record: `run.json`
- triage artifact: `triage.json`
- plan: `plan.yaml`
- patch summary: `patch.diff`
- build evidence: `build.log`
- validation evidence: `validation.log`
- terminal summary: `result.json`

## Operator decision protocol

Approve only if:

- ticket acceptance checks are directly satisfied by evidence
- no unrelated risky changes are included
- failure modes are understood if partial behavior changed

Reject and rerun if:

- evidence is incomplete
- validation does not match ticket expectations
- changes exceed ticket scope

## First live run checklist

1. choose one `agent-ready` bug issue
2. submit run through intake API
3. monitor `/runs` and `/metrics`
4. collect evidence bundle
5. evaluate against pass/fail rubric
6. record operator decision
7. if pass, generate PR from run artifacts via `npm run run-to-pr -- --run <run-name> --repo <repo-path>`
