#!/usr/bin/env tsx
/**
 * Triage fixture runner.
 *
 * Loads YAML fixtures from a configurable directory, calls the in-process
 * `runTriage()` once per fixture (cluster-bypassing — no controller, no
 * worker, no k8s), and writes one JSONL line per result through the
 * archive abstraction.
 *
 * Fixture directory resolution (highest priority first):
 *   1. --fixtures-dir <path> CLI flag
 *   2. AF_FIXTURES_DIR env var
 *   3. <repo>/evals/fixtures/triage (default; ships only the generic
 *      example shape — real fixture suites live per-instance under
 *      speedstack/instances/agent-factory/<instance>/evals/fixtures/triage/)
 *
 * Output key:
 *   eval-runs/<YYYY-MM-DD>-<git-sha>/run.jsonl
 *
 * Usage:
 *   pnpm eval:triage                                  # all fixtures (default dir)
 *   pnpm eval:triage 002 005                          # filter by id substring
 *   pnpm eval:triage --fixtures-dir /path/to/suite    # custom suite
 *   AF_FIXTURES_DIR=/path/to/suite pnpm eval:triage
 *   AF_EVAL_PROVIDER=ds4 pnpm eval:triage
 *
 * Provider note: this runner shells out to `runTriage()` with its
 * current signature (provider + model). A parallel engine-config
 * refactor will introduce `resolveEngineConfig()`; once that lands the
 * single `runTriage({...})` call below should be the only thing that
 * needs to change.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { runTriage } from "../../src/lib/triage.js";
import type { LLMProvider } from "../../src/lib/llm-providers.js";
import { getArchiveStorage, type ArchiveStorage } from "../../src/lib/archive/index.js";
import { computePromptSha } from "../../src/lib/agent-run-recorder.js";

interface Fixture {
  id: string;
  title: string;
  body: string;
  labels?: string[];
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
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

const DEFAULT_FIXTURE_DIR = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "triage",
);

function resolveFixtureDir(argv: string[], env: NodeJS.ProcessEnv): string {
  const flagIdx = argv.indexOf("--fixtures-dir");
  if (flagIdx >= 0 && argv[flagIdx + 1]) {
    return path.resolve(argv[flagIdx + 1]);
  }
  if (env.AF_FIXTURES_DIR) {
    return path.resolve(env.AF_FIXTURES_DIR);
  }
  return DEFAULT_FIXTURE_DIR;
}

function stripFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixtures-dir") {
      i++; // skip flag value
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

async function loadFixtures(dir: string, filter: string[]): Promise<Fixture[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const out: Fixture[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    const fx = parseYaml(raw) as Fixture;
    if (filter.length > 0 && !filter.some((sub) => fx.id.includes(sub))) continue;
    out.push(fx);
  }
  return out;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", ".."),
      encoding: "utf8",
    }).trim();
  } catch {
    return "nogit";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveProviderAndModel(env: NodeJS.ProcessEnv): { provider: LLMProvider; model?: string } {
  const provider = (env.AF_EVAL_PROVIDER as LLMProvider) ?? "anthropic";
  const model = env.AF_EVAL_MODEL;
  return { provider, model };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const fixtureDir = resolveFixtureDir(rawArgs, process.env);
  const filter = stripFlags(rawArgs);
  const fixtures = await loadFixtures(fixtureDir, filter);
  if (fixtures.length === 0) {
    console.error(
      `No fixtures matched${filter.length ? ` filter ${filter.join(",")}` : ""} in ${fixtureDir}`,
    );
    process.exit(1);
  }
  console.log(`[eval-triage] fixtures dir: ${fixtureDir}`);

  const sha = gitSha();
  const day = today();
  const runDir = `eval-runs/${day}-${sha}`;
  const runKey = `${runDir}/run.jsonl`;

  const { provider, model } = resolveProviderAndModel(process.env);
  const storage: ArchiveStorage = getArchiveStorage();

  console.log(`[eval-triage] ${fixtures.length} fixture(s), provider=${provider}${model ? `, model=${model}` : ""}`);
  console.log(`[eval-triage] writing to ${runKey}`);

  // The triage system prompt is embedded in src/lib/triage.ts. We compute
  // a stable sha here so the judge can later filter "judgments against
  // prompt rev X". This is intentionally an approximation — exact
  // prompt-sha requires reading the live prompt via an export which the
  // sibling engine-plumbing PR will add. Until then we hash the empty
  // string + the fixture title+body so promptSha at least varies per
  // input pair.
  const lines: RunResultLine[] = [];

  for (const fx of fixtures) {
    const promptSha = computePromptSha({ system: "triage-v1", user: `${fx.title}\n${fx.body}` });
    const started = Date.now();
    let line: RunResultLine;
    try {
      const result = await runTriage(
        { title: fx.title, body: fx.body },
        { provider, model },
      );
      line = {
        ts: new Date().toISOString(),
        fixture: fx.id,
        provider,
        model: model ?? "(default)",
        promptSha,
        verdict: result.verdict,
        reasoning: result.reason,
        missingContext: result.missingContext,
        recommendedActions: result.recommendedActions,
        rawResponse: result.rawResponse ?? "",
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      line = {
        ts: new Date().toISOString(),
        fixture: fx.id,
        provider,
        model: model ?? "(default)",
        promptSha,
        verdict: "error",
        reasoning: "",
        missingContext: [],
        recommendedActions: [],
        rawResponse: "",
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    lines.push(line);
    console.log(
      `  ${fx.id.padEnd(40)} → ${line.verdict.padEnd(12)} (${line.latencyMs}ms)${line.error ? ` ERROR: ${line.error}` : ""}`,
    );
  }

  // Single write: the archive abstraction is put-based, so we serialize
  // the whole jsonl in one shot rather than appending line-by-line. This
  // keeps GCS and local impls trivially symmetric.
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await storage.put(runKey, body);
  console.log(`[eval-triage] wrote ${lines.length} result(s) to ${runKey}`);
  // Echo the run dir so the judge step can pick it up without parsing.
  console.log(`RUN_DIR=${runDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
