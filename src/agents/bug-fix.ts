import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveEngineConfig, mapKindToProvider } from "../lib/engine-config.js";
import { runPlanner, runWorker } from "../lib/llm-engine.js";
import type { AgentDef, AgentInputSchema, AgentRunContext, AgentRunOutput } from "./types.js";

const execAsync = promisify(exec);

// ── Input schema ──────────────────────────────────────────────────────────────
// In the k8s controller path all meaningful inputs come from ctx (issue from
// ctx.run.spec.issue, traffic from ctx.trafficSources).  The explicit input
// block is accepted for forward-compatibility but nothing here is required.
export interface BugFixInput {
  /** Optional: override branch name for the fix PR. */
  branchName?: string;
}

const inputSchema: AgentInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    branchName: { type: "string" },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Shallow-clone a repo at <branch> into <destDir>. */
async function cloneRepo(url: string, branch: string, destDir: string): Promise<void> {
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  const { stderr } = await execAsync(
    `git clone --depth 1 --branch '${branch.replace(/'/g, "'\\''")}' '${url.replace(/'/g, "'\\''")}' '${destDir.replace(/'/g, "'\\''")}'`
  );
  if (stderr && !stderr.includes("Cloning into")) {
    // git clone writes progress to stderr; only throw on real errors
    throw new Error(`git clone stderr: ${stderr.slice(0, 500)}`);
  }
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export const bugFixAgent: AgentDef<BugFixInput> = {
  id: "bug-fix",
  description:
    "Clone the app repo, reproduce the bug against the materialized traffic snapshot, " +
    "generate a candidate patch with the LLM Planner+Worker engine, and write the " +
    "patch diff + run report as artifacts. Opens a PR when autoCreatePR is enabled.",
  inputSchema,

  async run(input: BugFixInput, ctx: AgentRunContext): Promise<AgentRunOutput> {
    const { app, run, trafficSources, runDir, logger } = ctx;
    const issue = run.spec.issue;

    if (!issue?.title) {
      throw new Error("AgentRun.spec.issue.title is required for bug-fix");
    }

    // ── 1. Snapshot directory ───────────────────────────────────────────────
    // After materialisation all sources are kind=local-fs with store.path set.
    // Take the first one if available; source-mode runs with no traffic still work.
    const snapshotDir = trafficSources[0]?.spec?.store?.path;
    logger.info("bug-fix: snapshot", { snapshotDir: snapshotDir ?? "(none — source mode)" });

    // ── 2. Clone repo ───────────────────────────────────────────────────────
    const repoDir = path.join(runDir, "repo");
    const repoUrl = app.spec.repo.url;
    const defaultBranch = app.spec.repo.defaultBranch || "main";
    logger.info("bug-fix: cloning repo", { url: repoUrl, branch: defaultBranch, dest: repoDir });
    await cloneRepo(repoUrl, defaultBranch, repoDir);

    const workdirRelative = app.spec.repo.workdir || ".";
    const sourceDir = path.join(repoDir, workdirRelative);

    // ── 3. Engine config ────────────────────────────────────────────────────
    // Chart env vars (AF_ENGINE_KIND / AF_ENGINE_MODEL) are the baseline; the
    // per-run spec.engine block can override both.
    const baseCfg = resolveEngineConfig(process.env);
    const runEngineKind = (run.spec as { engine?: { kind?: string; model?: string } }).engine?.kind;
    const runEngineModel = (run.spec as { engine?: { kind?: string; model?: string } }).engine?.model;
    const provider = runEngineKind ? mapKindToProvider(runEngineKind) : baseCfg.provider;
    const model = runEngineModel ?? baseCfg.model;
    logger.info("bug-fix: engine", { provider, model });

    // ── 4. Branch name ──────────────────────────────────────────────────────
    const branchName =
      input.branchName ??
      `agent/${slugify(issue.title)}`;

    // ── 5. Planner ──────────────────────────────────────────────────────────
    logger.info("bug-fix: running Planner", { title: issue.title });
    const planResult = await runPlanner(
      { title: issue.title, body: issue.body ?? "" },
      { snapshotDir, sourceDir, workDir: runDir, repoDir, branchName, provider, model }
    );
    logger.info("bug-fix: Planner done", {
      metric: planResult.metric,
      baseline: planResult.baseline,
      hypothesis: planResult.plan.spec.hypothesis?.slice(0, 120),
    });

    // ── 6. Worker ───────────────────────────────────────────────────────────
    logger.info("bug-fix: running Worker");
    const patchResult = await runWorker(planResult, {
      snapshotDir,
      sourceDir,
      workDir: runDir,
      repoDir,
      branchName,
      provider,
      model,
    });
    logger.info("bug-fix: Worker done", {
      filePath: patchResult.filePath,
      patchLines: patchResult.patch?.split("\n").length ?? 0,
      branch: patchResult.branchName,
    });

    // ── 7. Write artifacts ──────────────────────────────────────────────────
    const runReport = {
      issue: { id: issue.id, title: issue.title, url: issue.url },
      plan: {
        summary: planResult.plan.spec.summary,
        hypothesis: planResult.plan.spec.hypothesis,
        metric: planResult.metric,
        baseline: planResult.baseline,
      },
      patch: {
        filePath: patchResult.filePath,
        rationale: patchResult.rationale,
        branch: patchResult.branchName,
        worktreePath: patchResult.worktreePath,
        linesChanged: patchResult.patch?.split("\n").length ?? 0,
      },
      generatedAt: new Date().toISOString(),
    };

    const runJsonPath = path.join(runDir, "run.json");
    await fs.writeFile(runJsonPath, JSON.stringify(runReport, null, 2));

    if (patchResult.patch) {
      const patchPath = path.join(runDir, "patch.diff");
      await fs.writeFile(patchPath, patchResult.patch);
    }

    // ── 8. Return ───────────────────────────────────────────────────────────
    const summary = patchResult.patch
      ? `patched ${patchResult.filePath} on branch ${patchResult.branchName ?? branchName} (${runReport.patch.linesChanged} diff lines)`
      : `Planner produced plan but Worker found no patch needed`;

    return {
      summary,
      artifacts: {
        "run.json": "run.json",
        ...(patchResult.patch ? { "patch.diff": "patch.diff" } : {}),
      },
    };
  },
};
