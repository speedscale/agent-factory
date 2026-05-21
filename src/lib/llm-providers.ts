/**
 * Provider-agnostic LLM tool-use boundary.
 *
 * The agent loop in llm-engine.ts is identical across providers; only the
 * shape of the request/response differs. This module defines portable
 * types (ToolDef, AssistantTurn, ConvMessage) and ships one `callLLM`
 * implementation per supported provider that translates to/from the
 * provider's native shape.
 *
 * Add a new provider by implementing one function that returns AssistantTurn.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type LLMProvider = "anthropic" | "openrouter" | "ds4" | "omlx";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      /** For type: "array" — schema of each item. */
      items?: { type: string };
      /** For type: "string" — restrict to one of these values. */
      enum?: string[];
    }>;
    required?: string[];
  };
  /** Tools that must have been called at least once in this run before this
   * tool can dispatch. Engine returns a soft error (no error-budget hit) if
   * any are unmet. Used to catch blind-edit patterns like write_file before
   * read_file. Optional — most tools have no prerequisites. */
  requires?: string[];
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, string>;
}

export interface TextBlock {
  text: string;
}

export interface AssistantTurn {
  textBlocks: TextBlock[];
  toolUses: ToolUse[];
  /** Normalized: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | other provider string */
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** DeepSeek-style chain-of-thought returned as a separate field on the
   * assistant message. We preserve it across turns so reasoning models can
   * continue their thought instead of re-deriving context every loop. */
  reasoningContent?: string;
}

export type ConvMessage =
  | { role: "user"; content: string }
  | { role: "user"; toolResults: { toolUseId: string; content: string }[] }
  | { role: "assistant"; turn: AssistantTurn };

export interface CallLLMParams {
  provider: LLMProvider;
  model: string;
  system: string;
  tools: ToolDef[];
  messages: ConvMessage[];
  maxTokens: number;
  /** When set, force the next response to call exactly this tool. Used by the
   * agent loop to terminate weaker models that ignore the forced-emit nudge. */
  forceToolName?: string;
}

export async function callLLM(params: CallLLMParams): Promise<AssistantTurn> {
  switch (params.provider) {
    case "anthropic":
      return callAnthropic(params);
    case "openrouter":
      return callOpenAICompatible(openrouterClient, params);
    case "ds4":
      return callOpenAICompatible(ds4Client, params);
    case "omlx":
      return callOpenAICompatible(omlxClient, params);
    default: {
      const _exhaustive: never = params.provider;
      throw new Error(`unknown provider: ${_exhaustive as string}`);
    }
  }
}

// ---------- Anthropic ----------

const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_DO_NOT_USE;
const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });

async function callAnthropic(params: CallLLMParams): Promise<AssistantTurn> {
  const tools: Anthropic.Tool[] = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.inputSchema.properties,
      required: t.inputSchema.required
    }
  }));

  const messages: Anthropic.MessageParam[] = params.messages.map((m) => {
    if (m.role === "user" && "content" in m) {
      return { role: "user", content: m.content };
    }
    if (m.role === "user" && "toolResults" in m) {
      return {
        role: "user",
        content: m.toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          content: r.content
        }))
      };
    }
    // assistant turn — reconstruct from textBlocks + toolUses
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const tb of m.turn.textBlocks) {
      blocks.push({ type: "text", text: tb.text });
    }
    for (const tu of m.turn.toolUses) {
      blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    return { role: "assistant", content: blocks };
  });

  const response = await anthropicClient.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    tools,
    messages,
    ...(params.forceToolName
      ? { tool_choice: { type: "tool" as const, name: params.forceToolName } }
      : {})
  });

  const textBlocks: TextBlock[] = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => ({ text: b.text }));

  const toolUses: ToolUse[] = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, string> }));

  return {
    textBlocks,
    toolUses,
    stopReason: response.stop_reason ?? "unknown",
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens
    }
  };
}

// ---------- OpenAI-compatible providers (OpenRouter, local DS4, etc.) ----------

const openrouterClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || "openrouter-unset",
  baseURL: "https://openrouter.ai/api/v1"
});

