/**
 * llm-run — end-to-end LLM engine spike.
 *
 * Runs the Planner → Worker loop using the Claude Agent SDK against a real
 * snapshot and source directory. This is the engine spike from §14 item 6.
 *
 * Usage:
 *   npm run llm-run -- \
 *     --title "Gmail sync getting 429 errors" \
 *     --body  "The radar service Gmail sync intermittently fails with 429 Too Many Requests from gmail.googleapis.com" \
 *     --snapshot /path/to/snapshot/inner-dir \
 *     --source  /path/to/service/src \
 *     --repo    /path/to/service           (git repo root — enables worktree isolation) \
 *     --branch  agent/s-10886-radar-perf   (branch name; derived from --title if omitted) \
 *     --workdir /tmp/llm-run-work \
 *     [--provider anthropic|openrouter|ds4|omlx] (env fallback: AF_ENGINE_KIND via resolveEngineConfig) \
 *     [--model <id>]                              (env fallback: AF_ENGINE_MODEL; ultimate default: defaultModelFor(provider)) \
 *     [--no-triage]                               (skip the pre-dispatch fitness check) \
 *     [--no-context-check]                        (skip the repro-context safety net; use when an artifact format is the deliverable, not the input) \
 *     [--no-checklist-check]                      (skip the multi-deliverable gate; use when N parallel asks share enough scaffolding for one dispatch) \
 *     [--no-eval]                                 (skip the post-Worker Evaluator phase) \
 *     [--instance <name>]                         (override AF_INSTANCE for this run; tags logs so multi-instance deployments stay distinguishable) \
 *     [--verbose]
 *
 * When --repo is provided, a git worktree is created at <workdir>/repo on a
 * new branch BEFORE the Planner phase, so every phase that can write (the
 * source-mode Planner writes the baseline harness; the Worker writes the fix)
 * operates inside the worktree. A write guard on the engine tools rejects or
 * reroots any mutation that targets the live checkout — the main checkout is
 * never modified (AGENTS.md: worktree per run).
 *
 * Measures:
 *   - Time to first useful plan (Planner phase)
 *   - Fix produced (Worker phase)
 *   - Confirm result (Worker phase)
 */

import path from "node:path";
import { exec } from "node:child_process";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { runPlanner, runWorker, runPlannerSource, runWorkerSource, runEvaluator, setupWorktree, teardownWorktree } from "../lib/llm-engine.js";
import type { EmitPlanResult, EmitPlanSourceResult, AnyPlanResult, WorktreeResult } from "../lib/llm-engine.js";
import { resolveEngineConfig } from "../lib/engine-config.js";
import { defaultModelFor, type LLMProvider } from "../lib/llm-providers.js";
import { classifySpec } from "../lib/spec-classifier.js";
import { detectReproContext } from "../lib/repro-context-detector.js";
import { detectChecklist, formatChecklistReport } from "../lib/checklist-detector.js";
import { formatMisses, verdictGloss } from "../lib/eval-verdict.js";
import { getInstanceConfig, formatInstanceBanner } from "../lib/instance-config.js";
import { runTriage, formatTriageReport } from "../lib/triage.js";
import { MR_CHECKLIST } from "../lib/mr-checklist.js";

const execAsync = promisify(exec);

// MR_CHECKLIST and the literal-grep contract live in src/lib/mr-checklist.ts
// so the constant + the madskillz hook's REQUIRED array stay testable and in
// sync. See that file's doc comment for why boxes use [x] rather than [ ].

