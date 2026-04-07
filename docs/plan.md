# Execution Plan

## Goal

Operate Agent Factory as an autonomous software factory that can reliably run:

`issue -> triage -> patch -> validate -> report`

against real repositories in local and Kubernetes environments.

## Where We Are

The platform is runnable now and has strong infrastructure fundamentals:

- intake + worker service model
- queue backends (filesystem + Redis)
- artifact model including terminal `result.json`
- status and metrics endpoints
- local/compose/k8s deployment paths
- optional token auth for intake APIs

## Gap To Full Autonomous Factory

The biggest remaining gap is not infrastructure, it is autonomous issue-to-fix execution quality.

Priority gaps:

1. deterministic packaging/release process (pinned deploy versions)
2. first real autonomous ticket loop on a real target repo
3. stronger failure classification and retry policy
4. policy and safety controls for automated change proposals
5. operational confidence gates for scaling and incident response

## Active Roadmap

### Phase A: Packaging and Release Hardening

Status: complete

Objective:

- make deployments repeatable, versioned, and easy to roll back

Deliverables:

- pinned image tags in compose and Kubernetes examples
- release checklist (`build`, smoke, docs sync, branch hygiene)
- versioning guidance for manifests and runtime images

Exit criteria:

- no `:latest` requirement for standard deployment path
- operators can deploy a known version by tag/digest

### Phase B: Real Ticket Autonomy (MVP)

Status: in progress

Objective:

- run one end-to-end real issue from intake through validated result on a real app

Deliverables:

- issue selection contract (labels/template)
- triage output shape with root-cause hypothesis
- patch proposal flow with reproducible validation evidence
- operator pass/fail rubric and first-live-run checklist

Exit criteria:

- one ticket can be completed autonomously with operator review and merge
- evidence is sufficient to decide accept/reject without manual log spelunking

### Phase C: Reliability and Recovery

Status: pending

Objective:

- make long-running operation resilient under failures and restarts

Deliverables:

- explicit failure taxonomy (`queue`, `build`, `validate`, `policy`, `infra`)
- retry/backoff policy per failure class
- stale run recovery behavior and idempotent replay guardrails

Exit criteria:

- repeated transient failures recover automatically
- operators can identify failure class from API and result artifacts directly

### Phase D: Policy and Safety Controls

Status: pending

Objective:

- enforce safe automation boundaries before broader rollout

Deliverables:

- policy profile for allowed repos/branches/commands
- approval gates for high-risk actions
- immutable audit trail for run decisions

Exit criteria:

- unauthorized or unsafe actions are blocked by policy
- every automated decision has traceable evidence

## Immediate Next Actions

1. define runtime dependency bootstrap profile for `speedscale/microsvc#58` validation
2. implement dependency startup hooks before service bootstrap
3. re-run first live ticket and complete operator decision record in `docs/phase-b-first-run.md`

## Notes

- Historical completed work is tracked in `docs/history.md`.
- `docs/architecture.md` remains the source of truth for system shape.
- Phase B execution details and rubric are tracked in `docs/autonomy-mvp.md`.
- first live run target and decision template are tracked in `docs/phase-b-first-run.md`.
