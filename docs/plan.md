# Execution Plan

Audience: Agent Factory developers/contributors.

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

1. execute one microsvc ticket with logs/capture/repro evidence populated in `evidence.json`
2. require endpoint-level performance evidence from Speedscale snapshot/capture before posting benchmark claims
3. run replay in the intended target environment (local vs staging cluster must be explicit in artifacts and issue comments)
4. deploy the queue-drain Job runtime profile (`examples/deploy/kubernetes/overlays/job-runtime`) and verify run completion with TTL cleanup
5. wire GitHub + Slack intake relays to canonical ticket intake shape (`schemas/ticket-intake.schema.yaml`)
6. record operator decision against full autonomy rubric in `docs/phase-b-first-run.md`, including explicit next action

## Performance Research Standard (Within Reason)

When a ticket is performance-oriented (CPU/latency/load), treat completion as research + evidence, not just command success.

Minimum evidence package:

- source of traffic data: Speedscale snapshot/dataset id (or explicitly marked local fixture)
- environment scope: local workstation vs cluster namespace/context
- endpoint-level latency table (p50/p95/p99, request count, mismatch/failure rate)
- service resource view at test time (CPU/memory sample, pod/deployment identity)
- assumptions/limits section (what was not measured)
- concrete next step with owner/action/target metric

Guardrail:

- do not present local fixture replay as staging or production-equivalent benchmark.

Execution checklist for performance tickets:

1. Establish baseline from local replay (endpoint table + command log + assumptions).
2. Establish environment baseline from staging replay against the intended namespace/workload.
3. Compare local vs staging endpoint latency and failure/mismatch rates in one side-by-side table.
4. Attach Speedscale snapshot context (dataset id, capture window, and endpoint hit distribution) before proposing fixes.
5. Name the top 1-3 hotspot endpoints and propose a specific optimization experiment per endpoint.
6. Define next validation run with explicit target (for example: reduce p95 on endpoint X by N% under same replay profile).

## Context Reset Handoff

Use this checkpoint after context reset:

1. confirm PR `#20` is merged and `main` is synced
2. select one microsvc issue with observable log signal
3. populate run `evidence.json` with:
   - discovery notes from logs
   - Speedscale/proxymock capture dataset details
   - reproducible local steps and expected vs observed behavior
4. execute run, verify replay result, then run `run-to-pr`
5. evaluate generated PR with `docs/autonomy-mvp.md` rubric and record decision in `docs/phase-b-first-run.md`

## Notes

- Historical completed work is tracked in `docs/history.md`.
- `docs/architecture.md` remains the source of truth for system shape.
- Phase B execution details and rubric are tracked in `docs/autonomy-mvp.md`.
- first live run target and decision template are tracked in `docs/phase-b-first-run.md`.
