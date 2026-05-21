import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ProxymockClient,
  __testing,
  type McpClientLike,
} from "./mcp/proxymock-client.js";
import type { ToolDescriptor } from "./mcp/types.js";

function fakeClient(
  overrides: Partial<McpClientLike> = {},
): { client: McpClientLike; calls: Array<{ name: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const client: McpClientLike = {
    async connect() {},
    async close() {},
    async listTools() {
      return { tools: [{ name: "search_traffic", inputSchema: {} } satisfies ToolDescriptor] };
    },
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
    ...overrides,
  };
  return { client, calls };
}

describe("ProxymockClient", () => {
  it("throws when called before connect()", async () => {
    const c = new ProxymockClient();
    await assert.rejects(c.listTools(), /not connected/);
  });

  it("connect() is idempotent", async () => {
    const { client } = fakeClient();
    let connectCalls = 0;
    const wrapped: McpClientLike = {
      ...client,
      async connect() {
        connectCalls++;
      },
    };
    const c = new ProxymockClient({
      clientFactory: () => wrapped,
      transportFactory: () => ({}),
    });
    await c.connect();
    await c.connect();
    assert.equal(connectCalls, 1);
  });

  it("listTools() caches descriptors for cachedTool()", async () => {
    const { client } = fakeClient();
    const c = new ProxymockClient({
      clientFactory: () => client,
      transportFactory: () => ({}),
    });
    await c.connect();
    assert.equal(c.cachedTool("search_traffic"), undefined);
    await c.listTools();
    const cached = c.cachedTool("search_traffic");
    assert.ok(cached, "expected search_traffic to be cached");
    assert.equal(cached?.name, "search_traffic");
  });

  it("searchTraffic() sends kebab-case args", async () => {
    const { client, calls } = fakeClient();
    const c = new ProxymockClient({
      clientFactory: () => client,
      transportFactory: () => ({}),
    });
    await c.connect();
    await c.searchTraffic({
      service: "radar",
      startTime: "2026-05-21T00:00:00Z",
      endTime: "2026-05-21T01:00:00Z",
      filterQuery: '(status IS "429")',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "search_traffic");
    assert.deepEqual(calls[0].args, {
      service: "radar",
      "start-time": "2026-05-21T00:00:00Z",
      "end-time": "2026-05-21T01:00:00Z",
      "filter-query": '(status IS "429")',
    });
  });

  it("pullRemoteRecording() requires service + out-directory and serializes optional fields", async () => {
    const { client, calls } = fakeClient();
    const c = new ProxymockClient({
      clientFactory: () => client,
      transportFactory: () => ({}),
    });
    await c.connect();
    await c.pullRemoteRecording({
      service: "radar",
      outDirectory: ["proxymock/pulled-2026-05-21"],
      snapshotName: "radar-prod-debug",
    });
    assert.deepEqual(calls[0].args, {
      service: "radar",
      "out-directory": ["proxymock/pulled-2026-05-21"],
      "snapshot-name": "radar-prod-debug",
    });
  });

  it("encoder helpers omit undefined optional fields", () => {
    const enc = __testing.encodeSearchTrafficArgs({
      startTime: "2026-05-21T00:00:00Z",
      endTime: "2026-05-21T01:00:00Z",
    });
    assert.deepEqual(enc, {
      "start-time": "2026-05-21T00:00:00Z",
      "end-time": "2026-05-21T01:00:00Z",
    });
  });

  it("disconnect() clears cache and closes underlying client", async () => {
    let closed = 0;
    const { client } = fakeClient({ async close() { closed++; } });
    const c = new ProxymockClient({
      clientFactory: () => client,
      transportFactory: () => ({}),
    });
    await c.connect();
    await c.listTools();
    await c.disconnect();
    assert.equal(closed, 1);
    assert.equal(c.cachedTool("search_traffic"), undefined);
  });
});
