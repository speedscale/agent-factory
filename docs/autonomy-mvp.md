# Real Ticket Autonomy MVP

Audience: Agent Factory developers and operators evaluating run quality.

This document defines how to run the first real autonomous ticket loop with reviewable evidence.

## Scope

MVP target is one issue on one real repository with this outcome:

`logs/capture discovery -> local repro -> triage -> patch proposal -> replay validation -> PR`

## Ticket intake contract

Required fields:

- repo owner/name
- issue id and URL
- expected behavior
- observed behavior
- impact/scope
- acceptance checks
- validation service bootstrap details when replay requires live service startup
- meaningful build and validation commands (`build.test` and `validate.proxymock.command` cannot be trivial no-op commands like `true` or `:`)
- discovery evidence source (`logs`, `speedscale-capture`, or both)
- capture dataset and request/response summary
- concrete local reproduction steps

Intake payloads should include a top-level `evidence` object so `artifacts/<run>/evidence.json` is pre-populated before planner/runner execution.

Minimum `evidence` keys for real-ticket runs:

- `discovery.source`
- `discovery.notes`
- `reproduction.steps`

Recommended `evidence` keys:

- `capture.dataset`
- `capture.downloadCommand`
- `capture.requestResponseSummary`
- `reproduction.expectedBehavior`
- `reproduction.observedBehavior`
- `suspectedBug`
- `fixSummary`

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
- incident evidence: `evidence.json`
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
2. identify the bug from logs and/or Speedscale capture
3. download capture locally (proxymock dataset) and define repro steps
4. submit run through intake API
5. monitor `/runs` and `/metrics`
6. collect evidence bundle
7. evaluate against pass/fail rubric
8. record operator decision
9. if pass, generate PR from run artifacts via `npm run run-to-pr -- --run <run-name> --repo <repo-path>`
