/** Talks to Claude through the Anthropic SDK. Replies are streamed, so text can be shown as it is written. */
import Anthropic from "@anthropic-ai/sdk";
import { CLEARED, SUMMARY_PROMPT, asText, carried, shortenForSummary, withSummary } from "../compaction.js";
import type { Compaction, Reply, Session, ToolResult, ToolSpec } from "../types.js";

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

  const fallback = HAS_FALLBACK.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
  // After a compaction, the summary that starts the next message.
  let carry = "";

  return {
    async compact(pending, latestRequest): Promise<Compaction | null> {
      if (messages.length === 0 && pending === undefined) return null;
      const request: Message[] = [...messages];
      if (typeof pending === "string") request.push({ role: "user", content: `${pending}\n\n${SUMMARY_PROMPT}` });
      else if (pending) request.push({ role: "user", content: [...shortenForSummary(pending).map(toResultBlock), { type: "text", text: SUMMARY_PROMPT }] });
      else request.push({ role: "user", content: SUMMARY_PROMPT });
      messages.length = 0;
      try {
        const response = await client.beta.messages.create({
          model,
          max_tokens: 8000,
          system,
          // The history holds tool calls, so the tools stay defined; the model is told not to call one.
          tools: apiTools,
          tool_choice: { type: "none" },
          messages: request,
          ...fallback,
        });
        const summary = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        if (!summary) throw new Error("empty summary");
        carry = carried(summary, latestRequest, pending);
        return { summary, carried: carry, fallback: false, usage: usageOf(response.usage) };
      } catch {
        carry = carried(CLEARED, latestRequest, pending);
        return { summary: CLEARED, carried: carry, fallback: true, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } };
      }
    },

    async send(input: string | ToolResult[], onText?: (delta: string) => void): Promise<Reply> {
      if (carry) {
        // The first message after a compaction starts with the summary; any tool results go in as text,
        // since the tool calls they answer were summarized away.
        messages.push({ role: "user", content: withSummary(carry, asText(input)) });
        carry = "";
      } else {
        messages.push({ role: "user", content: typeof input === "string" ? input : input.map(toResultBlock) });
      }

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
          ...fallback,
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
      // An empty reply can't be sent back (the API requires content); the next user message just follows on.
      if (response.content.length > 0) messages.push({ role: "assistant", content: response.content });

      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      const toolCalls = response.content.flatMap((block) =>
        block.type === "tool_use"
          ? [{ id: block.id, name: block.name, input: block.input as Record<string, unknown> }]
          : [],
      );

      return {
        text,
        toolCalls,
        usage: usageOf(response.usage),
        stopped:
          response.stop_reason === "refusal" ? "refused"
          : response.stop_reason === "max_tokens" ? "cut_off"
          : toolCalls.length > 0 ? "tools"
          : "done",
      };
    },
  };
}

function usageOf(usage: Anthropic.Beta.BetaUsage) {
  return {
    inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
    cachedTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

function toResultBlock(result: ToolResult): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: result.id, content: result.output, is_error: result.isError };
}
