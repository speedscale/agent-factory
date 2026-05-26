import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveEngineConfig, mapKindToProvider } from "../lib/engine-config.js";
import { runPlanner, runWorker } from "../lib/llm-engine.js";
import type { EmitPlanResult, EmitPatchResult } from "../lib/llm-engine.js";
import { createGitHubAuthProviderFromEnv } from "../lib/github-auth.js";
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
    throw new Error(`git clone stderr: ${stderr.slice(0, 500)}`);
  }
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

/** Extract "owner/repo" from a GitHub URL (https or ssh). */
function parseRepoFullName(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!m) throw new Error(`Cannot parse GitHub owner/repo from URL: ${url}`);
  return m[1];
}

// ── PR body ───────────────────────────────────────────────────────────────────

/**
 * Build the human-in-the-loop PR description.
 *
 * Structure mirrors what a thoughtful engineer would write:
 *   Problem   — the diagnosed root cause (agent's hypothesis)
 *   Evidence  — the observable signal (metric, baseline)
 *   Reproduce — how the agent confirmed the failure
 *   Solution  — rationale + the minimal diff
 *   Proof     — harness pass or post-merge verification instruction
 */
function buildPrBody(opts: {
  issueTitle: string;
  issueUrl?: string;
  runId: string;
  planResult: EmitPlanResult;
  patchResult: EmitPatchResult;
  effectiveBranch: string;
}): string {
  const { issueTitle, issueUrl, runId, planResult, patchResult, effectiveBranch } = opts;
  const parts: string[] = [];

  // ── Problem ──────────────────────────────────────────────────────────────
  parts.push(`# Problem\n\n${planResult.plan.spec.hypothesis}`);

  // ── Evidence ─────────────────────────────────────────────────────────────
  const evidenceLines = [
    `**Signal**: ${planResult.metric}`,
    `**Baseline**: ${planResult.baseline}`,
  ];
  if (issueUrl) evidenceLines.push(`**Issue**: ${issueUrl}`);
  parts.push(`## Evidence\n\n${evidenceLines.join("  \n")}`);

  // ── Reproduce ─────────────────────────────────────────────────────────────
  // In traffic mode the Planner confirmed the signal by reading real RRPairs;
  // in source mode it wrote and ran a baseline harness.
  const reproduceText = patchResult.harnessPath
    ? `Baseline harness at \`${patchResult.harnessPath}\` failed (non-zero exit) on the unpatched worktree, confirming the bug is present.`
    : `Traffic-mode run — the Planner confirmed the signal by reading materialized ` +
      `RRPairs from the live snapshot (baseline: ${planResult.baseline}).`;
  parts.push(`## Reproduce\n\n${reproduceText}`);

  // ── Solution ─────────────────────────────────────────────────────────────
  const diffBlock = patchResult.patch
    ? `\`\`\`diff\n${patchResult.patch}\n\`\`\``
    : `*(No source changes — the issue may be in config or already resolved.)*`;
  parts.push(`# Solution\n\n${patchResult.rationale}\n\n${diffBlock}`);

  // ── Proof ────────────────────────────────────────────────────────────────
  const proofText = patchResult.confirmResult
    ? `Confirm harness passed on patched worktree:\n\`\`\`\n${patchResult.confirmResult.slice(0, 2000)}\n\`\`\``
    : `Traffic-mode run — no harness was executed post-patch. ` +
      `After merge, re-run the smoke test to verify the error rate drops to 0% in production.`;
  parts.push(`## Proof\n\n${proofText}`);

  // ── Footer ───────────────────────────────────────────────────────────────
  parts.push(
    `---\n*Generated by [Speedscale Agent Factory](https://github.com/speedscale/agent-factory)*  \n` +
    `*Run ID: \`${runId}\` | Branch: \`${effectiveBranch}\`*`
  );

  return parts.join("\n\n");
}

// ── GitHub PR creation ────────────────────────────────────────────────────────

interface PrCreateResult {
  url: string;
  number: number;
}

