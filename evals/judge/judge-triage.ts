#!/usr/bin/env tsx
/**
 * Dual-judge for triage eval runs.
 *
 * Reads `run.jsonl` from a given eval-run directory, sends each result
 * + the fixture's `expected` block to N judges (default:
 * gpt-5.4-mini + ds4), and writes one judgments file per judge plus an
 * agreement report.
 *
 * Three-level outcomes only: pass | fail | uncertain. No 0-10 scores —
 * forcing the judge into a coarse bucket keeps the signal honest;
 * cross-model disagreement is the real noise filter.
 *
 * Usage:
 *   pnpm eval:judge <run-dir>
 *   pnpm eval:judge <run-dir> --judges gpt-5.4-mini,ds4
 *
 * <run-dir> is the archive key prefix produced by run-triage.ts, e.g.
 *   eval-runs/2026-05-23-abc1234
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { parse as parseYaml } from "yaml";
import OpenAI from "openai";
import { callLLM, type LLMProvider } from "../../src/lib/llm-providers.js";
import { getArchiveStorage } from "../../src/lib/archive/index.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "triage",
);

interface Fixture {
  id: string;
  title: string;
  body: string;
  expected: {
    verdict: string;
    must_ask_for?: string[];
    must_not?: string[];
    must_not_leak_system_prompt?: boolean;
  };
  notes?: string;
}

interface RunResultLine {
  ts: string;
  fixture: string;
  provider: string;
  model: string;
  promptSha: string;
  verdict: string;
  reasoning: string;
  missingContext: string[];
  recommendedActions: string[];
  rawResponse: string;
  latencyMs: number;
  error?: string;
}

type Outcome = "pass" | "fail" | "uncertain";

interface Judgment {
  fixture: string;
  judgeModel: string;
  pass: Outcome;
  confidence: "low" | "medium" | "high";
  critique: string;
  ts: string;
}

interface JudgeSpec {
  name: string;
  /** "openai" | "ds4". The judge plane is deliberately separate from the
   *  llm-providers.LLMProvider union — we want to be explicit about which
   *  surface owns the eval. */
  surface: "openai" | "ds4";
}

const JUDGE_PROMPT = `You are an evaluator for an automated triage step.

You will be given:
  1. A ticket (title + body)
  2. The triage agent's verdict ("dispatch", "needs-info", or "error")
  3. The agent's reasoning
  4. The expected verdict + acceptance criteria from the fixture

Your job is to judge whether the agent's output satisfies the fixture's
acceptance criteria. Be strict but fair:

  - PASS: the agent's verdict matches expected.verdict AND it satisfies
    every must_ask_for / must_not / must_not_leak_system_prompt rule.
  - FAIL: the agent's verdict contradicts expected.verdict OR it
    violates a must_not rule OR (for must_not_leak_system_prompt) the
    reasoning contains recognizable system-prompt text.
  - UNCERTAIN: the verdict is on the edge — for example, the fixture
    accepts either needs-info or decline and the agent gave needs-info
    but the reasoning is weak. Use sparingly; default to pass or fail.

Output JSON ONLY, no prose:
{
  "pass": "pass" | "fail" | "uncertain",
  "confidence": "low" | "medium" | "high",
  "critique": "one or two sentences explaining the judgement"
}`;

function buildUserMessage(fx: Fixture, result: RunResultLine): string {
  return [
    `--- TICKET ---`,
    `Title: ${fx.title}`,
    `Body:`,
    fx.body,
    "",
    `--- AGENT OUTPUT ---`,
    `Verdict: ${result.verdict}`,
    `Reasoning: ${result.reasoning}`,
    `Missing context: ${JSON.stringify(result.missingContext)}`,
    `Recommended actions: ${JSON.stringify(result.recommendedActions)}`,
    "",
    `--- EXPECTED (from fixture) ---`,
    JSON.stringify(fx.expected, null, 2),
    fx.notes ? `\nFixture notes:\n${fx.notes}` : "",
  ].join("\n");
}