// DS4 is the local DeepSeek-V4-Flash server (antirez/ds4). No auth needed.
const ds4Client = new OpenAI({
  apiKey: process.env.DS4_API_KEY || "ds4-local",
  baseURL: process.env.DS4_BASE_URL || "http://127.0.0.1:38011/v1"
});

// omlx is the local MLX-based multi-model server (Qwen, Gemma, Nemotron). No auth needed.
const omlxClient = new OpenAI({
  apiKey: process.env.OMLX_API_KEY || "omlx-local",
  baseURL: process.env.OMLX_BASE_URL || "http://127.0.0.1:38010/v1"
});

async function callOpenAICompatible(client: OpenAI, params: CallLLMParams): Promise<AssistantTurn> {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = params.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.inputSchema.properties,
        required: t.inputSchema.required ?? []
      }
    }
  }));

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: params.system }
  ];

  for (const m of params.messages) {
    if (m.role === "user" && "content" in m) {
      messages.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "user" && "toolResults" in m) {
      // OpenAI: one message per tool result, role "tool", referencing tool_call_id
      for (const r of m.toolResults) {
        messages.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
      }
      continue;
    }
    // assistant turn — combine textBlocks + toolUses into one assistant message
    const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: m.turn.textBlocks.map((tb) => tb.text).join("\n") || null
    };
    if (m.turn.toolUses.length > 0) {
      assistant.tool_calls = m.turn.toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: JSON.stringify(tu.input) }
      }));
    }
    // Preserve DeepSeek-style reasoning_content across turns. ds4-server and
    // omlx accept it on input; cloud providers that don't will silently drop it.
    if (m.turn.reasoningContent) {
      (assistant as unknown as Record<string, unknown>).reasoning_content = m.turn.reasoningContent;
    }
    messages.push(assistant);
  }

  // Low temperature collapses meandering tool selection on weaker models
  // (DS4 went from wandering /usr/bin/find as a "script" to picking the
  // correct first tool with temperature=0.1). reasoning_effort=high engages
  // DeepSeek's deep thinking mode; models that don't support it ignore it.
  // Both env-vars override these defaults if a run needs different behavior.
  const temperature = parseFloat(process.env.LLM_TEMPERATURE ?? "0.1");
  const reasoningEffort = process.env.LLM_REASONING_EFFORT ?? "high";
  const response = await client.chat.completions.create({
    model: params.model,
    max_tokens: params.maxTokens,
    temperature,
    tools,
    messages,
    ...(params.forceToolName
      ? { tool_choice: { type: "function" as const, function: { name: params.forceToolName } } }
      : {}),
    // reasoning_effort isn't in the official OpenAI SDK types yet; cast through.
    ...({ reasoning_effort: reasoningEffort } as object)
  });

  const choice = response.choices[0];
  const msg = choice.message;

  const textBlocks: TextBlock[] = msg.content ? [{ text: msg.content }] : [];
  // reasoning_content isn't in the OpenAI SDK types but DeepSeek/Qwen return it.
  const reasoningContent = (msg as unknown as { reasoning_content?: string }).reasoning_content;

  const toolUses: ToolUse[] = (msg.tool_calls ?? []).map((tc) => {
    if (tc.type !== "function") {
      throw new Error(`unsupported tool_call type: ${tc.type}`);
    }
    let input: Record<string, string>;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch (e) {
      throw new Error(`tool_call ${tc.function.name} returned invalid JSON arguments: ${tc.function.arguments}`);
    }
    return { id: tc.id, name: tc.function.name, input };
  });

  const stopReason = normalizeOpenAIFinishReason(choice.finish_reason);

  return {
    textBlocks,
    toolUses,
    stopReason,
    reasoningContent,
    usage: {
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens
    }
  };
}

function normalizeOpenAIFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    case "content_filter": return "content_filter";
    default: return reason ?? "unknown";
  }
}

export function defaultModelFor(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-6";
    case "openrouter": return "openai/gpt-5.4";
    case "ds4": return "deepseek-v4-flash";
    case "omlx": return "Qwen3.6-27B-4bit";
  }
}
