/** Talks to Claude through the Anthropic SDK. Replies are streamed, so text can be shown as it is written. */
import Anthropic from "@anthropic-ai/sdk";
import type { Reply, Session, ToolResult, ToolSpec } from "../types.js";

type Message = Anthropic.Beta.BetaMessageParam;

/**
 * Models that can hand a declined request to another model inside the same
 * call. Without this a declined request simply stops.
 */
const HAS_FALLBACK = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

export function anthropicSession(model: string, system: string, tools: ToolSpec[]): Session {
  // Finds credentials on its own: ANTHROPIC_API_KEY, or an `ant auth login` profile.
  const client = new Anthropic();
  const messages: Message[] = [];
  const apiTools: Anthropic.Beta.BetaTool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    // Stream tool inputs as they are written: a file body otherwise arrives in one burst after a long silence.
    // The API then no longer validates them, so the loop checks every input against the tool's schema.
    eager_input_streaming: true,
  }));

  return {
    async send(input: string | ToolResult[], onText?: (delta: string) => void): Promise<Reply> {
      messages.push({ role: "user", content: typeof input === "string" ? input : input.map(toResultBlock) });

      let response: Anthropic.Beta.BetaMessage;
      for (let attempt = 0; ; attempt++) {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 16000,
          system,
          tools: apiTools,
          messages,
          // Reuse the unchanged start of the conversation instead of paying for it again.
          cache_control: { type: "ephemeral" },
          ...(HAS_FALLBACK.has(model)
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        });
        if (onText) stream.on("text", (delta) => onText(delta));
        try {
          response = await stream.finalMessage();
          break;
        } catch (err) {
          // A tool input that streamed as unparseable JSON fails here; ask again, twice at most.
          // API errors (auth, rate limits, bad requests) are not retried.
          if (err instanceof Anthropic.APIError || attempt >= 2) throw err;
        }
      }

      // Keep the reply exactly as it came, thinking blocks included: the API
      // needs them back unchanged on the next request.
      messages.push({ role: "assistant", content: response.content });

      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      const toolCalls = response.content.flatMap((block) =>
        block.type === "tool_use"
          ? [{ id: block.id, name: block.name, input: block.input as Record<string, unknown> }]
          : [],
      );

      return {
        text,
        toolCalls,
        usage: {
          inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
          cachedTokens: response.usage.cache_read_input_tokens ?? 0,
          outputTokens: response.usage.output_tokens,
        },
        stopped:
          response.stop_reason === "refusal" ? "refused"
          : response.stop_reason === "max_tokens" ? "cut_off"
          : toolCalls.length > 0 ? "tools"
          : "done",
      };
    },
  };
}

function toResultBlock(result: ToolResult): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: result.id, content: result.output, is_error: result.isError };
}
