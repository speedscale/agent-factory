/**
 * Thin Linear API wrapper for the worker-side write path.
 *
 * The poller already speaks Linear's GraphQL (read-only) in
 * `linear-poller.ts`. This module exists separately because:
 *
 *  - The worker runs in a different pod with a different secret mount; it
 *    shouldn't import the poller's bulkier issue-fetching code.
 *  - Posting comments is the only write the agent-factory does to Linear
 *    today; keeping it scoped to one tight function reduces surface area
 *    if Linear's API changes.
 *
 * Authentication: Linear personal API keys go in the `Authorization`
 * header verbatim (no "Bearer " prefix), same as the poller's path.
 */

export interface LinearClientOptions {
  apiKey: string;
  /** Override for tests. Defaults to the real Linear endpoint. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  endpoint?: string;
}

export interface LinearClient {
  /**
   * Post a comment on the given issue. `issueId` must be Linear's internal
   * UUID (the `id` field on an issue, not the `identifier` like "XYZ-123").
   * Returns the created comment's id on success; throws on API error so
   * callers can decide whether the run as a whole still succeeded.
   */
  postComment(issueId: string, body: string): Promise<{ id: string }>;
}

const LINEAR_API_ENDPOINT = "https://api.linear.app/graphql";

const COMMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation AgentFactoryComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id }
    }
  }
`;

interface CommentCreatePayload {
  data?: {
    commentCreate?: {
      success?: boolean;
      comment?: { id?: string } | null;
    };
  };
  errors?: unknown;
}

export function createLinearClient(opts: LinearClientOptions): LinearClient {
  if (!opts.apiKey || opts.apiKey.trim().length === 0) {
    throw new Error("createLinearClient: apiKey is required");
  }
  const apiKey = opts.apiKey.trim();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? LINEAR_API_ENDPOINT;

  return {
    postComment: async (issueId, body) => {
      if (!issueId || issueId.trim().length === 0) {
        throw new Error("postComment: issueId is required");
      }
      if (!body || body.trim().length === 0) {
        throw new Error("postComment: body is required");
      }

      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify({
          query: COMMENT_CREATE_MUTATION,
          variables: { input: { issueId, body } },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Linear API ${res.status}: ${text}`);
      }

      const payload = (await res.json()) as CommentCreatePayload;
      if (payload.errors) {
        throw new Error(`Linear GraphQL errors: ${JSON.stringify(payload.errors)}`);
      }

      const created = payload.data?.commentCreate;
      if (!created?.success || !created.comment?.id) {
        throw new Error(`commentCreate did not succeed: ${JSON.stringify(payload)}`);
      }
      return { id: created.comment.id };
    },
  };
}

/**
 * Extract the Linear-internal issue UUID from an AgentRun.spec.issue payload,
 * if one is present. The poller stores it in `linearIssueId`; older /
 * non-Linear-sourced runs won't have it. Returns undefined when the run
 * didn't originate from Linear (in which case the agent should not attempt
 * to post a comment).
 */
export function linearIssueIdFrom(issueSpec: unknown): string | undefined {
  if (!issueSpec || typeof issueSpec !== "object") return undefined;
  const obj = issueSpec as Record<string, unknown>;
  const id = obj.linearIssueId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
