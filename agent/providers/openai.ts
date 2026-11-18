/**
 * Talks to anything that speaks the OpenAI chat API: OpenAI itself, and local
 * or hosted open models through Ollama, LM Studio, Groq, Together and others.
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

  return {
    async send(input: string | ToolResult[]): Promise<Reply> {
      if (typeof input === "string") {
        messages.push({ role: "user", content: input });
      } else {
        for (const result of input) {
          messages.push({ role: "tool", tool_call_id: result.id, content: result.output });
        }
      }

      const response = await client.chat.completions.create({ model, messages, tools: apiTools });
      const choice = response.choices[0];
      if (!choice) throw new Error("The model returned an empty response.");
      messages.push(choice.message);

      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((call) =>
        call.type === "function"
          ? [{ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }]
          : [],
      );
      const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      return {
        text: choice.message.content ?? "",
        toolCalls,
        usage: {
          inputTokens: (response.usage?.prompt_tokens ?? 0) - cached,
          cachedTokens: cached,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        stopped:
          choice.finish_reason === "content_filter" ? "refused"
          : choice.finish_reason === "length" ? "cut_off"
          : toolCalls.length > 0 ? "tools"
          : "done",
      };
    },
  };
}

/** Smaller models sometimes send broken JSON. An empty input fails the tool's
 *  required-field check, which tells the model to try again. */
function parseArguments(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
