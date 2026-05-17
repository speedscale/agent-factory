# Roadmap

Audience: Agent Factory developers and contributors.

## Goal

Ship an LLM-driven fix loop — **Spec → Generate → Validate → Deploy → Observe** — that works reliably on Speedscale's own services (SOS/Cloud) and then packages as a Helm chart for BYOC customers.

The SOS manual spike (2026-05-17) proved the loop works end-to-end. The outstanding work is automation, hardening, and productization.

---

## Active: complete the SOS spike

### S-10885 observe step

MR-356 (Gmail concurrency fix) is open. After merge:

1. Pull a new prod snapshot 24–72h post-deploy with `--filter '(cluster IS "prod")'`
2. Confirm Gmail 429 rate on `gmail.googleapis.com/messages.get` dropped to near zero
3. Store the post-deploy snapshot as the new evidence baseline

Exit criteria: 429 rate ≤ 1% in the post-deploy snapshot.

### S-10886 API performance

Radar `/api/pipeline/opportunities` and `/api/directory` endpoints are slow. Work this using the same reproduce → fix → confirm workflow:

1. Pull fresh radar prod snapshot
2. Identify P95 latency baseline for the affected endpoints
3. Reproduce the latency in a harness
4. Implement caching or query optimization
5. Confirm P95 dropped below threshold

### S-10884 usr-mgmt unblock

Waiting on Shaun to instrument `usr-mgmt` in the prod cluster. Once done:

1. Pull prod snapshot with `--filter '(cluster IS "prod")'`
2. Run data survey (originally planned)

---

## Near-term: unblock automation

### 1 — `summarize_traffic` proxymock MCP tool

The single most labour-intensive manual step in the SOS spike was reading individual RRPair files to count 429s and identify burst patterns. This should be a single MCP tool call.

Required output: per-endpoint error rates (sorted by count), status code breakdown, burst detection (N requests within T ms), slowest endpoints by P95, cluster-scoped.

This unblocks automated Spec phase — the Planner can ask "what is broken and by how much" without hand-parsing snapshots.

Owner: proxymock team. Blocks: Planner automation.

### 2 — Isolated worktree per run

The Worker currently writes fixes directly to the operator's live source tree. Production requires:

- `git worktree add <workdir>/repo agent/<ticket-slug>` from `main` at Worker phase start, before any file is modified
- Worker's `sourceDir` is set to the worktree path, not the operator's checkout
- Deployer pushes the branch and opens the PR from it
- After merge, `git worktree remove` + branch delete; stale unmerged worktrees older than 7 days are flagged for cleanup

Rule is now codified in `AGENTS.md`. Wire up the implementation: add `setupWorktree(repoPath, workdir, branchName)` in `llm-engine.ts` that runs `git worktree add`, returns the worktree path, and sets `sourceDir` to it before the Worker loop starts. Add a `cleanupAgentWorktrees(repoPath)` utility that removes merged worktrees and flags stale ones.

### 3 — Test harness scaffold generator

Given a named metric and the source code context, the LLM should generate the reproduce harness in one pass rather than iteratively. The SOS spike showed this takes ~5–7 tool iterations; a good scaffold prompt reduces this to 1–2.

Write a dedicated prompt for harness generation, separate from the main Planner prompt.

### 4 — Design review

Half-day session: Ken + Matt + one customer-facing person. Review SOS spike learnings, confirm §12 priority order, decide BYOC Helm chart scope and timeline.

---

## Medium-term: BYOC productization

### 5 — `validate_candidate` MCP tool

Orchestrates build → mock deps → replay → diff in one call. Returns a structured `ValidationResult`. Collapses the most error-prone code path in the Validate phase.

### 6 — Helm chart + CRDs

Single chart installed alongside `speedscale-operator`. Includes:
- `AgentRun` CRD
- Intake API deployment
- Worker deployment
- Run store (PVC default; S3-compatible configurable)
- RBAC (viewer + approver roles, OIDC)
- Engine configuration (kind, model, endpoint, auth secret ref)

Three sizing profiles: small (1 worker), medium (3 workers), HA (3 workers + Redis queue).

### 7 — Customer OIDC + Review UI

Review UI (React SPA) where operators see run status, QualityReport, and reproduce/confirm harness output, and approve the PR. Auth via customer OIDC.

### 8 — Engine option 2 + 3 validation

Spike generic LLM SDK (OpenAI-compatible, targets Azure) and private-LLM path (vLLM in-cluster). Measure fix-acceptance rate vs Option 1 (Claude SDK). Decide quality floor before committing to option 3 for air-gapped customers.

---

## Deferred

- `extract_for_prompt` (DLP-aware RRPair extraction for LLM prompts) — needed for full BYOC privacy guarantee
- Load mode on `replay_traffic` — load testing phase in Validate
- `generate_rrpair_from_spec` + `coverage_check` — closes the loop for new-feature work
- Cross-deploy filter on `search_traffic` — needed for high-confidence post-deploy observe
- Multi-repo app support (`AgentApp.dependencies`)

---

## Measurement targets

| Metric | Target |
|---|---|
| Time from issue → confirmed fix (LLM) | < 10 minutes |
| Fix acceptance rate (human approves MR) | > 60% |
| False-positive regression rate (replay gate) | < 5% |
| Post-deploy bug recurrence rate | < 10% |
