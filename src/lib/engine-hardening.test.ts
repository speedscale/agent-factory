import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rescueToolCall,
  ToolResolutionError,
  ToolExecutionError,
  validateToolArgs,
  checkPrerequisites,
  nudgeTierFor,
  buildNudgeMessage,
  compactMessages,
  estimateChars,
  chooseCompactionPhase
} from "./engine-hardening.js";
import type { ToolDef, ConvMessage, AssistantTurn } from "./llm-providers.js";

const tools: ToolDef[] = [
  {
    name: "read_file",
    description: "",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  }
];

// ---------- rescueToolCall ----------

test("rescueToolCall: extracts {tool, input} from fenced json", () => {
  const text = `I'll read the file.\n\n\`\`\`json\n{"tool": "read_file", "input": {"path": "/foo"}}\n\`\`\``;
  const got = rescueToolCall(text, tools);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "read_file");
  assert.deepEqual(got[0].input, { path: "/foo" });
});

test("rescueToolCall: accepts {name, arguments} (OpenAI shape)", () => {
  const text = "```\n" + JSON.stringify({ name: "read_file", arguments: { path: "/x" } }) + "\n```";
  const got = rescueToolCall(text, tools);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "read_file");
});

test("rescueToolCall: ignores unknown tool names", () => {
  const text = "```json\n" + JSON.stringify({ tool: "nope", input: {} }) + "\n```";
  assert.deepEqual(rescueToolCall(text, tools), []);
});

test("rescueToolCall: ignores invalid JSON", () => {
  const text = "```json\n{not json}\n```";
  assert.deepEqual(rescueToolCall(text, tools), []);
});

test("rescueToolCall: returns empty on empty text", () => {
  assert.deepEqual(rescueToolCall("", tools), []);
});

test("rescueToolCall: synthetic ids are unique within one call", () => {
  const text = `\`\`\`json\n{"tool": "read_file", "input": {"path": "/a"}}\n\`\`\`\n\`\`\`json\n{"tool": "read_file", "input": {"path": "/b"}}\n\`\`\``;
  const got = rescueToolCall(text, tools);
  assert.equal(got.length, 2);
  assert.notEqual(got[0].id, got[1].id);
});

// ---------- error classification ----------

test("validateToolArgs: throws ToolResolutionError on missing required arg", () => {
  assert.throws(
    () => validateToolArgs(tools[0], {}),
    (err: Error) => err instanceof ToolResolutionError && /missing required arg "path"/.test(err.message)
  );
});

test("validateToolArgs: ok when required args present", () => {
  validateToolArgs(tools[0], { path: "/x" });
});

test("ToolExecutionError is distinct from ToolResolutionError", () => {
  const a = new ToolExecutionError("x");
  const b = new ToolResolutionError("y");
  assert.equal(a.name, "ToolExecutionError");
  assert.equal(b.name, "ToolResolutionError");
  assert.ok(!(a instanceof ToolResolutionError));
});

// ---------- checkPrerequisites ----------

test("checkPrerequisites: returns null when no requires", () => {
  assert.equal(checkPrerequisites(tools[0], new Set()), null);
});

test("checkPrerequisites: returns null when all prereqs met", () => {
  const td = { ...tools[1], requires: ["read_file"] };
  assert.equal(checkPrerequisites(td, new Set(["read_file"])), null);
});

test("checkPrerequisites: soft error when prereq missing", () => {
  const td = { ...tools[1], requires: ["read_file"] };
  const err = checkPrerequisites(td, new Set());
  assert.ok(err && err.includes("PREREQUISITE_NOT_MET"));
  assert.ok(err && err.includes("read_file"));
});

test("checkPrerequisites: lists all missing prereqs", () => {
  const td = { ...tools[1], requires: ["read_file", "search_code"] };
  const err = checkPrerequisites(td, new Set());
  assert.ok(err && err.includes("read_file"));
  assert.ok(err && err.includes("search_code"));
});

// ---------- escalating nudges ----------

test("nudgeTierFor: tier progression", () => {
  assert.equal(nudgeTierFor(0, 100), 0);
  assert.equal(nudgeTierFor(49, 100), 0);
  assert.equal(nudgeTierFor(50, 100), 1);
  assert.equal(nudgeTierFor(69, 100), 1);
  assert.equal(nudgeTierFor(70, 100), 2);
  assert.equal(nudgeTierFor(84, 100), 2);
  assert.equal(nudgeTierFor(85, 100), 3);
  assert.equal(nudgeTierFor(99, 100), 3);
});