function getArg(argv: string[], flags: string[]): string | undefined {
  const i = argv.findIndex((v) => flags.includes(v));
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], flags: string[]): boolean {
  return argv.some((v) => flags.includes(v));
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

async function snapshotHasContent(dir: string | undefined): Promise<boolean> {
  if (!dir) return false;
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return false;
    const entries = await readdir(dir);
    // Any non-hidden entry is enough — the directory contains *something*.
    return entries.some((e) => !e.startsWith("."));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const title = getArg(argv, ["--title", "-t"]) ?? "Service is returning unexpected errors";
  const body = getArg(argv, ["--body", "-b"]) ?? "Investigate and fix the root cause.";
  const snapshotDir = getArg(argv, ["--snapshot", "-s"]);
  const sourceDir = getArg(argv, ["--source"]);
  const repoDir = getArg(argv, ["--repo", "-r"]);
  const branchName = getArg(argv, ["--branch"]) ?? (repoDir ? `agent/${slugify(title)}` : undefined);
  const workDir = getArg(argv, ["--workdir", "-w"]) ?? path.join(process.cwd(), ".llm-run-work");
  const verbose = hasFlag(argv, ["--verbose", "-v"]);
  const skipEval = hasFlag(argv, ["--no-eval"]);
  const skipTriage = hasFlag(argv, ["--no-triage"]);
  const skipContextCheck = hasFlag(argv, ["--no-context-check"]);
  const skipChecklistCheck = hasFlag(argv, ["--no-checklist-check"]);
  const instanceOverride = getArg(argv, ["--instance"]);
  const instanceCfg = getInstanceConfig(process.env, { instance: instanceOverride });
  // Resolve engine config: CLI flags win, then env (AF_ENGINE_KIND / AF_ENGINE_MODEL
  // via resolveEngineConfig), then the chart-aligned default ("claude-sdk" → anthropic
  // with the per-provider default model). No silent "anthropic" fallback — a
  // misconfigured BYOC deployment must surface, not quietly hit Anthropic.
  const providerFlag = getArg(argv, ["--provider", "-p"]);
  const modelFlag = getArg(argv, ["--model", "-m"]);
  const envCfg = resolveEngineConfig(process.env);
  let provider: LLMProvider;
  if (providerFlag === undefined) {
    provider = envCfg.provider;
  } else if (providerFlag === "anthropic" || providerFlag === "openrouter" || providerFlag === "ds4" || providerFlag === "omlx") {
    provider = providerFlag;
  } else {
    console.error(`unknown provider: ${providerFlag}. Expected one of: anthropic, openrouter, ds4, omlx`);
    process.exit(1);
  }
  // `defaultModelFor(provider)` is the same fallback resolveEngineConfig uses when
  // AF_ENGINE_MODEL is unset, so we don't need to import it here — envCfg.model is
  // always a string.
  const model: string = modelFlag ?? (providerFlag === undefined ? envCfg.model : defaultModelFor(provider));

  const modeArg = (getArg(argv, ["--mode"]) ?? "auto").toLowerCase();
  if (modeArg !== "auto" && modeArg !== "traffic" && modeArg !== "source") {
    console.error(`unknown mode: ${modeArg}. Expected one of: auto, traffic, source`);
    process.exit(1);
  }
  const labelsArg = getArg(argv, ["--labels"]);
  const labels = labelsArg ? labelsArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  // Decide mode. In traffic mode a snapshot is required; in source mode it's optional.
  let mode: "traffic" | "source";
  let classifierRationale: string[] | undefined;
  let classifierScores: { traffic: number; source: number } | undefined;
  if (modeArg === "traffic" || modeArg === "source") {
    mode = modeArg;
  } else {
    const snapshotAvailable = await snapshotHasContent(snapshotDir);
    const c = classifySpec({ title, body, labels, snapshotAvailable });
    classifierRationale = c.rationale;
    classifierScores = c.scores;
    // "mixed" today picks the dominant signal and emits a warning; future work
    // is to split into two child runs. The operator can override with --mode.
    mode = c.mode === "mixed"
      ? (c.scores.traffic >= c.scores.source ? "traffic" : "source")
      : c.mode;
    if (c.mode === "mixed") {
      console.warn(`[classifier] mixed-shape spec detected (traffic=${c.scores.traffic}, source=${c.scores.source}); picking ${mode} for this run. Consider splitting into two dispatches.`);
    }
  }

  if (mode === "traffic" && !snapshotDir) {
    console.error("traffic mode requires --snapshot <dir>. Use --mode source (or omit and let the classifier choose) for tickets without wire evidence.");
    console.error("usage: llm-run [--mode auto|traffic|source] [--snapshot <dir>] [--source <dir>] [--labels a,b,c] [--repo <dir>] [--branch <name>] [--title <str>] [--body <str>] [--workdir <dir>] [--provider anthropic|openrouter|ds4|omlx] [--model <id>] [--no-triage] [--no-context-check] [--no-checklist-check] [--no-eval] [--verbose]");
    process.exit(1);
  }

  // Safety net: if mode resolved to source but the ticket references external
  // reproduction context (HTTP captures, logs, traces, stack traces, repro
  // repos, etc.) that the engine doesn't have on hand, refuse rather than
  // fall back to a synthetic Planner-authored harness. That fallback produces
  // a circular reproduce gate — the same LLM authors both the failing
  // assertion and the harness that proves it false, so "harness fails on
  // master" only confirms the model's bug model is self-consistent. The
  // operator should acquire the referenced artifacts and supply them.
  if (mode === "source") {
    if (skipContextCheck) {
      console.warn("[repro-context] gate bypassed by --no-context-check at operator's request");
    } else {
      const rc = detectReproContext({ title, body });
      if (rc.detected) {
        const snapshotOk = await snapshotHasContent(snapshotDir);
        if (!snapshotOk) {
          console.error(
            `source mode refused: the ticket references external reproduction context ` +
            `(${rc.signals.join(", ")}) but no usable repro input was supplied to the engine.\n` +
            `Falling back to a synthetic Planner-authored harness here would produce ` +
            `a circular reproduce gate. Either:\n` +
            `  1. Acquire the referenced artifact(s) and re-dispatch with --snapshot <dir> ` +
            `pointing at a real recording (use --mode traffic if the bug is wire-shaped); OR\n` +
            `  2. Re-capture the reproduction (follow the ticket's repro steps) and supply ` +
            `it the same way; OR\n` +
            `  3. Pass --no-context-check if the format mention is the deliverable, not ` +
            `an input the engine needs to acquire (e.g. "add a Postman exporter").`
          );
          process.exit(1);
        }
      }
    }
  }

  await mkdir(workDir, { recursive: true });

  console.log(formatInstanceBanner(instanceCfg, "llm-run"));
  console.log(JSON.stringify({ phase: "start", instance: instanceCfg.instance, title, mode, snapshotDir, sourceDir, repoDir, branchName, workDir, provider, model, classifierRationale, classifierScores }, null, 2));

  // ---- Checklist phase (pre-Planner) ----
  // The Planner emits one failing assertion per dispatch and the Worker may
  // deliver only the first item from a multi-deliverable spec. Refuse here
  // with a reviewer-ready report so the operator can split the ticket in
  // Linear before re-dispatching. Deterministic pattern check — runs before
  // the (more expensive) triage LLM call so obvious split cases skip it.
  // Skipped via --no-checklist-check.
  if (!skipChecklistCheck) {
    const checklist = detectChecklist({ title, body });
    if (checklist.verdict === "needs-split") {
      console.log(JSON.stringify({ phase: "checklist", verdict: checklist.verdict, signal: checklist.signal, subDeliverables: checklist.subDeliverables }, null, 2));
      const checklistOutput = path.join(workDir, "checklist.json");
      await writeFile(checklistOutput, JSON.stringify(checklist, null, 2), "utf8");
      console.error("\n" + formatChecklistReport(checklist));
      console.error("\nDispatch aborted — the spec lists multiple parallel deliverables; the engine produces one fix per dispatch.");
      console.error("Split into one Linear ticket per sub-deliverable and re-dispatch each; pass --no-checklist-check to bypass.");
      process.exit(2);
    }
  } else {
    console.warn("[checklist] gate bypassed by --no-checklist-check at operator's request");
  }

  // ---- Triage phase (pre-Planner) ----
  // Decides whether the engine has enough information to attempt the ticket.
  // If not, abort with a reviewer-ready report so a human can improve the spec
  // before re-dispatch. Skipped via --no-triage.
  if (!skipTriage) {
    console.log("\n=== TRIAGE PHASE ===");
    try {
      const triageResult = await runTriage({ title, body }, { provider, model, verbose });
      console.log(JSON.stringify({ phase: "triaged", verdict: triageResult.verdict, reason: triageResult.reason, missingContext: triageResult.missingContext, recommendedActions: triageResult.recommendedActions }, null, 2));
      const triageOutput = path.join(workDir, "triage.json");
      await writeFile(triageOutput, JSON.stringify(triageResult, null, 2), "utf8");

      if (triageResult.verdict === "needs-info") {
        console.error("\n" + formatTriageReport(triageResult));
        console.error("\nDispatch aborted — the spec needs more context before the engine can act on it.");
        console.error("Add the missing items to the ticket and re-dispatch; pass --no-triage to bypass this check.");
        process.exit(2);
      }
    } catch (err) {
      // Triage failures (e.g. LLM unreachable, response unparseable) should
      // not silently degrade into a real dispatch. Print and abort so the
      // operator can either fix the call or pass --no-triage to bypass.
      console.error(`Triage step failed: ${(err as Error).message}`);
      console.error("Pass --no-triage to bypass this check if intentional.");
      process.exit(1);
    }
  }

  // ---- Worktree setup (pre-Planner) ----
  // AGENTS.md core rule: worktree per run. The worktree is created BEFORE the
  // Planner so every phase that can write is confined to it — the source-mode
  // Planner writes the baseline harness colocated with the source, and without
  // a worktree at that point it would land in the operator's live checkout.
  let worktree: WorktreeResult | undefined;
  if (repoDir && branchName) {
    worktree = await setupWorktree(repoDir, workDir, branchName, sourceDir ?? repoDir);
    console.log(`[engine] worktree: ${worktree.worktreePath} (branch: ${worktree.branchName})`);
  }

  // ---- Planner phase ----
  const plannerStart = Date.now();
  console.log(`\n=== PLANNER PHASE (${mode}) ===`);

  let planResult: AnyPlanResult;
  try {
    planResult = mode === "traffic"
      ? await runPlanner({ title, body }, { snapshotDir, sourceDir, workDir, verbose, provider, model, repoDir, worktree })
      : { ...await runPlannerSource({ title, body }, { snapshotDir, sourceDir, workDir, verbose, provider, model, repoDir, worktree }), mode: "source" as const };
  } catch (err) {
    // No patch will be produced — remove the worktree + branch so a failed
    // Planner (e.g. reproduce gate rejection) doesn't litter the target repo.
    if (worktree && repoDir) {
      await teardownWorktree(repoDir, worktree.worktreePath, worktree.branchName);
    }
    throw err;
  }

  const plannerMs = Date.now() - plannerStart;
  const planOutput = path.join(workDir, "plan.json");
  await writeFile(planOutput, JSON.stringify(planResult, null, 2), "utf8");

  const planLog: Record<string, unknown> = {
    phase: "planned",
    durationMs: plannerMs,
    mode,
    summary: planResult.plan.spec.summary,
    hypothesis: planResult.plan.spec.hypothesis,
    planFile: planOutput
  };
  if (mode === "traffic") {
    planLog.metric = (planResult as EmitPlanResult).metric;
    planLog.baseline = (planResult as EmitPlanResult).baseline;
  } else {
    const sp = planResult as EmitPlanSourceResult;
    planLog.failingAssertion = sp.failingAssertion;
    planLog.assertionShape = sp.assertionShape;
    planLog.baselineHarnessPath = sp.baselineEvidence.harnessPath;
    planLog.baselineExitCode = sp.baselineEvidence.exitCode;
    planLog.baselineOutputPreview = sp.baselineEvidence.output.slice(0, 200);
  }
  console.log(JSON.stringify(planLog, null, 2));

  // ---- Worker phase ----
  const workerStart = Date.now();
  console.log(`\n=== WORKER PHASE (${mode}) ===`);

  const patchResult = mode === "traffic"
    ? await runWorker(planResult as EmitPlanResult, { snapshotDir, sourceDir, workDir, verbose, repoDir, branchName, provider, model, worktree })
    : await runWorkerSource(planResult as EmitPlanSourceResult, { snapshotDir, sourceDir, workDir, verbose, repoDir, branchName, provider, model, worktree });

  const workerMs = Date.now() - workerStart;
  const patchOutput = path.join(workDir, "patch.json");
  await writeFile(patchOutput, JSON.stringify(patchResult, null, 2), "utf8");

  console.log(JSON.stringify({
    phase: "patched",
    durationMs: workerMs,
    targetFile: patchResult.filePath,
    worktreePath: patchResult.worktreePath,
    branchName: patchResult.branchName,
    harnessPath: patchResult.harnessPath,
    confirmResult: patchResult.confirmResult,
    patchFile: patchOutput
  }, null, 2));

  // ---- Evaluator phase ----
  let evalResult: Awaited<ReturnType<typeof runEvaluator>> | undefined;
  let evaluatorMs = 0;
  if (!skipEval) {
    const evaluatorStart = Date.now();
    console.log("\n=== EVALUATOR PHASE ===");

    // Evaluator reads from the patched source — use worktree path if Worker created one.
    const evalSourceDir = patchResult.worktreePath
      ? patchResult.worktreePath + (sourceDir && repoDir ? sourceDir.slice(repoDir.length) : "")
      : sourceDir;

    try {
      evalResult = await runEvaluator(
        { title, body },
        planResult,
        patchResult,
        { snapshotDir, sourceDir: evalSourceDir, workDir, verbose, provider, model }
      );

      evaluatorMs = Date.now() - evaluatorStart;
      const evalOutput = path.join(workDir, "eval-report.json");
      await writeFile(evalOutput, JSON.stringify(evalResult, null, 2), "utf8");

      const blockerCount = evalResult.missedRequirements.filter((m) => m.severity === "blocker").length;
      const softCount = evalResult.missedRequirements.filter((m) => m.severity === "soft").length;

      console.log(JSON.stringify({
        phase: "evaluated",
        durationMs: evaluatorMs,
        verdict: evalResult.overallVerdict,
        modelVerdict: evalResult.modelVerdict,
        addressed: evalResult.addressedRequirements.length,
        missedBlocker: blockerCount,
        missedSoft: softCount,
        confirmTrustworthy: evalResult.confirmHarnessTrustworthy,
        reportFile: evalOutput
      }, null, 2));

      console.log(`\nVerdict: ${verdictGloss(evalResult.overallVerdict)}`);

      if (evalResult.missedRequirements.length > 0) {
        console.log("\nMissed requirements:");
        console.log(formatMisses(evalResult.missedRequirements));
      }
    } catch (err) {
      console.warn(`Evaluator phase failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Auto MR creation ----
  let mrUrl: string | undefined;
  if (patchResult.worktreePath && patchResult.branchName && repoDir) {
    console.log("\n=== CREATING MR ===");
    try {
      const verdictSection = evalResult
        ? [
            `## Evaluator verdict`,
            ``,
            `**${verdictGloss(evalResult.overallVerdict)}**`,
            ``,
            evalResult.missedRequirements.length > 0
              ? `Missed requirements:\n\n\`\`\`\n${formatMisses(evalResult.missedRequirements)}\n\`\`\``
              : `No missed requirements.`,
            ``,
            `Confirm harness trustworthy: ${evalResult.confirmHarnessTrustworthy ? "yes" : "**no**"}. ${evalResult.confirmHarnessNotes}`
          ].join("\n")
        : `## Evaluator verdict\n\n(skipped or failed — see run logs)`;

      const mrBody = [
        `## Summary\n\n${patchResult.rationale}`,
        verdictSection,
        `## Confirm harness\n\n\`\`\`\n${patchResult.confirmResult ?? "(not run)"}\n\`\`\``,
        `## Test plan\n\n- [ ] Review confirm harness output above\n- [ ] Deploy to staging and verify metric improvement`,
        MR_CHECKLIST,
        `🤖 Generated with [Agent Factory](https://github.com/speedscale/agent-factory)`
      ].join("\n\n");

      const mrTitle = title.length > 70 ? title.slice(0, 67) + "..." : title;
      const tmpBodyFile = path.join(os.tmpdir(), `mr-body-${Date.now()}.md`);
      await writeFile(tmpBodyFile, mrBody, "utf8");
      try {
        const { stdout } = await execAsync(
          `cd ${JSON.stringify(patchResult.worktreePath)} && glab mr create --title ${JSON.stringify(mrTitle)} --description-file ${JSON.stringify(tmpBodyFile)} --source-branch ${JSON.stringify(patchResult.branchName)} --no-editor 2>&1 || gh pr create --title ${JSON.stringify(mrTitle)} --body-file ${JSON.stringify(tmpBodyFile)} --head ${JSON.stringify(patchResult.branchName)} 2>&1`
        );
        mrUrl = stdout.trim().split("\n").find(l => l.startsWith("http")) ?? stdout.trim();
        console.log(`MR created: ${mrUrl}`);
      } finally {
        await unlink(tmpBodyFile).catch(() => {});
      }
    } catch (err) {
      console.warn(`MR creation failed (create manually): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({
    plannerMs,
    workerMs,
    evaluatorMs: evaluatorMs || undefined,
    totalMs: plannerMs + workerMs + evaluatorMs,
    mode,
    metric: mode === "traffic" ? (planResult as EmitPlanResult).metric : undefined,
    baseline: mode === "traffic" ? (planResult as EmitPlanResult).baseline : undefined,
    failingAssertion: mode === "source" ? (planResult as EmitPlanSourceResult).failingAssertion : undefined,
    assertionShape: mode === "source" ? (planResult as EmitPlanSourceResult).assertionShape : undefined,
    fix: patchResult.rationale,
    confirmResult: patchResult.confirmResult ?? "(not run)",
    evalVerdict: evalResult?.overallVerdict ?? (skipEval ? "(skipped)" : "(not run)"),
    evalMissedBlocker: evalResult?.missedRequirements.filter((m) => m.severity === "blocker").length ?? 0,
    evalMissedSoft: evalResult?.missedRequirements.filter((m) => m.severity === "soft").length ?? 0,
    mrUrl: mrUrl ?? "(not created)"
  }, null, 2));

  // Exit non-zero on fail OR partial-blocker so CI / scripts can distinguish
  // "ready for review" runs from "needs work" runs. partial-soft exits 0 —
  // the patch matches the codebase pattern and is reviewer-ready.
  if (evalResult?.overallVerdict === "fail") {
    console.error("\nEvaluator verdict: FAIL. The patch does not address the spec.");
    process.exit(2);
  }
  if (evalResult?.overallVerdict === "partial-blocker") {
    console.error("\nEvaluator verdict: PARTIAL (BLOCKER). At least one load-bearing acceptance criterion is unmet.");
    process.exit(3);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`llm-run failed: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