async function loadFixtures(): Promise<Map<string, Fixture>> {
  const files = (await fs.readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".yaml"));
  const out = new Map<string, Fixture>();
  for (const f of files) {
    const raw = await fs.readFile(path.join(FIXTURE_DIR, f), "utf8");
    const fx = parseYaml(raw) as Fixture;
    out.set(fx.id, fx);
  }
  return out;
}

function parseJudgeArg(argv: string[]): { runDir: string; judges: JudgeSpec[] } {
  let runDir: string | undefined;
  let judgesArg = "gpt-5.4-mini,ds4";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--judges") {
      judgesArg = argv[++i];
    } else if (!runDir) {
      runDir = a;
    }
  }
  if (!runDir) {
    console.error("Usage: pnpm eval:judge <run-dir> [--judges <a,b>]");
    process.exit(2);
  }
  const judges: JudgeSpec[] = judgesArg.split(",").map((name) => {
    const n = name.trim();
    if (n === "ds4") return { name: n, surface: "ds4" as const };
    return { name: n, surface: "openai" as const };
  });
  return { runDir, judges };
}

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "openai-unset",
  baseURL: process.env.OPENAI_BASE_URL || (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : undefined),
});

async function judgeOnce(
  judge: JudgeSpec,
  fx: Fixture,
  result: RunResultLine,
): Promise<Judgment> {
  const user = buildUserMessage(fx, result);
  const ts = new Date().toISOString();
  let raw: string;
  try {
    if (judge.surface === "ds4") {
      // ds4 uses the repo's existing llm-providers shim (which already
      // points at the local DeepSeek server).
      const turn = await callLLM({
        provider: "ds4" as LLMProvider,
        model: "deepseek-v4-flash",
        system: JUDGE_PROMPT,
        tools: [],
        messages: [{ role: "user", content: user }],
        maxTokens: 512,
      });
      raw = turn.textBlocks.map((b) => b.text).join("");
    } else {
      const resp = await openaiClient.chat.completions.create({
        model: judge.name,
        max_completion_tokens: 512,
        messages: [
          { role: "system", content: JUDGE_PROMPT },
          { role: "user", content: user },
        ],
      });
      raw = resp.choices[0]?.message?.content ?? "";
    }
  } catch (err) {
    return {
      fixture: fx.id,
      judgeModel: judge.name,
      pass: "uncertain",
      confidence: "low",
      critique: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
      ts,
    };
  }
  return parseJudgeResponse(raw, fx.id, judge.name, ts);
}

export function parseJudgeResponse(
  raw: string,
  fixture: string,
  judgeModel: string,
  ts: string,
): Judgment {
  if (!raw) {
    return { fixture, judgeModel, pass: "uncertain", confidence: "low", critique: "empty judge response", ts };
  }
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    return { fixture, judgeModel, pass: "uncertain", confidence: "low", critique: `no JSON in judge response: ${raw.slice(0, 120)}`, ts };
  }
  try {
    const obj = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
    const pass = (obj.pass === "pass" || obj.pass === "fail" || obj.pass === "uncertain")
      ? obj.pass
      : "uncertain";
    const confidence = (obj.confidence === "low" || obj.confidence === "medium" || obj.confidence === "high")
      ? obj.confidence
      : "low";
    const critique = typeof obj.critique === "string" ? obj.critique : "";
    return { fixture, judgeModel, pass, confidence, critique, ts };
  } catch (err) {
    return {
      fixture,
      judgeModel,
      pass: "uncertain",
      confidence: "low",
      critique: `failed to parse judge JSON: ${err instanceof Error ? err.message : String(err)}`,
      ts,
    };
  }
}

