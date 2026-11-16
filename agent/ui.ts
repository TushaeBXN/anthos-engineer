/**
 * Everything Forge prints. The rules that keep it calm:
 *
 *   - The model's words are the only full-strength text.
 *   - Everything Forge adds (tool activity, status) is dim and indented.
 *   - One color, used for one thing: a question that needs an answer.
 *   - No banners, boxes or progress bars.
 */
import readline from "node:readline/promises";
import type { UsageTracker } from "./usage.js";

/** What the loop needs from a screen. Tests pass a silent one. */
export interface Screen {
  /** The model's words. */
  say(text: string): void;
  /** One line of tool activity, e.g. "Edit src/api.ts". detail is "+3 −1" or an error. */
  activity(label: string, detail?: string, failed?: boolean): void;
  /** A short note from Forge itself. */
  note(text: string): void;
  /** Show or clear the "working" indicator. */
  working(on: boolean): void;
}

const color = process.stdout.isTTY && !process.env["NO_COLOR"];
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const accent = (s: string) => (color ? `\x1b[36m${s}\x1b[0m` : s);

export const terminal: Screen = {
  say(text) {
    console.log(`\n${text.trim()}\n`);
  },
  activity(label, detail, failed) {
    const tail = detail ? `  ${failed ? red(detail) : detail}` : "";
    console.log(dim(`  ${label}${tail}`));
  },
  note(text) {
    console.log(dim(`  ${text}`));
  },
  working(on) {
    if (!process.stdout.isTTY) return;
    process.stdout.write(on ? dim("  Working…") : "\r\x1b[K");
  },
};

/** The status line, printed once after each turn. */
export function printStatus(usage: UsageTracker): void {
  console.log(dim(`  ${usage.statusParts().join("    ")}`) + "\n");
}

/** Ask a yes/no question. Returns "always" when the person wants no more of this question. */
export async function confirm(question: string): Promise<"yes" | "no" | "always"> {
  if (!process.stdin.isTTY) return "no"; // nobody to ask
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${accent(question)}  ${dim("y yes · n no · a always")}  `)).trim().toLowerCase();
  rl.close();
  if (answer === "a" || answer === "always") return "always";
  return answer === "y" || answer === "yes" ? "yes" : "no";
}

/** Read one line from the person. Returns null at end of input (Ctrl-D). */
export async function prompt(): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question("› ").then(resolve, () => resolve(null));
    });
  } finally {
    rl.close();
  }
}
