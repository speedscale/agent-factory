import { test } from "node:test";
import assert from "node:assert/strict";
import { detectReproContext } from "./repro-context-detector.js";

// ---------- Negative cases (must NOT detect) ----------

test("empty spec → not detected", () => {
  const r = detectReproContext({ title: "", body: "" });
  assert.equal(r.detected, false);
  assert.deepEqual(r.signals, []);
});

test("pure CLI ergonomics ticket → not detected", () => {
  const r = detectReproContext({
    title: "speedctl tenant set: missing --dry-run flag",
    body: "Add a --dry-run option to tenant set so callers can preview the API call before sending. Today the command always hits the live endpoint, which has bitten us during staging rollouts."
  });
  assert.equal(r.detected, false, `expected no signals, got: ${r.signals.join(", ")}`);
});

test("source/log refactor ticket → not detected", () => {
  const r = detectReproContext({
    title: "responder logs not present in reports",
    body: "The responder logger is constructed before newFirehoseReporter adds the zap core, so emitted log lines never reach the firehose. Reassign the logger after the reporter is built."
  });
  assert.equal(r.detected, false, `expected no signals, got: ${r.signals.join(", ")}`);
});

test("casual mention of 'curl' without URL → not detected", () => {
  const r = detectReproContext({
    title: "Document the curl examples in README",
    body: "The README should include curl examples for each endpoint, but the current docs only show the SDK call shape."
  });
  assert.equal(r.detected, false, `expected no signals, got: ${r.signals.join(", ")}`);
});

test("casual mention of 'trace' (not a stack trace, not a trace ID) → not detected", () => {
  const r = detectReproContext({
    title: "Improve function-call trace docs",
    body: "Engineers reading the codebase want to see how a request flows through the call trace. Add a sequence diagram."
  });
  assert.equal(r.detected, false, `expected no signals, got: ${r.signals.join(", ")}`);
});

// ---------- HTTP traffic capture formats ----------

test("HAR file mention → detected", () => {
  const r = detectReproContext({
    title: "Replay fails on browser HAR export",
    body: "Attached browser-trace.har shows the failing request shape."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("HAR file"));
});

test("Postman collection file → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Repro: import users-api.postman_collection.json into Postman and run the auth folder."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("Postman collection file"));
});

test("Postman collection by name → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Reproduces with the Acme API Postman collection — see workspace link."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("Postman collection reference"));
});

test("VCR cassette path → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Re-record spec/cassettes/order_flow.yml against the new service version."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("VCR cassette"));
});

test("mitmproxy reference → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Captured via mitmdump -w session.mitm; load in mitmweb to inspect."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("mitmproxy capture"));
});

test("proxymock recording dir → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "see backend/proxymock/recorded-2026-05-20_23-34-56.684644Z/ for the failing rrpair"
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("proxymock recording dir"));
});

test("proxymock mock dir → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "results/mocked-2026-05-20_23-37-57.590619Z/ for the replay output"
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("proxymock mock dir"));
});

test("RRPair mention → detected", () => {
  const r = detectReproContext({
    title: "Replay drops second RRPair after content-length mismatch",
    body: "We see 1/3 RRPairs delivered."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("RRPair reference"));
});

// ---------- Inline HTTP repros ----------

test("curl command with URL → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Repro:\n  curl -v https://api.example.com/v1/users/42\n  → 500"
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("curl command (with URL)"));
});

test("HTTPie command → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Repro:\n  http POST https://api.example.com/orders amount=100\n  → 422"
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("HTTPie command"));
});

// ---------- Network captures ----------

test("pcap file → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Attached failing-handshake.pcap captured during the outage window."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("packet capture"));
});

test("tcpdump reference → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Ran tcpdump on the node and saw the SYN-ACKs were never delivered."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("packet capture"));
});

// ---------- Logs (concrete paths only) ----------

test("/var/log path → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "See /var/log/nginx/access.log around 02:14 UTC for the burst."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("log file path"));
});

test("kubectl logs reference → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "kubectl logs deploy/api -n prod shows the panic immediately after pod startup."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("kubectl/pod logs"));
});

test("journalctl reference → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "journalctl -u myservice shows the same error pattern."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("container/system log dump"));
});

// ---------- Distributed traces ----------

test("trace ID → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "trace_id: a1b2c3d4e5f6789012345678abcdef00 — Jaeger has the spans."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("trace ID"));
});

