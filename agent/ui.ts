/**
 * Terminal output for Forge, styled after Claude Code:
 *
 *   - Model text at full strength, printed as-is.
 *   - Tool calls on their own line, preceded by ⎿ and dimmed.
 *   - A rotating spinner in-place while the model is working.
 *   - One compact status line after each turn.
 *   - No banners, boxes, or decorative borders.
 */
import readline from "node:readline/promises";
import type { UsageTracker } from "./usage.js";

export interface Screen {
  say(text: string): void;
  activity(label: string, detail?: string, failed?: boolean): void;
  note(text: string): void;
  working(on: boolean): void;
}

const tty = process.stdout.isTTY;
const color = tty && !process.env["NO_COLOR"];

const dim    = (s: string) => color ? `\x1b[2m${s}\x1b[0m`  : s;
const bold   = (s: string) => color ? `\x1b[1m${s}\x1b[0m`  : s;
const red    = (s: string) => color ? `\x1b[31m${s}\x1b[0m` : s;
const accent = (s: string) => color ? `\x1b[36m${s}\x1b[0m` : s;
const green  = (s: string) => color ? `\x1b[32m${s}\x1b[0m` : s;

// ── Spinner ───────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function startSpinner(): void {
  if (!tty || spinnerTimer) return;
  spinnerFrame = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${dim(FRAMES[spinnerFrame % FRAMES.length]!)} `);
    spinnerFrame++;
  }, 80);
}

function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  if (tty) process.stdout.write("\r\x1b[K"); // clear the spinner line
}

// ── Screen ────────────────────────────────────────────────────────────────────

export const terminal: Screen = {
  say(text) {
    console.log(`\n${text.trim()}\n`);
  },

  activity(label, detail, failed) {
    // ⎿ Read agent/loop.ts   +9 −0
    // ⎿ bash npm test         failed
    const hook = dim("⎿ ");
    const body = failed ? `${label}  ${red(detail ?? "failed")}` : detail ? `${label}  ${dim(detail)}` : label;
    console.log(dim(hook) + dim(body));
  },

  note(text) {
    console.log(dim(`  ${text}`));
  },

  working(on) {
    if (on) startSpinner();
    else stopSpinner();
  },
};

// ── Status line ───────────────────────────────────────────────────────────────

export function printStatus(usage: UsageTracker): void {
  const parts = usage.statusParts();
  // First part is model info — slightly brighter; rest are dim metadata.
  const [model, ...rest] = parts;
  const line = [dim(model ?? ""), ...rest.map(dim)].join(dim("  ·  "));
  console.log(line + "\n");
}

// ── Prompts ───────────────────────────────────────────────────────────────────

export async function confirm(question: string): Promise<"yes" | "no" | "always"> {
  if (!process.stdin.isTTY) return "no";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Claude Code style: the question is in the accent color, options are dim.
  const answer = (await rl.question(`${accent("?")} ${bold(question)}  ${dim("y · n · a(lways)")}\n${accent("›")} `)).trim().toLowerCase();
  rl.close();
  if (answer === "a" || answer === "always") return "always";
  return answer === "y" || answer === "yes" ? "yes" : "no";
}

export async function prompt(): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(green("> ")).then(resolve, () => resolve(null));
    });
  } finally {
    rl.close();
  }
}
