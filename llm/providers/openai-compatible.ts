/**
 * OpenAI-compatible provider — works with:
 *   OpenAI          FORGE_BASE_URL unset, OPENAI_API_KEY set
 *   Ollama          FORGE_BASE_URL=http://localhost:11434/v1, OPENAI_API_KEY=ollama
 *   Groq            FORGE_BASE_URL=https://api.groq.com/openai/v1
 *   Together AI     FORGE_BASE_URL=https://api.together.xyz/v1
 *   Fireworks       FORGE_BASE_URL=https://api.fireworks.ai/inference/v1
 *   LM Studio       FORGE_BASE_URL=http://localhost:1234/v1, OPENAI_API_KEY=lm-studio
 *   any other endpoint that supports the OpenAI function-calling interface
 */
import OpenAI from "openai";
import type { Plan } from "../schema.js";
import { PLAN_TOOL_SCHEMA, SYSTEM_PROMPT } from "../schema.js";

export async function planWithOpenAICompatible(
  userMessage: string,
  model: string,
): Promise<Plan> {
  const apiKey = process.env["OPENAI_API_KEY"] ?? "forge";
  const baseURL = process.env["FORGE_BASE_URL"]; // undefined → OpenAI default

  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "propose_plan",
          description: "Submit the structured change plan. Call this exactly once.",
          parameters: PLAN_TOOL_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "propose_plan" } },
  });

  const raw = response.choices[0]?.message?.tool_calls?.[0];
  if (!raw || raw.type !== "function" || raw.function.name !== "propose_plan") {
    throw new Error("Model did not call propose_plan — unexpected response.");
  }

  return JSON.parse(raw.function.arguments) as Plan;
}
