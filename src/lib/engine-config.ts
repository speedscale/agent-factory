/**
 * Engine config resolver — single source of truth for which LLM the agents
 * call, based on the `AF_ENGINE_*` env vars set by the Helm chart from the
 * `engine.*` values block.
 *
 * The chart's `engine.kind` enum is operator-friendly (claude-sdk,
 * generic-llm, private-llm, ds4, omlx, openrouter); this module maps each
 * to the internal `LLMProvider` the agent loop in `llm-providers.ts`
 * understands.
 *
 * Hardcoding `provider = "anthropic"` in `runTriage` previously meant that
 * flipping `engine.kind` to `ds4` in values.yaml changed the env vars but
 * the agents still called Anthropic. Now every agent that needs a provider
 * threads it through `resolveEngineConfig(process.env)`.
 *
 * Unknown kinds throw — silently falling back to Anthropic would mask the
 * misconfiguration and rack up cloud spend on a deployment that was
 * supposed to be air-gapped.
 *
 * Env vars consumed:
 *   AF_ENGINE_KIND     One of: claude-sdk | ds4 | omlx | openrouter |
 *                      generic-llm | private-llm. Defaults to "claude-sdk"
 *                      (matches the chart default).
 *   AF_ENGINE_MODEL    Model identifier. Defaults to the per-provider
 *                      default from `defaultModelFor()`.
 *   AF_ENGINE_ENDPOINT Optional override for the provider base URL. Today
 *                      only consumed by the OpenAI-compatible providers
 *                      via their own `*_BASE_URL` env vars; surfaced here
 *                      so callers can log / forward it.
 */

import { defaultModelFor, type LLMProvider } from "./llm-providers.js";

/** Operator-facing kind from charts/values.yaml's `engine.kind`. */
export type EngineKind =
  | "claude-sdk"
  | "ds4"
  | "omlx"
  | "openrouter"
  | "generic-llm"
  | "private-llm";

export interface EngineConfig {
  provider: LLMProvider;
  model: string;
  endpoint?: string;
}

/**
 * Resolve the engine config from environment variables. Pure function —
 * takes `env` explicitly so tests can drive it without mutating
 * `process.env`.
 *
 * Throws on an unknown `AF_ENGINE_KIND` rather than silently defaulting
 * to Anthropic — see module header.
 */
export function resolveEngineConfig(env: NodeJS.ProcessEnv): EngineConfig {
  const kindRaw = (env.AF_ENGINE_KIND ?? "claude-sdk").trim();
  const provider = mapKindToProvider(kindRaw);

  const modelRaw = env.AF_ENGINE_MODEL?.trim();
  const model = modelRaw && modelRaw.length > 0 ? modelRaw : defaultModelFor(provider);

  const endpointRaw = env.AF_ENGINE_ENDPOINT?.trim();
  const endpoint = endpointRaw && endpointRaw.length > 0 ? endpointRaw : undefined;

  return { provider, model, endpoint };
}

/**
 * Map the operator-facing engine kind to the internal LLMProvider. Exported
 * separately so callers that only care about provider selection (without
 * model/endpoint resolution) can use it directly.
 *
 * `generic-llm` and `private-llm` are operator-vocabulary aliases for "an
 * OpenAI-compatible HTTP endpoint" — both map to `openrouter`, which is
 * the OpenAI-shaped client in `llm-providers.ts`. The actual base URL
 * comes from the provider's own `*_BASE_URL` env var or the chart's
 * `engine.endpoint`.
 */
export function mapKindToProvider(kind: string): LLMProvider {
  switch (kind) {
    case "claude-sdk":
      return "anthropic";
    case "ds4":
      return "ds4";
    case "omlx":
      return "omlx";
    case "openrouter":
    case "generic-llm":
    case "private-llm":
      return "openrouter";
    default:
      throw new Error(
        `unknown AF_ENGINE_KIND: ${JSON.stringify(kind)}. ` +
          `Expected one of: claude-sdk, ds4, omlx, openrouter, generic-llm, private-llm.`,
      );
  }
}

/**
 * Provider kinds that require an auth secret to be mounted. Used by the
 * chart helper / docs to gate the `engine.authSecret` block. Local
 * providers (ds4, omlx) speak to a process on localhost and don't need
 * auth; cloud providers do.
 */
export const PROVIDERS_REQUIRING_AUTH: ReadonlySet<LLMProvider> = new Set<LLMProvider>([
  "anthropic",
  "openrouter",
]);

export function providerRequiresAuth(provider: LLMProvider): boolean {
  return PROVIDERS_REQUIRING_AUTH.has(provider);
}
