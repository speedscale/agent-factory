# Model eval — Planner→Worker against outerspace-go (2026-05-18)

First cross-provider eval of the Planner→Worker engine. Same scenario, same
prompts, same shim — seven models routed via OpenRouter and two local servers
(DS4, omlx). Total cloud spend: **$5.71**.

The headline finding is buried half-way down: **two local models on this Mac
produced working fixes for $0** — Qwen3.6 with the correct client-side
diagnosis (16 min), DeepSeek-V4-Flash with a defensible server-side patch
(10 min). Both required engine fixes to work. The cloud-frontier developer
experience had been hiding five harness bugs that specifically punish
reasoning models and non-JS-source targets. Read past the leaderboard for
that part.

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

Five real bugs surfaced when local/weaker models hit them. Frontier models had
been working around every one silently — bugs 3, 4, and 5 hit reasoning models
specifically and the cloud frontier doesn't use that family.

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

### Bug 3: shim sent no sampling parameters

`callOpenAICompatible` passed only `model`, `max_tokens`, `tools`, and
`messages`. No `temperature`, no `reasoning_effort`, no `tool_choice`. The
default sampling for many providers is high-temperature uniform-ish — fine
for chat, hostile to deterministic tool-use planning.

DS4 (DeepSeek-V4-Flash IQ2) on defaults wandered through 30 loops, calling
`run_script` with paths like `/usr/bin/find` and `/bin/sh`, retrying ESM/CJS
module loads, never converging. A single-turn diagnostic with
`temperature: 0.1` and `reasoning_effort: "high"` produced clean reasoning
and the correct first tool selection (`list_snapshot_dir`) in 121 completion
tokens.

Fix: default to `temperature: 0.1` and `reasoning_effort: "high"` for all
OAI-compatible providers (openrouter, ds4, omlx). Both overridable via
`LLM_TEMPERATURE` / `LLM_REASONING_EFFORT` env vars for runs that need
different behavior. `reasoning_effort` is silently ignored by models that
don't support it; cloud frontier models also benefit from low temperature
for tool-use reliability.

### Bug 4: inline nudge was too polite

The forced-emit nudge is a plain user message: `[SYSTEM] You have used N of
M allowed loops. You MUST call <terminal> now...`. Frontier models honor
that. Reasoning-heavy weaker models read it and keep working.

DS4 with proper sampling (post-bug-3 fix) read 25 RRPairs in a row,
correctly identifying the bug evidence, and *still* never voluntarily
called `emit_plan`. The model wanted more evidence. With `reasoning_effort:
high` it kept thinking instead of committing.

Fix: when the nudge fires, also pass `tool_choice` forcing the terminal
tool on the next API call. Both providers translate to their native shape
(`{type: "function", function: {name: ...}}` for OAI-compat; `{type:
"tool", name: ...}` for Anthropic). This is an API-level constraint, not a
hint — the model cannot ignore it. After this fix, DS4 v4 completed the
full Planner→Worker run in 41:17 wall time.

### Bug 5: harness was wiping reasoning_content every turn

The actual root cause of every DS4 failure. DeepSeek-V4 (and Qwen3, and any
reasoning model with a separate thought channel) returns its
chain-of-thought in `reasoning_content`, often with `content` itself empty.
Our shim was extracting only `content` and replaying assistant turns with
reasoning lost. Each turn the reasoning model had to re-derive context
from scratch — exactly the wandering / re-exploration we kept seeing in
DS4 runs.

A two-turn curl diagnostic confirmed it:
  - Without reasoning preserved: model re-derives sqrt(17) bound
  - With reasoning preserved:    model continues prior thought
Both pick the right next tool on a trivial task; across many turns the cost
of re-deriving compounds into the wandering and analysis-paralysis we
observed.

Fix: AssistantTurn gains `reasoningContent` (optional). Response extraction
reads `msg.reasoning_content`; message serialization writes it back on
assistant turns. ds4-server and omlx accept the field on input; providers
that don't have a reasoning channel silently drop it. Anthropic's
thinking-mode equivalent is a separate content-block type; not wired yet.

