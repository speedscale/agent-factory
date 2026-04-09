import { parsePollerIntervalMs, runIssuePollerOnce, startIssuePollerLoop } from "../lib/issue-poller.js";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await runIssuePollerOnce();
    return;
  }

  const intervalMs = parsePollerIntervalMs(process.env.POLLER_INTERVAL_MS);
  startIssuePollerLoop(intervalMs);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(message);
  process.exitCode = 1;
});
