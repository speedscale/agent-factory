# Execution Plan

Audience: Agent Factory developers/contributors.

## Goal

Operate a bot-first, multi-repo quality factory that runs:

`request -> baseline -> quality checks -> compare -> report/comment`

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

### Phase 1: Bot Identity and PR/Request Intake

Status: in progress

Objective:

- receive PR and explicit QA validation requests as a dedicated bot identity, not an operator user

Deliverables:

- GitHub App (or bot token) configured across all target repos
- webhook receiver for PR events with repo allowlist
- canonical intake mapping to `schemas/qa-intake.schema.yaml`
- bot-authored PR comment smoke test in each repo

Exit criteria:

- opening or updating a PR in any target repo creates quality intake artifacts
- first automated response in each repo is authored by bot identity

### Phase 2: Repo Onboarding and Baseline Contracts

Status: pending

Objective:

- remove repo-specific logic from workers by onboarding each repo and defining baseline scope via manifests

Deliverables:

- one `AgentApp` manifest per target repo
- per-repo quality targets (single-project or multi-project directories)
- per-target install/build/test/start/validate commands
- baseline capture metadata and comparison policy per target

Exit criteria:

- in-scope repos run baseline and PR comparisons from manifest-only configuration

### Phase 3: Quality Signal Engine

Status: pending

Objective:

- make deterministic pass/warn/fail quality decisions with explicit operator-readable rationale

Deliverables:

- quality states: `pass`, `warning`, `regression`
- confidence and policy gates before final status reporting
- structured fallback comment template when baseline coverage is missing

Exit criteria:

- every processed request lands in one quality state with a recorded reason

### Phase 4: PR Quality Reporting Pipeline

Status: pending

Objective:

- produce PR quality outcomes end-to-end with verifiable baseline comparison

Deliverables:

- baseline artifact(s) captured per onboarded target
- PR build/test/validation execution
- quality diff report tied to run artifacts
- bot-authored PR comment with evidence links

Exit criteria:

- at least one successful PR quality report loop in `speedscale/microsvc`
- at least one successful PR quality report loop in one additional target repo

### Phase 5: Reliability and Throughput

Status: pending

Objective:

- make the quality path consistently runnable under repeated PR/request intake

Deliverables:

- stable staging runtime profile (queue, worker, retries, timeouts)
- failure classification surfaced in run artifacts
- operational checks for stuck runs and backlog growth

Exit criteria:

- ten consecutive PR/request events complete without infrastructure-level manual recovery

## Operational Rules For This Phase

- For PR/request events: run checks, compare to baseline, and comment with quality evidence.
- If baseline coverage is missing: post bot comment explaining onboarding/baseline gap and next action.
- Do not post personal-user-authored automation output in target repos.

## Immediate Iteration Backlog

1. complete PR-centric bot identity setup and verify bot-authored comment on each target repo
2. enable webhook or polling intake for in-scope repos with allowlist enforcement
3. add or finalize baseline target manifests for `speedscale/microsvc` and `speedscale/demo`
4. implement fallback comment path for missing baseline coverage
5. run one real `microsvc` PR through full quality loop and record artifacts
6. run one real PR from a second target repo through full quality loop
