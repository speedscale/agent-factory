# Execution Plan

Audience: Agent Factory developers/contributors.

## Goal

Operate a bot-first, multi-repo issue factory that runs:

`issue -> triage -> baseline -> patch -> Speedscale validate -> PR/comment`

across these repositories:

- `speedscale/microsvc`
- `speedscale/demo`

Deferred scope (re-enable later after app installation expansion):

- `kenahrens/crm-demo`
- `kenahrens/newboots`

## Current Focus

This plan is intentionally forward-looking only.

- Architecture details live in `docs/architecture.md`.
- Policy/instruction requirements live in `AGENTS.md`.
- This file tracks active execution phases and acceptance criteria.

## Active Roadmap

### Phase 1: Bot Identity and Event Intake

Status: in progress

Objective:

- receive issue events and act as a dedicated bot identity, not an operator user

Deliverables:

- GitHub App (or bot token) configured across all target repos
- webhook receiver for issue events with repo allowlist
- canonical intake mapping to `schemas/ticket-intake.schema.yaml`
- bot-authored issue comment smoke test in each repo

Exit criteria:

- opening an issue in any target repo creates intake artifacts
- first automated response in each repo is authored by bot identity

### Phase 2: Repo Onboarding Contracts

Status: pending

Objective:

- remove repo-specific logic from workers by onboarding each repo via manifests

Deliverables:

- one `AgentApp` manifest per target repo
- per-repo install/build/test/start/validate commands
- Speedscale/proxymock dataset and validation command mapping per repo

Exit criteria:

- in-scope repos run baseline + validation from manifest-only configuration

### Phase 3: Triage Decision Engine

Status: pending

Objective:

- make deterministic fix/no-fix decisions with explicit operator-readable rationale

Deliverables:

- triage states: `fixable`, `needs-more-info`, `out-of-scope-or-unsafe`
- confidence and policy gates before patch execution
- structured fallback comment template for non-fixable issues

Exit criteria:

- every processed issue lands in one triage state with a recorded reason

### Phase 4: Autonomous Fix Pipeline

Status: pending

Objective:

- complete fixable issues end-to-end with verifiable before/after behavior

Deliverables:

- baseline behavior artifact before patch
- patch/build/test execution
- Speedscale validation report tied to run artifacts
- bot-authored PR and linked issue comment

Exit criteria:

- at least one successful autonomous PR loop in `speedscale/microsvc`
- at least one successful autonomous PR loop in one additional target repo

### Phase 5: Demo Reliability and Throughput

Status: pending

Objective:

- make the demo path consistently runnable under repeated issue intake

Deliverables:

- stable staging runtime profile (queue, worker, retries, timeouts)
- failure classification surfaced in run artifacts
- operational checks for stuck runs and backlog growth

Exit criteria:

- ten consecutive issue events complete without infrastructure-level manual recovery

## Operational Rules For This Phase

- If issue is fixable: baseline, patch, validate with Speedscale, open PR, comment with evidence.
- If issue is not fixable: post bot comment explaining why and exactly what data is needed.
- Do not post personal-user-authored automation output in target repos.

## Immediate Iteration Backlog

1. complete bot identity setup and verify bot-authored comment on each target repo
2. enable webhook or polling intake for in-scope repos with allowlist enforcement
3. add or finalize repo manifests for `speedscale/microsvc` and `speedscale/demo`
4. implement fallback comment path for non-fixable issues
5. run one real `microsvc` issue through full loop and record artifacts
6. run one real issue from a second target repo through full loop
