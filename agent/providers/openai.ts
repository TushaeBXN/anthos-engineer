/**
 * Talks to anything that speaks the OpenAI chat API: OpenAI itself, and local
 * or hosted open models through Ollama, LM Studio, Groq, Together and others.
 * Replies are streamed, so text can be shown as it is written.
 */
import OpenAI from "openai";
import { CLEARED, SUMMARY_PROMPT, asText, carried, shortenForSummary, withSummary } from "../compaction.js";
import type { Compaction, Reply, Session, ToolCall, ToolResult, ToolSpec } from "../types.js";
import { ThinkFilter, looksLikeReasoningModel, stripThinking } from "./think.js";

export function openaiSession(
  model: string,
  system: string,
  tools: ToolSpec[],
  baseUrl: string | undefined,
  apiKey: string | undefined,
): Session {
  // Local servers ignore the key, but the client requires one to be set.
  const client = new OpenAI({ apiKey: apiKey ?? "not-needed", baseURL: baseUrl });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  const apiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  // Some servers reject stream_options; after the first refusal, stop sending it.
  let askForUsage = true;
  // After a compaction, the summary that starts the next message.
  let carry = "";
  // Whether replies start with the model's thinking, to be held back until </think>.
  let thinks = looksLikeReasoningModel(model);

  /** Add input to a message list: a user message, or one tool message per result. */
  const append = (list: OpenAI.Chat.ChatCompletionMessageParam[], input: string | ToolResult[]) => {
    if (typeof input === "string") list.push({ role: "user", content: input });
    else for (const r of input) list.push({ role: "tool", tool_call_id: r.id, content: r.output });
  };

  return {
    async compact(pending, latestRequest): Promise<Compaction | null> {
      if (messages.length <= 1 && pending === undefined) return null;
      const request = [...messages];
      if (pending !== undefined) append(request, typeof pending === "string" ? pending : shortenForSummary(pending));
      request.push({ role: "user", content: SUMMARY_PROMPT });
      messages.splice(1);
      try {
        const make = (choice: boolean) =>
          client.chat.completions.create({ model, messages: request, tools: apiTools, ...(choice ? { tool_choice: "none" as const } : {}) });
        let response;
        try {
          response = await make(true);
        } catch (err) {
          // Some servers don't accept tool_choice.
          if (!(err instanceof OpenAI.APIError) || err.status !== 400) throw err;
          response = await make(false);
        }
        const summary = stripThinking(response.choices[0]?.message.content ?? "", thinks).trim();
        if (!summary) throw new Error("empty summary");
        carry = carried(summary, latestRequest, pending);
        const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        return {
          summary,
          carried: carry,
          fallback: false,
          usage: { inputTokens: (response.usage?.prompt_tokens ?? 0) - cached, cachedTokens: cached, outputTokens: response.usage?.completion_tokens ?? 0 },
        };
      } catch {
        carry = carried(CLEARED, latestRequest, pending);
        return { summary: CLEARED, carried: carry, fallback: true, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } };
      }
    },

    async send(input: string | ToolResult[], onText?: (delta: string) => void): Promise<Reply> {
      if (carry) {
        // The first message after a compaction starts with the summary. Tool results here would have no
        // tool call to answer (it was summarized away), so they go in as text.
        messages.push({ role: "user", content: withSummary(carry, asText(input)) });
        carry = "";
      } else if (typeof input === "string") {
        messages.push({ role: "user", content: input });
      } else {
        for (const result of input) {
          messages.push({ role: "tool", tool_call_id: result.id, content: result.output });
        }
      }

      const request = () =>
        client.chat.completions.create({
          model,
          messages,
          tools: apiTools,
          stream: true,
          ...(askForUsage ? { stream_options: { include_usage: true } } : {}),
        });
      let stream: Awaited<ReturnType<typeof request>>;
      try {
        stream = await request();
      } catch (err) {
        if (!(err instanceof OpenAI.APIError) || err.status !== 400 || !askForUsage) throw err;
        askForUsage = false;
        stream = await request();
      }

      const filter = new ThinkFilter(thinks);
      const reply = await collect(stream, onText, filter);
      if (filter.sawClose) thinks = true;
      messages.push({
        role: "assistant",
        // null only alongside tool calls: Ollama rejects an assistant message with neither (an empty reply).
        content: reply.text || (reply.toolCalls.length > 0 ? null : ""),
        ...(reply.toolCalls.length > 0
          ? {
              tool_calls: reply.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
      return reply;
    },
  };
}

/** Put a streamed reply back together: text as it arrives, tool calls from their pieces, usage from the last chunk. */
export async function collect(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  onText?: (delta: string) => void,
  think: ThinkFilter = new ThinkFilter(false),
): Promise<Reply> {
  let finish: string | null = null;
  let usage: OpenAI.CompletionUsage | undefined;
  let sawAnything = false;
  // Tool calls arrive in pieces, keyed by index: the id and name first, then the arguments a few characters at a time.
  const calls: { id: string; name: string; args: string }[] = [];

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    sawAnything = true;
    const delta = choice.delta;
    const separate = delta as { reasoning?: string; reasoning_content?: string } | undefined;
    if (separate?.reasoning || separate?.reasoning_content) think.serverSeparates();
    if (delta?.content) {
      // The model's thinking is neither shown nor kept (see think.ts).
      const shown = think.push(delta.content);
      if (shown) onText?.(shown);
    }
    for (const piece of delta?.tool_calls ?? []) {
      const call = (calls[piece.index] ??= { id: "", name: "", args: "" });
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name += piece.function.name;
      if (piece.function?.arguments) call.args += piece.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!sawAnything) throw new Error("The model returned an empty response.");
  const rest = think.end();
  if (rest) onText?.(rest);
  const text = think.text;

  const toolCalls: ToolCall[] = calls
    .filter((c) => c && c.name)
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, input: parseArguments(c.args) }));
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: (usage?.prompt_tokens ?? 0) - cached,
      cachedTokens: cached,
      outputTokens: usage?.completion_tokens ?? 0,
    },
    stopped:
      finish === "content_filter" ? "refused"
      : finish === "length" ? "cut_off"
      : toolCalls.length > 0 ? "tools"
      : "done",
  };
}

/** Smaller models sometimes send broken JSON. An empty input fails the tool's
 *  input check, which tells the model to try again. */
function parseArguments(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
