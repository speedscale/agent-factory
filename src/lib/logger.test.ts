import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, type LogLevel } from "./logger.js";

interface CapturedLine {
  level: LogLevel;
  record: Record<string, unknown>;
  raw: string;
}

function capture(): { lines: CapturedLine[]; write: (level: LogLevel, line: string) => void } {
  const lines: CapturedLine[] = [];
  return {
    lines,
    write: (level, raw) => {
      const record = JSON.parse(raw) as Record<string, unknown>;
      lines.push({ level, record, raw });
    },
  };
}

test("emits JSON with component, level, ts, msg", () => {
  const cap = capture();
  const log = createLogger({ component: "controller", write: cap.write });
  log.info("hello");
  assert.equal(cap.lines.length, 1);
  const rec = cap.lines[0].record;
  assert.equal(rec.component, "controller");
  assert.equal(rec.level, "info");
  assert.equal(rec.msg, "hello");
  assert.equal(typeof rec.ts, "string");
});

test("bound fields appear on every line", () => {
  const cap = capture();
  const log = createLogger({
    component: "controller",
    fields: { instance: "minikube-local" },
    write: cap.write,
  });
  log.info("a");
  log.warn("b");
  for (const line of cap.lines) {
    assert.equal(line.record.instance, "minikube-local");
  }
});

test("child() merges fields and inherits writer", () => {
  const cap = capture();
  const log = createLogger({
    component: "controller",
    fields: { instance: "x" },
    write: cap.write,
  });
  const child = log.child({ run_id: "r1", agent_app: "demo-node" });
  child.info("dispatching");
  const rec = cap.lines[0].record;
  assert.equal(rec.instance, "x");
  assert.equal(rec.run_id, "r1");
  assert.equal(rec.agent_app, "demo-node");
});

test("per-call extra fields override bound fields", () => {
  const cap = capture();
  const log = createLogger({
    component: "controller",
    fields: { run_id: "bound" },
    write: cap.write,
  });
  log.info("override", { run_id: "perCall" });
  assert.equal(cap.lines[0].record.run_id, "perCall");
});

test("warn and error go to stderr (level-aware writer)", () => {
  const cap = capture();
  const log = createLogger({ component: "x", write: cap.write });
  log.info("a");
  log.warn("b");
  log.error("c");
  assert.equal(cap.lines[0].level, "info");
  assert.equal(cap.lines[1].level, "warn");
  assert.equal(cap.lines[2].level, "error");
});

test("undefined values are dropped from the record", () => {
  const cap = capture();
  const log = createLogger({
    component: "x",
    fields: { instance: "i", run_id: undefined },
    write: cap.write,
  });
  log.info("m", { agent_app: undefined });
  const rec = cap.lines[0].record;
  assert.equal(rec.instance, "i");
  assert.ok(!("run_id" in rec));
  assert.ok(!("agent_app" in rec));
});

test("circular extra falls back to a minimal record (no crash)", () => {
  const cap = capture();
  const log = createLogger({ component: "x", write: cap.write });
  const a: Record<string, unknown> = {};
  a.self = a;
  log.info("loop", { a });
  assert.equal(cap.lines.length, 1);
  assert.equal(cap.lines[0].record.jsonError, true);
});
