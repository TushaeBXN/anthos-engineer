/**
 * Automatic context compaction: when the conversation is about to outgrow the
 * model's context window, the model summarizes it and the summary replaces it.
 *
 * Each provider implements Session.compact() with the prompts below. The loop
 * decides when (shouldCompact) and what to send next (CONTINUE).
 */
import type { ToolResult } from "./types.js";

export const SUMMARY_PROMPT = `Your context window is nearly full, so this conversation is about to be replaced by a summary that you write now. Write it for yourself, to carry on without the original messages. Include:
- what the user asked for, and any constraints or preferences they gave;
- what has been done so far: files read and changed (with paths), decisions made, errors hit and how they were resolved;
- the results of the most recent tool calls that still matter;
- what remains to do, and the very next step.
Be specific (paths, names, exact errors) but brief. Do not call any tools. Reply with the summary only.`;

/** Recent tool results kept word for word next to the summary, up to this many characters in all. */
export const RECENT_CHARS = 6_000;

/**
 * What replaces the conversation: the model's summary, plus the user's latest request and the latest
 * tool results word for word. Forge has those itself, so a weak summary can't lose the task.
 */
export function carried(summary: string, latestRequest: string, pending: string | ToolResult[] | undefined): string {
  const parts = [`[A summary of the conversation so far, written by you because the context window was nearly full]\n${summary}`];
  if (latestRequest) parts.push(`[The user's request, word for word, for reference. Some of it is already done: see the summary]\n${latestRequest}`);
  const recent = pending === undefined ? "" : asText(pending);
  if (recent && recent !== latestRequest) {
    parts.push(`[The latest tool results, word for word]\n${recent.length > RECENT_CHARS ? `${recent.slice(0, RECENT_CHARS)}\n(cut)` : recent}`);
  }
  return parts.join("\n\n");
}

/** Starts the first message after a compaction with what was carried over. */
export function withSummary(carry: string, next: string): string {
  return `${carry}\n\n[Continue]\n${next}`;
}

/** Input after a compaction, as plain text: the tool calls that results answer were summarized away. */
export function asText(input: string | ToolResult[]): string {
  return typeof input === "string" ? input : input.map((r) => `Result of tool call ${r.id}:\n${r.output}`).join("\n\n");
}

/** What the loop sends after compacting mid-task. The pending tool results were folded into the summary. */
export const CONTINUE =
  "Continue from where you left off. Don't redo work the summary says is done; read a file again only if you need exact details the summary and the latest results don't give you.";

/** Pending tool output can be large; in the summary request each is cut to this, so the request still fits. */
export const MAX_PENDING_CHARS = 12_000;

export function shortenForSummary(results: ToolResult[]): ToolResult[] {
  return results.map((r) =>
    r.output.length <= MAX_PENDING_CHARS ? r : { ...r, output: `${r.output.slice(0, MAX_PENDING_CHARS)}\n(cut for the summary)` },
  );
}

/** Stands in for the summary when summarizing fails: the history is cleared anyway, since the next request would not fit. */
export const CLEARED = "The earlier conversation was cleared because it no longer fit in the context window, and summarizing it failed.";

/** Rough token count for text not yet sent: about four characters per token. */
export function estimateTokens(input: string | ToolResult[] | undefined): number {
  if (input === undefined) return 0;
  const chars = typeof input === "string" ? input.length : input.reduce((n, r) => n + r.output.length, 0);
  return Math.ceil(chars / 4);
}

/**
 * Compact when the last request's size plus what is about to be sent would pass `at` of the window
 * (default 70%, leaving room for the summary itself). Never when the window is unknown or `at` is 0.
 */
export function shouldCompact(contextUsed: number, pending: string | ToolResult[], window: number | null, at: number, floor = 0): boolean {
  if (!window || at <= 0) return false;
  const projected = contextUsed + estimateTokens(pending);
  // `floor` is the size right after the last compaction: the system prompt and tool definitions can't be
  // summarized away, so don't compact again until the conversation has really grown since then.
  return projected > window * at && projected - floor > window * MIN_GROWTH;
}

/** Growth since the last compaction, as a share of the window, needed before compacting again. */
export const MIN_GROWTH = 0.15;
