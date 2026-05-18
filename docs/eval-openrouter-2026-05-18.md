# Model eval — Planner→Worker against outerspace-go (2026-05-18)

First cross-provider eval of the Planner→Worker engine. Same scenario, same
prompts, same shim — seven models routed via OpenRouter and two local servers
(DS4, omlx). Total cloud spend: **$5.71**.

The headline finding is buried half-way down: a 4-bit Qwen3.6 running locally
on this Mac matches Anthropic frontier models on diagnosis — but only after
fixing two engine bugs that were silently hiding *every other model's*
diagnostic capability. Read past the leaderboard for that part.

## What changed in the engine

Before this eval, the engine called `@anthropic-ai/sdk` directly with the
model hardcoded to `claude-sonnet-4-6`. To evaluate other models we extracted
the LLM-call boundary into `src/lib/llm-providers.ts` and added portable
provider implementations. The agent loop, tool definitions, and prompts are
unchanged. Provider and model are CLI flags (`--provider`, `--model`);
defaults preserve existing behavior.

Providers added:
- `openrouter` — OpenAI-compatible API at `https://openrouter.ai/api/v1`
- `ds4` — local antirez/ds4 server (DeepSeek-V4-Flash) at `127.0.0.1:38011`
- `omlx` — local MLX server (Qwen, Gemma, Nemotron) at `127.0.0.1:38010`

This is a thin shim, not a `ModelClient` abstraction. The point was to get
data before committing to a provider interface design.

## Scenario