test("Jaeger UI URL → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "https://jaeger.internal.example.com/trace/abc123 — root span is the gateway."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("tracing UI URL"));
});

test("Datadog APM link → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Trace: https://app.datadoghq.com/apm/trace/abc123def456 — see the span on prod-api."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("APM trace link"));
});

// ---------- Crash / error services ----------

test("Sentry issue URL → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Tracked at https://sentry.io/organizations/acme/issues/4815162342 — 1.2k events in 24h."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("Sentry issue link"));
});

test("Python stack trace → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: `Traceback (most recent call last):
  File "app/handlers.py", line 217, in process_order
    return self.charge(...)
TypeError: ...`
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("stack trace"));
});

test("Java stack trace → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: `Caused by: java.lang.NullPointerException
    at com.example.OrderService.process(OrderService.java:142)
    at com.example.api.OrderController.handle(OrderController.java:88)`
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("stack trace"));
});

// ---------- Reproducer projects ----------

test("'minimal reproducer' phrase → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "I have a minimal reproducer at github.com/me/bug-repro — clone and run `make`."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("minimal reproducer phrase"));
});

test("'reproduction steps' phrase → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Reproduction steps:\n1. clone\n2. configure\n3. observe"
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("minimal reproducer phrase"));
});

// ---------- Generic fixture directories ----------

test("fixtures/x.json reference → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "The test loads fixtures/auth-failure.json — same response shape as prod."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("fixture/recording file"));
});

test("snapshots/foo.yaml reference → detected", () => {
  const r = detectReproContext({
    title: "X",
    body: "Compare against snapshots/billing-flow.yaml in this repo."
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.includes("fixture/recording file"));
});

// ---------- Composite + edge cases ----------

test("multi-format spec produces multiple signals", () => {
  // A spec that names HAR + Postman + curl + a Sentry link — all valid repro
  // sources the operator should pass to the engine.
  const r = detectReproContext({
    title: "Payment retry storm",
    body: `Repro:
- Replay payments.har (browser HAR export from the support call), or
- Run the "Payments → Retry" Postman collection against staging
- Single curl: curl -v https://api.staging.example.com/payments/retry/42

Crash captured at https://sentry.io/issues/9988776655 — 4k events.

Traceback (most recent call last):
  File "payments/worker.py", line 88, in retry
    self.charge(idempotency_key=key)
PaymentBackendError: ...`
  });
  assert.equal(r.detected, true);
  // Expect at least 4 distinct categories from the matchers above.
  assert.ok(r.signals.length >= 4, `expected ≥4 signals, got ${r.signals.length}: ${r.signals.join(", ")}`);
});

test("speedscale-shaped spec still detected (compatibility with prior failure mode)", () => {
  // Condensed version of the spec that originally motivated the detector —
  // a proxymock/RRPair-flavored ticket. Confirms speedscale-specific tooling
  // remains one signal source among many.
  const r = detectReproContext({
    title: "Responder serves decoded body with original Content-Encoding: br header",
    body: `Repo: speedscale/demo, subdir llm-simulation-demo/.
Switch proxymock to mock mode (proxymock mock --in <recorded-dir>).
The repro recordings are at proxymock/recorded-2026-05-20_23-34-56.684644Z/.
Decoding the mocked OpenAI RRPair shows plain JSON.`
  });
  assert.equal(r.detected, true);
  assert.ok(r.signals.length >= 3, `expected ≥3 signals, got ${r.signals.length}: ${r.signals.join(", ")}`);
  assert.ok(r.signals.includes("proxymock recording dir"));
});

test("signal list capped at 5", () => {
  // Body that would match many patterns; cap must still hold.
  const r = detectReproContext({
    title: "X",
    body: `request.har postman_collection.json cassettes/x.yml mitmdump session.mitm
recorded-2026-05-20_00-00-00Z mocked-2026-05-20_00-00-00Z RRPair
curl https://api.example.com/x
http GET https://api.example.com/y
session.pcap tcpdump /var/log/app.log
kubectl logs deploy/x journalctl -u y
trace_id: abc1234567890def
https://jaeger.internal/trace/x
https://sentry.io/issues/123
Traceback (most recent call last):
  File "a.py", line 1, in x
minimal reproducer
fixtures/x.json`
  });
  assert.equal(r.detected, true);
  assert.equal(r.signals.length, 5, `signal list must be capped at 5; got ${r.signals.length}: ${r.signals.join(", ")}`);
});
