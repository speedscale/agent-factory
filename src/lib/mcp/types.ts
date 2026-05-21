/**
 * Typed shapes for the proxymock MCP tools agent-factory consumes.
 *
 * Wire-level proxymock argument names use kebab-case (e.g. "end-time").
 * These TypeScript interfaces use camelCase; the client serializes back
 * to kebab-case before calling the tool.
 */

export interface SearchTrafficQuery {
  /** Filter traffic by service name. */
  service?: string;
  /** RFC3339 start time (e.g. 2026-05-21T00:00:00Z). */
  startTime: string;
  /** RFC3339 end time. */
  endTime: string;
  /**
   * Optional proxymock filter query (DSL). Examples:
   * - `(method IS "GET")`
   * - `(status IS "200")`
   * - `(url CONTAINS "/api/users")`
   * - `(cluster IS "prod") AND (status IS "429")`
   */
  filterQuery?: string;
}

export interface PullRemoteRecordingQuery {
  /** Service to capture traffic from. Required. */
  service: string;
  /** Directories to write the pulled traffic into. Required. */
  outDirectory: string[];
  /** Optional custom snapshot name. Defaults to `{service}-{timestamp}`. */
  snapshotName?: string;
  /** RFC3339 start time. Defaults to 5 minutes ago. */
  startTime?: string;
  /** RFC3339 end time. Defaults to now. */
  endTime?: string;
  /** Optional proxymock filter query (same DSL as `searchTraffic`). */
  filterQuery?: string;
}

/**
 * Generic MCP `CallToolResult.content` item, narrowed to the text shape.
 * Most proxymock tools return text payloads (JSON-encoded blocks).
 */
export interface ToolTextContent {
  type: "text";
  text: string;
}

/** A raw MCP tool result, before any tool-specific parsing. */
export interface RawToolResult {
  content: ToolTextContent[];
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * Minimal ToolListEntry mirror — fields the wrapper needs to surface
 * without re-importing MCP SDK types in callers.
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
