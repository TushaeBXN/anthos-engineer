import Anthropic from "@anthropic-ai/sdk";
import type { Plan } from "../schema.js";
import { PLAN_TOOL_SCHEMA, SYSTEM_PROMPT } from "../schema.js";

export async function planWithAnthropic(
  userMessage: string,
  model: string,
): Promise<Plan> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "propose_plan",
        description: "Submit the structured change plan. Call this exactly once.",
        input_schema: PLAN_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Anthropic did not call propose_plan — unexpected response.");
  }

  return toolUse.input as Plan;
}
