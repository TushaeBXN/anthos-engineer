/**
 * The few shapes the whole agent shares. Providers translate these to and from
 * their own API formats, so the loop and the tools never see provider types.
 */
import type { Access } from "../policy/check.js";

/** The model asking for a tool to be run. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What we send back to the model after running (or refusing) a tool call. */
export interface ToolResult {
  id: string;
  output: string;
  isError: boolean;
}

/** Token counts for one model request. */
export interface Usage {
  /** Input tokens billed at the full rate. */
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache (cheaper). */
  cachedTokens: number;
  outputTokens: number;
}

/** One reply from the model. */
export interface Reply {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** done: finished · tools: wants tools run · cut_off: hit the output limit · refused: declined */
  stopped: "done" | "tools" | "cut_off" | "refused";
}

/** A conversation with one model. It keeps its own message history. */
export interface Session {
  /** onText, when given, receives the reply's text piece by piece as the model writes it. */
  send(input: string | ToolResult[], onText?: (delta: string) => void): Promise<Reply>;
}

/** What the model is told about a tool. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    /** JSON Schema per input. Forge's own tools use type and description; MCP tools may use anything. */
    properties: Record<string, { type?: string | string[]; description?: string; [key: string]: unknown }>;
    required: string[];
  };
}

export interface ToolOutput {
  output: string;
  isError?: boolean;
  /** Set by tools that change a file, so the status line can count lines. */
  lines?: { file: string; added: number; removed: number };
}

/** A tool the agent can run. */
export interface Tool extends ToolSpec {
  /** What this call touches, so the policy can be checked before it runs. */
  access(input: Record<string, unknown>): Access;
  /** A short, human-readable line for the terminal, e.g. "Edit src/api.ts". */
  label(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, cwd: string): Promise<ToolOutput>;
}
