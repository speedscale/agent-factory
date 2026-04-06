import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntakeRequest } from "../lib/run-store.js";
import { createRunFromIssue } from "../lib/run-store.js";

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }

  return JSON.parse(raw) as unknown;
}

function isIntakeRequest(value: unknown): value is IntakeRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const app = candidate.app as Record<string, unknown> | undefined;
  const issue = candidate.issue as Record<string, unknown> | undefined;

  if (
    typeof app !== "object" ||
    app === null ||
    app.apiVersion !== "agents.speedscale.io/v1alpha1" ||
    app.kind !== "AgentApp"
  ) {
    return false;
  }

  const appMetadata = app.metadata as Record<string, unknown> | undefined;
  const appSpec = app.spec as Record<string, unknown> | undefined;
  const appRepo = appSpec?.repo as Record<string, unknown> | undefined;
  const appBuild = appSpec?.build as Record<string, unknown> | undefined;
  const appValidate = appSpec?.validate as Record<string, unknown> | undefined;
  const appProxymock = appValidate?.proxymock as Record<string, unknown> | undefined;

  return (
    typeof appMetadata?.name === "string" &&
    typeof appRepo?.provider === "string" &&
    typeof appRepo?.url === "string" &&
    typeof appRepo?.defaultBranch === "string" &&
    typeof appRepo?.workdir === "string" &&
    typeof appBuild?.install === "string" &&
    typeof appBuild?.test === "string" &&
    typeof appBuild?.start === "string" &&
    typeof appProxymock?.dataset === "string" &&
    typeof appProxymock?.mode === "string" &&
    typeof appProxymock?.command === "string" &&
    typeof issue === "object" &&
    issue !== null &&
    typeof issue.id === "string" &&
    typeof issue.title === "string" &&
    typeof issue.body === "string"
  );
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, { ok: true, service: "intake-api" });
    return;
  }

  if (req.method === "POST" && req.url === "/runs") {
    try {
      const body = await readJsonBody(req);

      if (!isIntakeRequest(body)) {
        sendJson(res, 400, {
          error: "request must include app.metadata.name and issue.id/title/body"
        });
        return;
      }

      const run = await createRunFromIssue(body);

      sendJson(res, 201, {
        message: "intake created a queued run",
        run
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request body";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const port = Number(process.env.PORT ?? "8080");

createServer((req, res) => {
  void handler(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unexpected server error";
    sendJson(res, 500, { error: message });
  });
}).listen(port, () => {
  console.log(`intake-api listening on http://localhost:${port}`);
});