Target: [`speedscale/outerspace-go`](https://github.com/speedscale/outerspace-go).

Bug: the client at `cmd/client/main.go` deliberately appends `0x7f` (DEL) to a
rocket ID and calls `GetRocket` a second time. The server's `HandleRocket`
forwards that ID into `fmt.Sprintf("%s/rockets/%s", baseURL, rocketID)`. Go's
`net/url` rejects URLs containing control characters with `invalid control
character in URL`, producing HTTP 500 once per polling cycle.

Evidence: `proxymock/pulled-2026-04-15` — 36 RRPairs across server and SpaceX
upstream, with 5 cycles of `/api/rocket` showing the failure.

The "real" root cause is on the client. A server-side sanitize is also a
defensible fix that masks the symptom; we use this distinction to grade
diagnostic quality.

## Engine bugs found mid-eval

Two real bugs surfaced when local/weaker models hit them. Frontier models had
been working around both silently.

### Bug 1: `search_code` was JS/TS-only

`toolSearchCode` hardcoded `grep -rEn --include="*.js" --include="*.ts"
--include="*.mjs"`. Against a Go codebase every `search_code` call returned
`(no matches)`. Qwen3.6 collapsed at loop 7 after four no-match results.

Fix: broaden the glob list to cover Go, Python, Java, Kotlin, Ruby, C/C++,
Rust, C#, Swift, PHP, plus shell and common config formats. Add
`--exclude-dir` for `node_modules`, `.git`, `vendor`, `dist`, `build`.

This single fix changed the diagnostic outcome for **gpt-5.5**: pre-fix it
patched server `lib/handlers.go`; post-fix it found the client-side root
cause and joined the Anthropic models in correctly diagnosing the bug.

### Bug 2: `end_turn` without a terminal tool was fatal

The engine threw on `end_turn` with no `emit_plan` / `emit_patch` call:
```ts
if (turn.stopReason === "end_turn" && turn.toolUses.length === 0) {
  throw new Error(`agent stopped without calling ${terminalToolName}`);
}
```

For frontier models this almost never fires. For weaker models that reach a
hypothesis and then just *stop* it's a hard failure of an otherwise-valid
run. Qwen3.6 v2 reached a working `reproduce.mjs` showing
`BUG CONFIRMED: GetRocket uses fmt.Sprintf to embed rocketID directly in
URL`, then ended its turn without calling `emit_plan`. Engine threw.

Fix: on `end_turn` without a terminal tool, inject the forced-emit nudge
inline and continue, instead of throwing. Also moved the scheduled nudge
from 80% of budget to 60% — 80% was too late, Qwen had bailed at loop 23
on a 30-loop budget (one loop before the 80% nudge would have fired).

After both fixes, Qwen3.6 v3 completed the full Planner→Worker run.

## Results

Seven models, plus retry data for several. Cloud spend $5.71 total.

| Model | Total | Worker loops | Diagnosis | Confirm | Local | Notes |
|---|---|---|---|---|---|---|
| anthropic/claude-opus-4.7 | 2:07 | 6 | ✅ Client | ✅ Node mock, 5/5→0/5 | — | Fastest converging |
| anthropic/claude-sonnet-4.6 | 2:50 | 5 | ✅ Client | ✅ static + dynamic | — | Fewest worker loops |
| openai/gpt-5.5 (v2) | 2:27 | 6 | ✅ Client | ✅ Go integration test | — | Flipped to correct diag after search_code fix |
| omlx/Qwen3.6-27B-4bit (v3) | 16:30 | 7 | ✅ Client | ✅ static check | local | $0; 8× slower; correct |
| openai/gpt-5.4 (v2) | 1:36 | 5 | ❌ Server | ✅ Go test (real) | — | Fastest overall; still wrong target |
| google/gemini-3.1-pro-preview | 2:16 | 7 | ❌ Server | ❌ fetch failed | — | Faked confirm |
| google/gemini-3.1-flash-lite | 0:32 | 15 | ❌ Server | — | — | Fast/cheap/wrong; honest "couldn't run" |
| ds4/deepseek-v4-flash (IQ2) | DNF | — | — | — | local | $0; both runs exhausted loop budget |

`v2` / `v3` indicates the run after engine fixes. The pre-fix runs for gpt-5.4
and gpt-5.5 are described inline below where the difference matters.

Verbatim run logs and `patch.json` per model: `/tmp/llm-run-outerspace-*/`.

## Findings

### 1. The diagnostic split was partly an engine bug, not a model gap

The first round suggested Anthropic models were uniquely capable of finding
the client-side root cause. After fixing `search_code` to cover Go:

- gpt-5.5 v2 found the client bug — its pre-fix run had concluded
  server-side because `search_code "rocket"` returned `(no matches)`.
- gpt-5.4 v2 still chose server-side, even with working search, but in
  half the time and with a real Go-test confirm.
- Geminis stayed wrong (3.1-pro-preview not rerun; flash-lite confirms the
  pattern).

So the "Anthropic vs others" diagnostic-quality gap is real but smaller than
the original sweep suggested. Three of four model families can find this bug
when the tools work.

### 2. Local Qwen3.6 matches frontier-cloud diagnosis at 8× latency and $0

Qwen3.6-27B at 4-bit, served locally via omlx, produced the same fix as
Sonnet 4.6 and Opus 4.7 — remove the deliberate corruption from the client,
verify with a static check. Total wall time: 16:30 vs ~2-3 min for cloud
frontier. Cost: $0.

This depends on both engine fixes shipping; pre-fix, Qwen failed twice in
distinct ways. With the fixes, the local model is viable for non-realtime
runs against this kind of bug. The caveat is sample size: n=1 scenario, one
attempt past the engine fixes.

DS4 (DeepSeek-V4-Flash IQ2XXS) failed twice. The 2-bit quantization
appears to be below the floor for this kind of tool-use planning, even
with working tools.

### 3. "Confirm" reliability is the engine's biggest weakness

Models lie about confirm. Three of seven (pre-rerun: four of six) called
`emit_patch` despite their confirm harness failing or never running:

- gpt-5.4 v1: confirm wrapper exited non-zero; model shipped prose.
- gemini-2.5-pro: ECONNREFUSED — expected a server to already be running.
- gemini-3.1-pro-preview: `fetch failed` — same pattern.
- gemini-3.1-flash-lite: honestly admitted "I cannot build/run the Go code."

The engine currently trusts the model to gate emit_patch on its own confirm
result. Trust is misplaced. **The engine should treat non-zero exit from
the confirm harness as a hard block on `emit_patch`.** This would have
caught all four cases above without filtering out any of the successful
runs.

### 4. `run_script` Node-only constraint shaped behavior

Models took three approaches when the target service was Go:
- Anthropic + Qwen: wrote Node mock servers, exercised the fix indirectly.
- gpt-5.5: wrote a Node wrapper that copied source to tmpdir, dropped in
  a `_test.go`, ran `go test` via `execFileSync`. Cleanest Go-native
  approach in the sweep.
- gpt-5.4 v1: tried Node wrapper + `go run` against patched code via
  `unsafe` reflection. Wrapper crashed.
- gpt-5.4 v2: imitated gpt-5.5's tmpdir + go-test pattern. Worked.
- gemini-*: just `fetch`-ed to localhost and expected something to answer.

A polyglot `run_script` (at minimum: `.mjs` / `.js` / `.go`) would simplify
everyone's confirm path for non-Node targets. Today this is a useful
capability filter; tomorrow it's just an annoying paper-cut.

### 5. None of the models ran the actual binary

To be honest about what "confirm" means here: no model started
`outerspace-go` itself. The Anthropic models ran Node mock servers. gpt-5.5
ran a Go unit test against a mock `SpaceXClient` interface. gpt-5.4 v2 did
the same. The Geminis tried to fetch from a server they assumed was
running and got connection errors. None compiled + booted the real outerspace-go
HTTP server and replayed the bug against it.

For this scenario (deterministic client-side corruption), mock-based confirm
is adequate proof. For latency / concurrency bugs, it wouldn't be — the
engine needs a way to spin up the system under test against captured
traffic. That's already on the proxymock side of the architecture; not yet
wired into `llm-run`.

## Recommendation

Keep the OpenRouter shim and the two new local providers (`ds4`, `omlx`)
in tree. They are cheap to maintain and unlock both eval workflows and
private-traffic scenarios.

**Default to Anthropic for production runs.** Sonnet 4.6 and Opus 4.7 both
produce correct, well-confirmed fixes on this scenario. gpt-5.5 (post-fix)
is also viable; gpt-5.4 lands server-side defaults, which is wrong here but
defensible in other contexts.

**Before adding model selection to the polling / intake layers**, ship two
engine improvements:

1. Treat a failing confirm harness as a hard block on `emit_patch`. The
   current honor-system approach lets bad runs through.
2. Make `run_script` polyglot — at minimum `.mjs` / `.js` / `.go` / `.py`,
   plus shell. The Node-only constraint is now a known capability filter
   rather than a useful one.

After those land, re-run this eval and broaden to a second scenario (a
real latency bug — the SOS radar Gmail concurrency one from the spike
would be ideal) to see whether the provider-quality story holds when the
mock-based confirm path doesn't apply.

The local Qwen result is the most interesting future-looking signal. If
batch / overnight / privacy-constrained Agent Factory use cases are on the
roadmap, a $0 local path that produces the same fix as cloud frontier at
8× latency is worth taking seriously. n=1 scenario isn't enough to bet on,
but it's enough to plan a follow-up eval that explicitly tests local vs
cloud across 3-5 scenarios.
