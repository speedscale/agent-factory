# `triage` — ticket fit-for-dispatch classifier

The smallest non-stub agent. One LLM call, optionally one Linear comment.
Reads the ticket carried on the AgentRun, asks Claude whether the engine
has enough information to attempt a fix, and writes the verdict to disk
and (when sourced from Linear) back to the originating ticket as a
comment.

Picked as the first real agent because the blast radius is zero — no
git, no MR, no patch, no traffic capture. It exercises every layer of
the loop (poller → controller → dispatcher → agent → external API →
status patch) without any chance of breaking a downstream system.

## Input contract

The agent reads from `AgentRun.spec.issue`. The dispatcher validates
the AgentRun's `spec.input` against the agent's schema before invoking
`run()`; for triage the schema is trivial:

```jsonc
{
  "taxonomy": ["string"]   // reserved for future use; ignored today
}
```

Required fields on `spec.issue`:

| Field            | Type     | Notes                                          |
| ---------------- | -------- | ---------------------------------------------- |
| `id`             | string   | Human-readable id (e.g. a Linear identifier like `XYZ-123`, or `pr-42`)    |
| `title`          | string   | Ticket title — fed verbatim to Claude          |
| `body`           | string   | Ticket body (can be empty)                     |
| `url`            | string?  | Optional link back to the source ticket        |
| `linearIssueId`  | string?  | Linear-internal UUID. Gates comment-posting.   |

Runs sourced from the Linear poller populate `linearIssueId`; runs from
other intake paths leave it unset and the agent never attempts to post
a comment.

## Output contract

The agent writes `triage.json` under `ctx.runDir` and returns the
verdict in `AgentRunOutput.summary`:

```json
{
  "issue": { "id": "XYZ-123", "title": "...", "url": "..." },
  "verdict": "dispatch" | "needs-info",
  "reason": "one or two sentences",
  "missingContext": ["..."],
  "recommendedActions": ["..."],
  "generatedAt": "2026-05-23T15:40:00.000Z"
}
```

`AgentRunOutput.artifacts.triage` points at the relative path.

## Taxonomy

`dispatch | needs-info`. Defined and prompt-tuned in
[`src/lib/triage.ts`](../../src/lib/triage.ts):

- **dispatch** — the ticket describes a concrete bug, names or
  obviously implicates the code locus, pins down acceptance criteria,
  and either provides reproduction context or is genuinely
  source-shaped.
- **needs-info** — the desired behavior is genuinely ambiguous, the
  bug locus is unclear with no investigation lead, reproduction would
  require context the engine cannot acquire, or the acceptance
  criteria cannot be checked without information not in the ticket.

The model is biased slightly toward `dispatch` when the engine could
plausibly do the work even with some details missing, and toward
`needs-info` when it would be guessing at the spec. The
`bug/feature/question/noise` taxonomy mentioned in the original
steel-thread spec was dropped in favor of this one — dispatch-readiness
is what the factory actually needs to decide on next.

## Idempotency

The Linear poller names every triage CR `triage-<slugified-identifier>`
(e.g. `triage-xyz-123`). On second poll of the same ticket the
`KubernetesObjectApi.create()` call returns 409 Conflict, which the
poller treats as "already dispatched" and skips. Re-classification on
ticket update is **out of scope** — the AgentRun CR is the unit of
work; if you want a fresh classification, delete the CR.

## Failure modes

| Failure                                  | Behaviour                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| LLM call throws / returns malformed JSON | Agent throws `TriageBadResponseError`; dispatcher marks run failed (`AgentError`). |
| `LINEAR_API_KEY` not set                 | Agent logs a warning, writes the artifact, summary notes the skip. Run succeeds. |
| Linear `commentCreate` returns 4xx/5xx   | Agent logs the error, writes the artifact, summary notes the failure. Run still succeeds — the verdict is preserved on disk. |
| `spec.issue.title` missing               | Agent throws (defensive — the dispatcher already rejects this).         |

The "Linear comment fails but run still succeeds" decision is
deliberate: an operator can re-paste the verdict manually from the
artifact, but losing the verdict because of a transient 503 would
mean re-running the LLM for no reason.

## RBAC

The triage agent itself needs no special k8s permissions — it only
reads from the AgentRun context and writes to `ctx.runDir`. The
controller's ServiceAccount already covers everything in the dispatch
path (granted in [`charts/agent-factory/templates/rbac.yaml`](../../charts/agent-factory/templates/rbac.yaml)).

## Secrets

Two env vars are read at the worker pod, both wired by the Helm chart
when configured in `values.yaml`:

- `ANTHROPIC_API_KEY` — mirrors `engine.authSecret` when
  `engine.kind=claude-sdk`. Used by `src/lib/llm-providers.ts` for the
  one LLM call.
- `LINEAR_API_KEY` — mounted from `linear.authSecret`. Optional; if
  unset the agent skips comment-posting and the run still succeeds.

## Smoke test

Pre-conditions:

1. minikube running with the agent-factory chart deployed.
2. AgentApp + TrafficSource manifests applied (sample lives in
   `examples/instances/demo/`).
3. `linear-api-key` secret created in the release namespace, containing
   a Linear personal API token under key `token`.
4. `LINEAR_DEFAULT_APP_FILE`, `AF_LINEAR_QUERY`, and `POLLER_SOURCE=linear`
   set on the intake-api Deployment (see
   [`docs/CONFIG.md`](../CONFIG.md)).

Steps:

1. File a fresh Linear ticket on the Speedscale team with label `factory`.
2. Within one poll interval (default 60s) the embedded poller calls
   `commentCreate`'s sibling — `kubectl get agentruns -A` should show a
   new `triage-xyz-NNN` CR.
3. The controller picks it up. `kubectl describe agentrun triage-xyz-NNN`
   shows phases `queued → planned → generating → succeeded` (or
   `failed` if the LLM call errors).
4. Open the Linear ticket — a comment appears with the verdict + reason
   + (if applicable) missing context and recommended actions.
5. The dashboard's `Succeeded` tile increments; the `Run logs` panel
   filtered to `run_id=triage-xyz-NNN` shows the full dispatch trace.

If step 4 doesn't happen, check the run's `triage.json` artifact — the
verdict is there even when the comment post fails.

## Future extensions (explicitly out of scope today)

- Acting on the verdict (auto-label, auto-assign, auto-status-change).
- Dispatching a follow-up `bug-fix` agent when `verdict=dispatch`.
- Re-classification on ticket update.
- Other taxonomies (the `taxonomy` input slot is reserved for this).
