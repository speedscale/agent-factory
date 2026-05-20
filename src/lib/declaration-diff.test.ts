import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTopLevelDeclarations, diffDeclarations } from "./declaration-diff.js";

test("Go: extracts top-level funcs and types", () => {
  const src = `package foo

import "fmt"

func Helper() string { return "" }

func (r *Recv) Method() {}

type Config struct {
\tName string
}

const Version = "1.0"
`;
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got].sort(), ["Config", "Helper", "Method", "Version"]);
});

test("Go: nested funcs are NOT picked up (column 0 only)", () => {
  const src = `func Outer() {
\tinner := func() string { return "" }
\t_ = inner
}
`;
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got], ["Outer"]);
});

test("TypeScript: function, class, const, interface", () => {
  const src = `import { x } from "./y";

export function classify(spec: Spec): Mode { return "traffic"; }

export interface Spec { title: string; }

export const DEFAULT = 42;

class Helper {
  greet() { return "hi"; }
}
`;
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got].sort(), ["DEFAULT", "Helper", "Spec", "classify"]);
});

test("TypeScript: async function detected", () => {
  const src = `export async function fetchUser(id: string) { return null; }`;
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got], ["fetchUser"]);
});

test("Python: def, async def, class", () => {
  const src = `import os

def helper():
    return None

async def fetch_user(id):
    pass

class Config:
    pass
`;
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got].sort(), ["Config", "fetch_user", "helper"]);
});

test("Rust: pub fn / fn / struct", () => {
  const src = `pub fn parse(input: &str) -> Result<Ast, Error> { todo!() }

fn helper() -> u32 { 0 }

pub struct Ast { kids: Vec<u32> }
`;
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got].sort(), ["Ast", "helper", "parse"]);
});

test("CRLF line endings are handled", () => {
  const src = "func Alpha() {}\r\nfunc Beta() {}\r\n";
  const got = extractTopLevelDeclarations(src);
  assert.deepEqual([...got].sort(), ["Alpha", "Beta"]);
});

test("diff: removed list catches a deleted helper", () => {
  const before = `func Stay() {}\nfunc Drop() {}\n`;
  const after = `func Stay() {}\n`;
  const d = diffDeclarations(before, after);
  assert.deepEqual(d.removed, ["Drop"]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.preserved, ["Stay"]);
});

test("diff: added list catches a new function", () => {
  const before = `func Stay() {}\n`;
  const after = `func Stay() {}\nfunc NewlyAdded() {}\n`;
  const d = diffDeclarations(before, after);
  assert.deepEqual(d.added, ["NewlyAdded"]);
  assert.deepEqual(d.removed, []);
});

test("diff: identical files produce empty added/removed", () => {
  const src = `func A() {}\nfunc B() {}\n`;
  const d = diffDeclarations(src, src);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.preserved, ["A", "B"]);
});

test("acceptance scenario: the destructive-rewrite failure mode this catches", () => {
  // Reproducing the actual failure mode: an agent applies a 4-line behavioral
  // change near the top of a file but, because write_file is full-content
  // overwrite, drops two unrelated helper functions further down. Those
  // helpers are referenced from elsewhere in the same file — the resulting
  // code does not compile. The Evaluator should reject this even though the
  // intentional change is correct.
  const before = `package cmd

import "fmt"

func runLive() {
\tif cfg.TestReportID == "" {
\t\tcfg.TestReportID = newRandomUUID()
\t}
\t_ = getTestConfig()
\t_ = getLocalIP()
}

func getTestConfig() error { return nil }

func getLocalIP() string { return "127.0.0.1" }
`;
  const after = `package cmd

import "fmt"

func runLive() {
\tif cfg.TestReportID == "" {
\t\tlog.Fatal("TEST_REPORT_ID required")
\t}
\t_ = getTestConfig()
\t_ = getLocalIP()
}
`;
  const d = diffDeclarations(before, after);
  assert.deepEqual(d.removed, ["getLocalIP", "getTestConfig"]);
  assert.deepEqual(d.added, []);
});
