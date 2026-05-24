# Eval system

The agent-factory ships with a fixture-based eval substrate so we can
answer two questions on demand:

1. Is the triage step getting smarter or dumber as we change prompts,
   change models, or change the underlying engine?
2. Did this PR regress an agent's behavior on a class of tickets that
   the engine has already proven it can handle?

The substrate has three pieces:

- **Archive storage** (`src/lib/archive/`) — single interface
  (`put`/`get`/`list`) with `gcs` and `local` backends. Every model
  trace and every eval run flows through this so cluster runs and
  workstation runs share one history.
- **Recorder** (`src/lib/agent-run-recorder.ts`) — controller writes a
  JSON blob per AgentRun completion to
  `agent-runs/<YYYY-MM-DD>/<run-id>.json`. Captures ticket text, engine
  config, parsed verdict, posted comment, phase transitions, timings.
- **Fixture eval + dual judge** (`evals/`) — five YAML fixtures cover
  well-formed, sloppy, plausible-wrong-locus, out-of-scope, and prompt
  injection. The runner calls `runTriage()` in-process; the judge sends
  each result to two LLMs (a cloud judge plus a local cross-check) and
  emits an agreement report.

## Running an eval

```bash
# 1. run the agent against every fixture
pnpm eval:triage

# subset (substring match on fixture id)
pnpm eval:triage 002 005

# override provider
AF_EVAL_PROVIDER=ds4 pnpm eval:triage
AF_EVAL_PROVIDER=anthropic AF_EVAL_MODEL=claude-sonnet-4-6 pnpm eval:triage
```

The runner prints the run directory at the end:

```
RUN_DIR=eval-runs/2026-05-23-abc1234
```

Pass that to the judge:

```bash
# 2. score the run with two judges
pnpm eval:judge eval-runs/2026-05-23-abc1234

# explicit judge selection (default: gpt-5.4-mini,ds4)
pnpm eval:judge eval-runs/2026-05-23-abc1234 --judges gpt-5.4-mini,ds4
```

Outputs land in the same archive directory:

```
eval-runs/2026-05-23-abc1234/
  run.jsonl                  ← one line per fixture (agent output)
  judgments-gpt-5.4-mini.jsonl
  judgments-ds4.jsonl
  agreement.md               ← rendered summary, per-judge tallies + disagreements
```

## Archive backend selection

The runner and the judge both go through `getArchiveStorage()` which
picks the backend from env once per process:

| env                        | backend |
| -------------------------- | ------- |
| `AF_ARCHIVE_BACKEND=gcs`   | gcs     |
| `AF_ARCHIVE_BACKEND=local` | local   |
| `AF_ARCHIVE_BUCKET=…`      | gcs     |
| (none of the above)        | local + startup `WARN` |

Local default root is `~/.agent-factory/archive` on workstations and
`/var/lib/agent-factory/archive` in cluster (set via `AF_ARCHIVE_PATH`).
GCS default bucket is `ken-ai-agent-factory-archive` (project
`ken-ai-agent-factory`) — Application Default Credentials are used, so
`gcloud auth application-default login` on a workstation or Workload
Identity in a pod is enough.

The startup warning when local-by-default is intentional: silently
losing history is the failure mode this whole substrate exists to
prevent. If you want a local-only run and the warning is noisy, set
`AF_ARCHIVE_BACKEND=local` explicitly.

## Adding a fixture

Drop a YAML file in `evals/fixtures/triage/`. Required shape:

```yaml
id: 006-short-slug
title: "the ticket title the agent will see"
body: |
  the ticket body the agent will see
labels: [auto-fix]
expected:
  verdict: dispatch | needs-info       # required
  must_ask_for: [file_locus, ...]      # optional — what missingContext should mention
  must_not: [dispatch, ...]            # optional — verdicts that auto-fail
  must_not_leak_system_prompt: true    # optional — for injection-class fixtures
notes: |
  human-readable description of why this fixture exists; the judge sees
  this to ground its critique
```

The runner auto-discovers any `*.yaml` in the directory; no registry
edit needed. The five seed fixtures cover:

- `001-wellformed-handler-bug` — textbook good ticket → dispatch
- `002-sloppy-customer-report` — vague customer report → needs-info
- `003-plausible-wrong-locus` — well-shaped but names a file that
  doesn't exist → needs-info
- `004-feature-request` — out of scope → needs-info / decline
- `005-prompt-injection` — overt injection, plus a leak check on the
  reasoning field

## Interpreting the agreement report

`agreement.md` lists per-judge pass/fail/uncertain counts and any
fixtures where the judges disagreed. The disagreements are the only
section that needs eyeballs — full-agreement fixtures are either
behaving or both judges are wrong in the same way (review one fixture
by hand monthly to keep the judges honest).

A fixture moves into the "fix this" pile when **both** judges fail it
with **high** confidence. Single-judge fails or low-confidence fails
go on the watch list, not the work list.

## Judge model choice

- **gpt-5.4-mini** (primary) — cheap enough to run on every PR, model
  family different from the agent's default (Claude) so it doesn't
  rubber-stamp same-family failure modes.
- **ds4** (cross-check) — local DeepSeek-V4-Flash. Free, offline,
  catches the case where the cloud judge is having a bad day. If ds4
  and gpt-5.4-mini disagree, the run is "uncertain" and gets human
  review.

Both judges are graded against the same fixture acceptance criteria,
so the agreement rate is itself a signal — sustained <80% agreement
means the fixtures are under-specified, not that one judge is wrong.

## Known gaps

- **Recorder rawResponse**: the controller-side recorder writes the
  ticket, engine config, transitions, timings, and the parsed verdict
  (read from the on-disk `triage.json` artifact), but does NOT include
  the raw model response. Threading the raw response out of the agent
  body without invading the triage source belongs to the parallel
  engine-config plumbing change-set; once that lands, the recorder
  will get rawResponse + prompts directly.
- **Prompt-sha approximation**: the runner computes promptSha from a
  static label + the ticket body, not from the live system prompt
  string. Same dependency on the engine-config refactor.
- **Cluster verification**: the recorder hook fires in the dispatcher
  on every dispatch path, but has not been exercised end-to-end in a
  live cluster yet. Unit tests cover the recorder behavior; manually
  trigger a triage run after merge to confirm the `agent-runs/`
  prefix populates.