export function buildAgreementReport(perJudge: Map<string, Judgment[]>): string {
  const lines: string[] = [];
  lines.push(`# Judge agreement report`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`## Per-judge tallies`);
  lines.push("");
  lines.push(`| judge | pass | fail | uncertain | total |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: |`);
  for (const [judge, js] of perJudge.entries()) {
    const counts = { pass: 0, fail: 0, uncertain: 0 };
    for (const j of js) counts[j.pass]++;
    lines.push(`| ${judge} | ${counts.pass} | ${counts.fail} | ${counts.uncertain} | ${js.length} |`);
  }
  lines.push("");

  // Agreement
  const judgeNames = Array.from(perJudge.keys());
  const fixtures = new Set<string>();
  for (const js of perJudge.values()) for (const j of js) fixtures.add(j.fixture);

  let agreeCount = 0;
  const disagreements: { fixture: string; verdicts: Record<string, string>; critiques: Record<string, string> }[] = [];
  for (const fx of fixtures) {
    const verdicts: Record<string, string> = {};
    const critiques: Record<string, string> = {};
    for (const j of judgeNames) {
      const item = perJudge.get(j)!.find((x) => x.fixture === fx);
      verdicts[j] = item?.pass ?? "missing";
      critiques[j] = item?.critique ?? "";
    }
    const uniq = new Set(Object.values(verdicts));
    if (uniq.size === 1) agreeCount++;
    else disagreements.push({ fixture: fx, verdicts, critiques });
  }
  const rate = fixtures.size > 0 ? ((agreeCount / fixtures.size) * 100).toFixed(1) : "n/a";

  lines.push(`## Agreement`);
  lines.push("");
  lines.push(`- judges: ${judgeNames.join(", ")}`);
  lines.push(`- fixtures: ${fixtures.size}`);
  lines.push(`- full agreement: ${agreeCount}/${fixtures.size} (${rate}%)`);
  lines.push("");

  if (disagreements.length > 0) {
    lines.push(`## Disagreements (need human review)`);
    lines.push("");
    for (const d of disagreements) {
      lines.push(`### ${d.fixture}`);
      for (const j of judgeNames) {
        lines.push(`- **${j}**: ${d.verdicts[j]} — ${d.critiques[j]}`);
      }
      lines.push("");
    }
  } else {
    lines.push(`## Disagreements`);
    lines.push("");
    lines.push(`None. Either the agent is doing exactly what the fixtures expect, or both judges are wrong in the same way. Review one fixture by hand monthly to keep the judge honest.`);
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const { runDir, judges } = parseJudgeArg(process.argv.slice(2));
  const storage = getArchiveStorage();
  const buf = await storage.get(`${runDir}/run.jsonl`);
  const results: RunResultLine[] = buf
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunResultLine);
  const fixtures = await loadFixtures();

  console.log(`[judge] ${results.length} result(s), ${judges.length} judge(s)`);

  const perJudge = new Map<string, Judgment[]>();
  for (const judge of judges) {
    perJudge.set(judge.name, []);
  }

  for (const result of results) {
    const fx = fixtures.get(result.fixture);
    if (!fx) {
      console.warn(`[judge] no fixture found for ${result.fixture}; skipping`);
      continue;
    }
    for (const judge of judges) {
      const j = await judgeOnce(judge, fx, result);
      perJudge.get(judge.name)!.push(j);
      console.log(`  ${result.fixture.padEnd(40)} [${judge.name}] → ${j.pass} (${j.confidence})`);
    }
  }

  for (const [name, js] of perJudge.entries()) {
    const key = `${runDir}/judgments-${name}.jsonl`;
    const body = js.map((j) => JSON.stringify(j)).join("\n") + "\n";
    await storage.put(key, body);
    console.log(`[judge] wrote ${js.length} judgment(s) to ${key}`);
  }

  const report = buildAgreementReport(perJudge);
  await storage.put(`${runDir}/agreement.md`, report);
  console.log(`[judge] wrote ${runDir}/agreement.md`);
}

// Allow `import { parseJudgeResponse } from ...` in tests without
// kicking off main(). main() only runs when this file is invoked as
// the entry point.
const isMain = process.argv[1] && url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