test("nudgeTierFor: handles small maxLoops", () => {
  assert.equal(nudgeTierFor(5, 10), 1);
  assert.equal(nudgeTierFor(9, 10), 3);
});

test("buildNudgeMessage: tier1 is gentle and prefixed", () => {
  const m = buildNudgeMessage(1, 5, 10, "emit_plan", []);
  assert.ok(m.startsWith("[SYSTEM]"));
  assert.ok(m.includes("5 of 10"));
  assert.ok(/consider/i.test(m));
});

test("buildNudgeMessage: tier2 includes called-tools summary", () => {
  const m = buildNudgeMessage(2, 7, 10, "emit_plan", ["read_file", "search_code"]);
  assert.ok(m.includes("read_file"));
  assert.ok(m.includes("search_code"));
});

test("buildNudgeMessage: tier3 is curt MUST language", () => {
  const m = buildNudgeMessage(3, 9, 10, "emit_plan", []);
  assert.ok(/MUST call emit_plan/.test(m));
});

// ---------- compaction ----------

function turn(text: string, toolName?: string): AssistantTurn {
  return {
    textBlocks: text ? [{ text }] : [],
    toolUses: toolName ? [{ id: `id-${toolName}`, name: toolName, input: {} }] : [],
    stopReason: "tool_use"
  };
}

function buildHistory(): ConvMessage[] {
  return [
    { role: "user", content: "Original task: fix the bug." },
    { role: "assistant", turn: turn("I will look at the file.", "read_file") },
    { role: "user", toolResults: [{ toolUseId: "id-read_file", content: "A".repeat(500) }] },
    { role: "user", content: "[SYSTEM] You have 5 of 10 loops remaining." },
    { role: "assistant", turn: turn("Now I will search.", "search_code") },
    { role: "user", toolResults: [{ toolUseId: "id-search_code", content: "B".repeat(500) }] },
    { role: "assistant", turn: turn("Reading another file.", "read_file") },
    { role: "user", toolResults: [{ toolUseId: "id-read_file", content: "C".repeat(500) }] },
    { role: "assistant", turn: turn("Final thought.", "emit_plan") }
  ];
}

test("compactMessages phase 1: drops nudges, truncates old tool_results", () => {
  const h = buildHistory();
  // recentTurns=1 → only the last 2 messages are preserved; the nudge at
  // index 3 ends up in the middle and should be dropped.
  const r = compactMessages(h, 1, 1);
  assert.equal(r.stats.nudgesDropped, 1);
  assert.ok(r.stats.toolResultsTruncated >= 1);
  // Original task is still message[0].
  assert.equal((r.messages[0] as { content: string }).content, "Original task: fix the bug.");
});

test("compactMessages phase 2: drops old tool_results entirely", () => {
  const h = buildHistory();
  const r = compactMessages(h, 2, 1);
  // recentTurns=1 → only last 2 messages preserved → many tool_results in middle to drop.
  assert.ok(r.stats.toolResultsDropped > 0);
});

test("compactMessages phase 3: strips reasoning blocks from old turns", () => {
  const h = buildHistory();
  const r = compactMessages(h, 3, 1);
  assert.ok(r.stats.reasoningBlocksStripped > 0);
});

test("compactMessages: preserves first message and last recentTurns*2 messages", () => {
  const h = buildHistory();
  const r = compactMessages(h, 2, 2);
  assert.equal(r.messages[0], h[0]);
  // Last 4 messages preserved by reference.
  for (let i = 0; i < 4; i++) {
    assert.equal(r.messages[r.messages.length - 1 - i], h[h.length - 1 - i]);
  }
});

test("compactMessages: empty input is safe", () => {
  const r = compactMessages([], 3);
  assert.deepEqual(r.messages, []);
  assert.equal(r.chars, 0);
});

test("estimateChars: counts content roughly", () => {
  const h: ConvMessage[] = [{ role: "user", content: "hello" }];
  assert.equal(estimateChars(h), 5);
});

test("chooseCompactionPhase: phase escalation", () => {
  assert.equal(chooseCompactionPhase(0, 100), 0);
  assert.equal(chooseCompactionPhase(60, 100), 0);
  assert.equal(chooseCompactionPhase(70, 100), 1);
  assert.equal(chooseCompactionPhase(85, 100), 2);
  assert.equal(chooseCompactionPhase(95, 100), 3);
});

test("chooseCompactionPhase: zero budget yields no action", () => {
  assert.equal(chooseCompactionPhase(1000, 0), 0);
});
