/**
 * Reasoning models served through OpenAI-compatible servers (Ollama, LM Studio) often put their
 * thinking in the reply itself, between <think> and </think>. Many chat templates already open
 * the <think> in the prompt, so the reply starts mid-thought and only the closing tag shows.
 * ThinkFilter removes the thinking from what is shown and from what is kept in the conversation.
 *
 * When thinking is expected (a reasoning model, or one that has closed a </think> before), the
 * reply is held back until </think> arrives; a reply that ends without one was all answer.
 * Otherwise text streams as it comes, and <think>…</think> blocks are cut out.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/** Model names that usually think before answering. */
export function looksLikeReasoningModel(model: string): boolean {
  return /deepseek|qwq|qwen3|(^|[^a-z])r1([^0-9]|$)|think|reason/i.test(model);
}

export class ThinkFilter {
  private mode: "maybe" | "thinking" | "answer";
  private buffer = "";
  /** The answer so far, without the thinking. */
  text = "";
  /** True once the model has closed a </think>: it thinks, so expect it next time. */
  sawClose = false;

  constructor(expectThinking: boolean) {
    this.mode = expectThinking ? "maybe" : "answer";
  }

  /**
   * The server sent the model's reasoning in a field of its own (Ollama's "reasoning", DeepSeek's
   * "reasoning_content"), so the reply text is answer: stop holding it back.
   */
  serverSeparates(): void {
    if (this.mode === "maybe") this.mode = "answer";
  }

  /** Take the next piece of the reply; returns the part that can be shown now. */
  push(delta: string): string {
    this.buffer += delta;
    let out = "";
    for (;;) {
      if (this.mode === "maybe" || this.mode === "thinking") {
        const close = this.buffer.indexOf(CLOSE);
        if (close < 0) {
          // Still thinking (or not yet known): show nothing. Thinking can be dropped as it goes.
          if (this.mode === "thinking") this.buffer = this.buffer.slice(-(CLOSE.length - 1));
          break;
        }
        this.buffer = this.buffer.slice(close + CLOSE.length).replace(/^\s+/, "");
        this.mode = "answer";
        this.sawClose = true;
        continue;
      }
      const open = this.buffer.indexOf(OPEN);
      const close = this.buffer.indexOf(CLOSE);
      if (close >= 0 && (open < 0 || close < open)) {
        // A </think> with no opening tag: what came before was thinking. It may already have been
        // shown, but it is dropped from the answer, and from now on such replies are held back.
        this.text = "";
        out = "";
        this.buffer = this.buffer.slice(close + CLOSE.length).replace(/^\s+/, "");
        this.sawClose = true;
        continue;
      }
      if (open >= 0) {
        out += this.buffer.slice(0, open);
        this.buffer = this.buffer.slice(open + OPEN.length);
        this.mode = "thinking";
        continue;
      }
      // Keep back a tail that could be the start of a tag split across pieces.
      const keep = partialTag(this.buffer);
      out += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      break;
    }
    this.text += out;
    return out;
  }

  /** The reply is complete; returns whatever is left to show. */
  end(): string {
    // Held back but never closed: there was no thinking, it was all answer.
    // Unclosed thinking (the reply was cut off mid-thought) is dropped.
    const out = this.mode === "thinking" ? "" : this.buffer;
    this.buffer = "";
    this.text += out;
    return out;
  }
}

/** Length of the longest end of text that is the start of a tag. */
function partialTag(text: string): number {
  for (let n = Math.min(text.length, CLOSE.length - 1); n > 0; n--) {
    const end = text.slice(-n);
    if (OPEN.startsWith(end) || CLOSE.startsWith(end)) return n;
  }
  return 0;
}

/** Remove thinking from a complete reply. */
export function stripThinking(text: string, expectThinking = false): string {
  const filter = new ThinkFilter(expectThinking);
  filter.push(text);
  filter.end();
  return filter.text;
}
