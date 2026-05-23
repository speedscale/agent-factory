import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinearClient, linearIssueIdFrom } from "./linear-client.js";

interface CapturedCall {
  url: string;
  body: { query: string; variables: { input: { issueId: string; body: string } } };
  headers: Record<string, string>;
}

function fakeFetch(
  status: number,
  payload: unknown,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedCall["body"];
    calls.push({ url, body, headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

test("postComment hits Linear's GraphQL endpoint with the right shape", async () => {
  const { fetchImpl, calls } = fakeFetch(200, {
    data: { commentCreate: { success: true, comment: { id: "c1" } } },
  });
  const client = createLinearClient({ apiKey: "lin_api_xxx", fetchImpl });

  const result = await client.postComment("issue-uuid-123", "hello world");
  assert.equal(result.id, "c1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].headers.Authorization, "lin_api_xxx");
  assert.deepEqual(calls[0].body.variables.input, {
    issueId: "issue-uuid-123",
    body: "hello world",
  });
});

test("postComment throws on HTTP error (caller decides whether to fail the run)", async () => {
  const { fetchImpl } = fakeFetch(403, { error: "forbidden" });
  const client = createLinearClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.postComment("i", "b"), /Linear API 403/);
});

test("postComment throws on GraphQL errors", async () => {
  const { fetchImpl } = fakeFetch(200, { errors: [{ message: "bad" }] });
  const client = createLinearClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.postComment("i", "b"), /GraphQL errors/);
});

test("postComment throws when success=false", async () => {
  const { fetchImpl } = fakeFetch(200, {
    data: { commentCreate: { success: false, comment: null } },
  });
  const client = createLinearClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.postComment("i", "b"), /did not succeed/);
});

test("postComment rejects empty issueId or body before hitting the network", async () => {
  const { fetchImpl, calls } = fakeFetch(200, { data: {} });
  const client = createLinearClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.postComment("", "b"), /issueId/);
  await assert.rejects(client.postComment("i", ""), /body/);
  assert.equal(calls.length, 0, "no network call should be made");
});

test("createLinearClient rejects empty apiKey", () => {
  assert.throws(() => createLinearClient({ apiKey: "" }), /apiKey/);
  assert.throws(() => createLinearClient({ apiKey: "   " }), /apiKey/);
});

test("linearIssueIdFrom extracts the UUID when present", () => {
  assert.equal(
    linearIssueIdFrom({ id: "XYZ-123", linearIssueId: "uuid-abc" }),
    "uuid-abc",
  );
});

test("linearIssueIdFrom returns undefined for non-Linear issues", () => {
  assert.equal(linearIssueIdFrom({ id: "pr-42" }), undefined);
  assert.equal(linearIssueIdFrom(undefined), undefined);
  assert.equal(linearIssueIdFrom(null), undefined);
  assert.equal(linearIssueIdFrom({ linearIssueId: "" }), undefined);
  assert.equal(linearIssueIdFrom({ linearIssueId: 42 }), undefined);
});
