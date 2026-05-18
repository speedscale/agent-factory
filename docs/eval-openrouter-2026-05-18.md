# Model eval — OpenRouter sweep (2026-05-18)

First eval of the Planner→Worker engine against non-Claude models. Same scenario,
same prompts, same shim — six different models routed via OpenRouter.

## What changed in the engine

Before this eval, the engine called `@anthropic-ai/sdk` directly with the model
hardcoded to `claude-sonnet-4-6`. To evaluate other models we extracted the
LLM-call boundary into `src/lib/llm-providers.ts` and added a `callOpenRouter`
implementation that speaks OpenAI's function-calling shape. The agent loop, the
tool definitions, the Planner/Worker prompts, and everything else are unchanged.
Provider and model are now CLI flags (`--provider`, `--model`); defaults
preserve existing behavior.

This is intentionally a thin shim, not a `ModelClient` abstraction. The point
was to get evaluation data before committing to a provider interface design.

## Scenario

Target: [`speedscale/outerspace-go`](https://github.com/speedscale/outerspace-go).

Bug: the client at `cmd/client/main.go` deliberately appends a `0x7f` (DEL)
control character to a rocket ID and calls `GetRocket` a second time. The
server's `HandleRocket` forwards that ID into `fmt.Sprintf("%s/rockets/%s",
baseURL, rocketID)`. Go's `net/url` rejects URLs containing control characters
with `invalid control character in URL`, producing HTTP 500 once per polling
cycle.

Evidence: `proxymock/pulled-2026-04-15` — 36 RRPairs across server and SpaceX
upstream, with 5 cycles of `/api/rocket` showing the failure.

Issue text given to the agent:

> outerspace-go: /api/rocket returns HTTP 500 every cycle
>
> Every client polling cycle in the snapshot, GET /api/rocket fails with HTTP
> 500. Server log shows: parse 'https://api.spacexdata.com/v4/rockets/<id>\x7f':
> net/url: invalid control character in URL. Fix the root cause so /api/rocket
> returns 200.

Run command (representative):

```bash
npm run llm-run -- \
  --provider openrouter --model <id> \
  --title "outerspace-go: /api/rocket returns HTTP 500 every cycle" \
  --body "..." \
  --snapshot /Users/kahrens/spd-workspace/demos/outerspace-go/proxymock/pulled-2026-04-15 \
  --source  /Users/kahrens/spd-workspace/demos/outerspace-go \
  --workdir /tmp/llm-run-outerspace-<model> \
  --verbose
```

No `--repo` — Worker writes directly to the source dir, no worktree, no MR.
Acceptable for an eval where the goal is to compare model behavior, not to ship
fixes.

## Results

| Model | Total | Planner | Worker | Worker loops | Root cause | Fix target | Confirm |
|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-4.7 | 2:07 | 57s | 70s | 6 | ✅ Client | `cmd/client/main.go` | ✅ 5/5 → 0/5 |
| anthropic/claude-sonnet-4.6 | 2:50 | 1:46 | 1:04 | 5 | ✅ Client | `cmd/client/main.go` | ✅ static + dynamic, 0/5 |
| openai/gpt-5.5 | 2:33 | 1:09 | 1:24 | 13 | ❌ Server | `lib/handlers.go` | ✅ Go tests passing |
| openai/gpt-5.4 | 2:56 | 33s | 2:23 | 16 | ❌ Server | `lib/spacex.go` | ❌ faked prose |
| google/gemini-3.1-pro-preview | 2:16 | 1:30 | 46s | 7 | ❌ Server | `lib/handlers.go` | ❌ `fetch failed` |
| google/gemini-2.5-pro | 3:56 | 1:04 | 2:52 | 9 | ❌ Server | `lib/spacex.go` | ❌ `ECONNREFUSED` |

Total spend across all six runs: **$4.69** via OpenRouter.

Verbatim run logs and `patch.json` per model:
`/tmp/llm-run-outerspace-{opus47,sonnet46,gpt55,gpt54,gemini31,gemini25}/`.

## Findings

### 1. Diagnostic capability splits sharply by provider family

Both Anthropic models identified the deliberate client-side corruption as the
root cause and removed it. All four non-Anthropic models defensively sanitized
the rocket ID on the server side — a plausible fix that masks the symptom
without addressing the cause.

Same snapshot, same prompts, same shim. The split is not subtle:

- Anthropic models traced the failure back to the line where the corruption is
  introduced and asked "why is this here?"
- Non-Anthropic models accepted the framing "server returns 500 on malformed
  input" and asked "how should the server handle malformed input?"

For Agent Factory's intended workflow — find and fix real bugs against captured
traffic — this is the difference between a useful agent and an agent that
papers over symptoms.

### 2. Anthropic models converged faster

Anthropic models terminated at 5–6 Worker loops. Non-Anthropic models used 7–16.
This is consistent with the diagnostic-quality finding: a model that doesn't
fully understand the bug spends loops experimenting.

### 3. Confirm reliability is the silent killer

Three of six models called `emit_patch` despite their confirm harness failing
or never running:

- gpt-5.4: confirm produced ECONNREFUSED-style noise; the model shipped a
  paragraph of prose explaining what the confirm *would have done*.
- gemini-2.5-pro: confirm exited with `ECONNREFUSED` (no server running). Model
  emitted a passing patch.
- gemini-3.1-pro-preview: confirm exited with `fetch failed`. Model emitted a
  passing patch.

The engine currently trusts the model to honor its own confirm result. This
trust is misplaced for non-Anthropic models in this scenario. A simple fix:
treat a non-zero exit from the confirm harness as a hard block on `emit_patch`.

### 4. The Go-harness limitation is real but not always fatal

The engine's `run_script` tool only executes Node entrypoints. For a Go target
service, the model has to either (a) write a Node mock server and exercise the
fix indirectly, or (b) find a way to invoke Go through Node. Outcomes:

- Anthropic models wrote Node mock servers and produced clean confirm output.
- gpt-5.4 burned half its loop budget fighting this and gave up.
- gpt-5.5 wrote a Go `_test.go` file and got it executed somehow — actual `go
  test` output in the confirm result, with two passing assertions.
- Both Geminis didn't engage with the constraint and got runtime errors.

Long-term, `run_script` should be polyglot-aware. Short-term, the constraint is
a useful capability filter.

## Recommendation

Default the engine to **claude-opus-4.7** (or the latest Anthropic Sonnet for
cost reasons) for production runs against real customer bugs. Keep the
OpenRouter shim in tree so we can re-evaluate when new models ship, but do not
plumb a `--provider` flag through the polling/intake layers yet — there's no
viable alternative provider for this workload today.

Before designing a proper `ModelClient` abstraction, two things should change
in the engine first:

1. Treat a failing confirm as a hard block on `emit_patch`.
2. Make `run_script` polyglot (at minimum: `.mjs`/`.js`/`.go`).

After those land, re-run this eval and see whether the diagnostic-quality gap
narrows or whether it's intrinsic to the model families.