After this fix, DS4 v5 finished in **9:55** — 4× faster than v4. Same
diagnostic outcome (server-side fix), but no more wandering. The earlier
fixes (temperature, forced tool_choice) were workarounds for this. The
real bug was harness amnesia, not model weakness.

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
| ds4/deepseek-v4-flash (IQ2, v5) | 9:55 | 18 | ❌ Server | ✅ Go test (real) | local | $0; only worked after reasoning_content preservation |

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

### 2. Local models work — the engine just wasn't ready for them

Two local models tested:

- **Qwen3.6-27B-4bit (omlx)**: produced the same client-side fix as Sonnet 4.6
  and Opus 4.7. 16:30 wall time vs ~2-3 min for cloud frontier. Cost: $0.
- **DeepSeek-V4-Flash IQ2 (ds4)**: produced a server-side fix (defensible but
  not the root cause). 9:55 wall time. Cost: $0. Real Go-test confirm.

Both required engine fixes to work. Qwen needed bugs 1-2 fixed. DS4
needed bugs 1-5 — and was only really cured by bug 5 (reasoning_content
preservation). Earlier "fixes" for DS4 (temperature, forced tool_choice)
were workarounds for the underlying memory-amnesia problem.

The cloud-frontier developer experience had been hiding harness bugs that
specifically punish reasoning models. Fix them and a $0 local path on a
Mac matches cloud frontier on this scenario, at 4-8× latency.

Caveats: n=1 scenario. DS4's diagnostic outcome (server-side) is less
desirable than Qwen's (client-side). Quantization tier matters — IQ2 vs
4-bit shows in the diagnostic quality even though both completed.

### 3. "Confirm" reliability is the engine's biggest remaining weakness

Models lie about confirm. From the original sweep:

- gpt-5.4 v1: confirm wrapper exited non-zero; model shipped prose.
- gemini-2.5-pro: ECONNREFUSED — expected a server to already be running.
- gemini-3.1-pro-preview: `fetch failed` — same pattern.
- gemini-3.1-flash-lite: honestly admitted "I cannot build/run the Go code."

After reruns with engine fixes, the gemini cases would still fake confirm —
the issue is the model, not the engine.

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

Keep the OpenRouter shim and both local providers (`ds4`, `omlx`) in tree.
The five engine fixes from this eval make all three viable; reverting any
of them re-breaks one model family.

**Default to Anthropic for production runs.** Sonnet 4.6 and Opus 4.7 both
produce correct, well-confirmed fixes on this scenario. gpt-5.5 (post-fix)
also lands the correct diagnosis. gpt-5.4 and DS4 land defensible
server-side patches — adequate for many bugs, suboptimal for this one.

**Two engine improvements remain before broadening provider selection:**

1. Treat a failing confirm harness as a hard block on `emit_patch`. The
   current honor-system approach lets faked confirms through.
2. Make `run_script` polyglot — at minimum `.mjs` / `.js` / `.go` / `.py`,
   plus shell. Today every non-Node target forces models to write
   Node-orchestrator wrappers; bug fixes shouldn't have to outwit the
   harness.

A nice-to-have for the Anthropic provider: extend reasoning-content
preservation to Anthropic's thinking-mode content blocks, so future
Anthropic models with separate reasoning channels don't regress.

**Then re-run this eval against a second scenario** — a real latency bug
like the SOS radar Gmail concurrency case — to see whether the provider-
quality picture holds when the mock-based confirm path doesn't apply.

**The local-models result is the headline.** A $0 local path that
produces a working confirm on a Mac is a real product story: BYOC
customers without LLM budget, overnight batch runs, privacy-constrained
deployments. The path needed five engine fixes to surface, but the fixes
benefit cloud runs too — they're not local-only kludges.

The remaining n=1-scenario caveat is real. A follow-up eval should
explicitly cross local-vs-cloud across 3-5 distinct bug types before any
roadmap commitment.
