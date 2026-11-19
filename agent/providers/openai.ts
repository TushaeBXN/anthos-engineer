/**
 * Talks to anything that speaks the OpenAI chat API: OpenAI itself, and local
 * or hosted open models through Ollama, LM Studio, Groq, Together and others.
 * Replies are streamed, so text can be shown as it is written.
 */
import OpenAI from "openai";
import type { Reply, Session, ToolCall, ToolResult, ToolSpec } from "../types.js";

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

  return {
    async send(input: string | ToolResult[], onText?: (delta: string) => void): Promise<Reply> {
      if (typeof input === "string") {
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

      const reply = await collect(stream, onText);
      messages.push({
        role: "assistant",
        content: reply.text || null,
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
): Promise<Reply> {
  let text = "";
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
    if (delta?.content) {
      text += delta.content;
      onText?.(delta.content);
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
