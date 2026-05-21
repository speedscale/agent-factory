import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  PullRemoteRecordingQuery,
  RawToolResult,
  SearchTrafficQuery,
  ToolDescriptor,
} from "./types.js";

/**
 * Minimal MCP-client interface the wrapper depends on. Lets tests inject
 * a fake without spawning a real proxymock subprocess.
 */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: ToolDescriptor[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

export interface ProxymockClientOptions {
  /** Defaults to "proxymock". */
  command?: string;
  /** Defaults to ["mcp", "run"]. */
  args?: string[];
  /** Extra env vars merged over process.env. */
  env?: Record<string, string>;
  /** Override for tests. */
  clientFactory?: () => McpClientLike;
  /** Override for tests. */
  transportFactory?: (cmd: string, args: string[], env: Record<string, string>) => unknown;
  /** Client identity sent during MCP initialize. */
  clientInfo?: { name: string; version: string };
}

export class ProxymockClient {
  private mcp: McpClientLike | null = null;
  private toolCache: Map<string, ToolDescriptor> = new Map();

  constructor(private readonly opts: ProxymockClientOptions = {}) {}

  async connect(): Promise<void> {
    if (this.mcp) return;
    const command = this.opts.command ?? "proxymock";
    const args = this.opts.args ?? ["mcp", "run"];
    const env = { ...process.env, ...this.opts.env } as Record<string, string>;

    const transport =
      this.opts.transportFactory?.(command, args, env) ??
      new StdioClientTransport({ command, args, env });

    const client =
      this.opts.clientFactory?.() ??
      (new Client(
        this.opts.clientInfo ?? { name: "agent-factory", version: "0.0.0" },
        { capabilities: {} },
      ) as unknown as McpClientLike);

    await client.connect(transport);
    this.mcp = client;
  }

  async disconnect(): Promise<void> {
    const client = this.mcp;
    this.mcp = null;
    this.toolCache.clear();
    if (client) await client.close();
  }

  /** Lists tools and caches their schemas. */
  async listTools(): Promise<ToolDescriptor[]> {
    const { tools } = await this.requireClient().listTools();
    this.toolCache = new Map(tools.map((t) => [t.name, t]));
    return tools;
  }

  /** Returns the cached descriptor for a tool, or undefined if not yet listed. */
  cachedTool(name: string): ToolDescriptor | undefined {
    return this.toolCache.get(name);
  }

  /** Low-level escape hatch: call any tool with raw arguments. */
  async callToolRaw(name: string, args: Record<string, unknown>): Promise<RawToolResult> {
    const result = await this.requireClient().callTool({ name, arguments: args });
    return result as RawToolResult;
  }

  /** Typed `search_traffic` call. */
  async searchTraffic(query: SearchTrafficQuery): Promise<RawToolResult> {
    return this.callToolRaw("search_traffic", encodeSearchTrafficArgs(query));
  }

  /** Typed `pull_remote_recording` call. */
  async pullRemoteRecording(query: PullRemoteRecordingQuery): Promise<RawToolResult> {
    return this.callToolRaw("pull_remote_recording", encodePullRemoteRecordingArgs(query));
  }

  private requireClient(): McpClientLike {
    if (!this.mcp) {
      throw new Error("ProxymockClient is not connected; call connect() first");
    }
    return this.mcp;
  }
}

function encodeSearchTrafficArgs(q: SearchTrafficQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "start-time": q.startTime,
    "end-time": q.endTime,
  };
  if (q.service !== undefined) out.service = q.service;
  if (q.filterQuery !== undefined) out["filter-query"] = q.filterQuery;
  return out;
}

function encodePullRemoteRecordingArgs(q: PullRemoteRecordingQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {
    service: q.service,
    "out-directory": q.outDirectory,
  };
  if (q.snapshotName !== undefined) out["snapshot-name"] = q.snapshotName;
  if (q.startTime !== undefined) out["start-time"] = q.startTime;
  if (q.endTime !== undefined) out["end-time"] = q.endTime;
  if (q.filterQuery !== undefined) out["filter-query"] = q.filterQuery;
  return out;
}

// Exported for tests.
export const __testing = {
  encodeSearchTrafficArgs,
  encodePullRemoteRecordingArgs,
};