async function createGitHubPr(opts: {
  repoFullName: string;
  head: string;
  base: string;
  title: string;
  body: string;
  token: string;
  githubApiBase?: string;
}): Promise<PrCreateResult> {
  const base = opts.githubApiBase ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const response = await fetch(`${base}/repos/${opts.repoFullName}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "agent-factory-bug-fix",
    },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub PR creation failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export const bugFixAgent: AgentDef<BugFixInput> = {
  id: "bug-fix",
  description:
    "Clone the app repo, reproduce the bug against the materialized traffic snapshot, " +
    "generate a candidate patch with the LLM Planner+Worker engine, and write the " +
    "patch diff + human-in-the-loop PR body as artifacts. Opens a PR when autoCreatePR is enabled.",
  inputSchema,

  async run(input: BugFixInput, ctx: AgentRunContext): Promise<AgentRunOutput> {
    const { app, run, trafficSources, runDir, logger } = ctx;
    const issue = run.spec.issue;

    if (!issue?.title) {
      throw new Error("AgentRun.spec.issue.title is required for bug-fix");
    }

    const autoCreatePR = app.spec.agents?.["bug-fix"]?.autoCreatePR ?? false;

    // ── 1. Snapshot directory ───────────────────────────────────────────────
    const snapshotDir = trafficSources[0]?.spec?.store?.path;
    logger.info("bug-fix: snapshot", { snapshotDir: snapshotDir ?? "(none — source mode)" });

    // ── 2. Clone repo ───────────────────────────────────────────────────────
    // Clone into runDir/src (not runDir/repo) so setupWorktree() can place
    // the patch worktree at runDir/repo without a path collision.
    const repoDir = path.join(runDir, "src");
    const repoUrl = app.spec.repo.url;
    const defaultBranch = app.spec.repo.defaultBranch || "main";
    logger.info("bug-fix: cloning repo", { url: repoUrl, branch: defaultBranch, dest: repoDir });
    await cloneRepo(repoUrl, defaultBranch, repoDir);

    const workdirRelative = app.spec.repo.workdir || ".";
    const sourceDir = path.join(repoDir, workdirRelative);

    // ── 3. Engine config ────────────────────────────────────────────────────
    const baseCfg = resolveEngineConfig(process.env);
    const runEngineKind = (run.spec as { engine?: { kind?: string; model?: string } }).engine?.kind;
    const runEngineModel = (run.spec as { engine?: { kind?: string; model?: string } }).engine?.model;
    const provider = runEngineKind ? mapKindToProvider(runEngineKind) : baseCfg.provider;
    const model = runEngineModel ?? baseCfg.model;
    logger.info("bug-fix: engine", { provider, model });

    // ── 4. Branch name ──────────────────────────────────────────────────────
    const branchName = input.branchName ?? `agent/${slugify(issue.title)}`;

    // ── 5. Planner ──────────────────────────────────────────────────────────
    logger.info("bug-fix: running Planner", { title: issue.title });
    const planResult: EmitPlanResult = await runPlanner(
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
    const patchResult: EmitPatchResult = await runWorker(planResult, {
      snapshotDir,
      sourceDir,
      workDir: runDir,
      repoDir,
      branchName,
      provider,
      model,
    });
    const effectiveBranch = patchResult.branchName ?? branchName;
    logger.info("bug-fix: Worker done", {
      filePath: patchResult.filePath,
      patchLines: patchResult.patch?.split("\n").length ?? 0,
      branch: effectiveBranch,
      hasConfirm: Boolean(patchResult.confirmResult),
    });

    // ── 7. Build human-in-the-loop PR body ─────────────────────────────────
    const runId = run.metadata?.name ?? path.basename(runDir);
    const prBody = buildPrBody({
      issueTitle: issue.title,
      issueUrl: issue.url,
      runId,
      planResult,
      patchResult,
      effectiveBranch,
    });

    // ── 8. Commit worktree ──────────────────────────────────────────────────
    let prUrl: string | undefined;
    let commitSha: string | undefined;

    if (patchResult.patch && patchResult.worktreePath) {
      logger.info("bug-fix: committing worktree", { worktreePath: patchResult.worktreePath });
      const wt = patchResult.worktreePath;
      await execAsync(`git -C ${JSON.stringify(wt)} config user.email "agent-factory@speedscale.com"`);
      await execAsync(`git -C ${JSON.stringify(wt)} config user.name "Speedscale Agent Factory"`);
      await execAsync(`git -C ${JSON.stringify(wt)} add -A`);
      try {
        const { stdout } = await execAsync(
          `git -C ${JSON.stringify(wt)} commit -m ${JSON.stringify(`agent: ${issue.title.slice(0, 72)}`)}`
        );
        const shaMatch = stdout.match(/\[.+ ([0-9a-f]+)\]/);
        commitSha = shaMatch?.[1];
        logger.info("bug-fix: committed", { sha: commitSha });
      } catch (err) {
        // "nothing to commit" is fine — Worker may have found no changes needed
        const msg = String(err);
        if (!msg.includes("nothing to commit")) throw err;
        logger.warn("bug-fix: nothing to commit (Worker found no changes)");
      }

      // ── 9. Push + open PR (only when autoCreatePR: true) ─────────────────
      if (autoCreatePR && commitSha) {
        const authProvider = createGitHubAuthProviderFromEnv();
        if (!authProvider) {
          logger.warn("bug-fix: autoCreatePR=true but no GitHub auth configured (set GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY or GITHUB_BOT_TOKEN); skipping PR");
        } else {
          try {
            const repoFullName = parseRepoFullName(repoUrl);
            const token = await authProvider.getTokenForRepo(repoFullName);

            // Push using token-authenticated HTTPS remote
            const authedUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);
            logger.info("bug-fix: pushing branch", { branch: effectiveBranch, repo: repoFullName });
            await execAsync(
              `git -C ${JSON.stringify(wt)} push ${JSON.stringify(authedUrl)} ${JSON.stringify(`HEAD:refs/heads/${effectiveBranch}`)}`
            );

            logger.info("bug-fix: creating PR", { repo: repoFullName, head: effectiveBranch, base: defaultBranch });
            const pr = await createGitHubPr({
              repoFullName,
              head: effectiveBranch,
              base: defaultBranch,
              title: issue.title,
              body: prBody,
              token,
            });
            prUrl = pr.url;
            logger.info("bug-fix: PR created", { url: prUrl, number: pr.number });
          } catch (err) {
            logger.warn("bug-fix: PR creation failed", { error: String(err).slice(0, 300) });
            // Non-fatal — pr-body.md is still written so the human can open the PR manually
          }
        }
      }
    }

    // ── 10. Write artifacts ─────────────────────────────────────────────────
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
        branch: effectiveBranch,
        commitSha,
        worktreePath: patchResult.worktreePath,
        linesChanged: patchResult.patch?.split("\n").length ?? 0,
        prUrl,
      },
      generatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(runReport, null, 2));

    // Always write the PR body — even if autoCreatePR is false, this is the
    // human-in-the-loop review artifact.
    await fs.writeFile(path.join(runDir, "pr-body.md"), prBody);

    if (patchResult.patch) {
      await fs.writeFile(path.join(runDir, "patch.diff"), patchResult.patch);
    }

    // ── 11. Return ──────────────────────────────────────────────────────────
    const summary = patchResult.patch
      ? `patched ${patchResult.filePath} on branch ${effectiveBranch} (${runReport.patch.linesChanged} diff lines)` +
        (prUrl ? ` — PR: ${prUrl}` : autoCreatePR ? " — PR creation failed, see pr-body.md" : " — autoCreatePR disabled, see pr-body.md")
      : `Planner produced plan but Worker found no patch needed`;

    return {
      summary,
      artifacts: {
        "run.json": "run.json",
        "pr-body.md": "pr-body.md",
        ...(patchResult.patch ? { "patch.diff": "patch.diff" } : {}),
      },
    };
  },
};
