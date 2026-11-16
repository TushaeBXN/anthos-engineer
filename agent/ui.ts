/**
 * Terminal UI for Forge — panel-style layout inspired by Claude Code's Ink UI.
 *
 * Layout on startup:
 *
 *   ╭─────────────────────────────────────────────╮
 *   │  ▶  FORGE  by Anthos Intelligence            │
 *   │     claude-opus-5-5 · closed · hosted        │
 *   ╰─────────────────────────────────────────────╯
 *
 * Each turn:
 *
 *   ⠹                           ← spinner while working
 *   ⎿ Read agent/loop.ts        ← tool calls, left-railed
 *   ⎿ Edit agent/loop.ts  +9 −0
 *
 *   The model's answer here.    ← full-strength reply
 *
 *   ─────────────────────────────────────────────
 *   claude-opus-5-5 · 14k used · $0.07 · +9 −0
 */
import readline from "node:readline/promises";
import type { UsageTracker } from "./usage.js";

export interface Screen {
  say(text: string): void;
  activity(label: string, detail?: string, failed?: boolean): void;
  note(text: string): void;
  working(on: boolean): void;
}

// ── Colors ────────────────────────────────────────────────────────────────────

const tty   = process.stdout.isTTY;
const color = tty && !process.env["NO_COLOR"];

const dim    = (s: string) => color ? `\x1b[2m${s}\x1b[0m`     : s;
const bold   = (s: string) => color ? `\x1b[1m${s}\x1b[0m`     : s;
const red    = (s: string) => color ? `\x1b[31m${s}\x1b[0m`    : s;
const accent = (s: string) => color ? `\x1b[36m${s}\x1b[0m`    : s;
const green  = (s: string) => color ? `\x1b[32m${s}\x1b[0m`    : s;
const white  = (s: string) => color ? `\x1b[97m${s}\x1b[0m`    : s;

// ── Spinner ───────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function startSpinner(): void {
  if (!tty || spinnerTimer) return;
  spinnerFrame = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${accent(FRAMES[spinnerFrame % FRAMES.length]!)} `);
    spinnerFrame++;
  }, 80);
}

function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  if (tty) process.stdout.write("\r\x1b[K");
}

// ── Header panel ──────────────────────────────────────────────────────────────

/**
 * Printed once at startup.
 *
 *   ╭─────────────────────────────────────────────╮
 *   │  ▶  FORGE  by Anthos Intelligence            │
 *   │     claude-opus-5-5 · closed · hosted        │
 *   ╰─────────────────────────────────────────────╯
 */
export function printHeader(statusLine: string): void {
  const cols = tty ? (process.stdout.columns ?? 60) : 60;
  const width = Math.min(cols - 2, 72);
  const inner = width - 2; // inside the border

  const title  = `▶  FORGE  by Anthos Intelligence`;
  const sub    = statusLine;

  const pad = (s: string) => s.padEnd(inner);
  const rule = "─".repeat(width);

  console.log("");
  console.log(dim(`╭${rule}╮`));
  console.log(dim("│ ") + bold(white(pad(title))) + dim(" │"));
  console.log(dim("│ ") + dim(pad(sub))           + dim(" │"));
  console.log(dim(`╰${rule}╯`));
  console.log("");
}

// ── Screen ────────────────────────────────────────────────────────────────────

export const terminal: Screen = {
  say(text) {
    console.log(`\n${text.trim()}\n`);
  },

  activity(label, detail, failed) {
    // ⎿ Read agent/loop.ts   +9 −0
    const hook = "⎿ ";
    const tail = detail
      ? (failed ? `  ${red(detail)}` : `  ${dim(detail)}`)
      : "";
    console.log(dim(hook + label) + tail);
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

/** Printed after every turn, preceded by a thin rule. */
export function printStatus(usage: UsageTracker): void {
  const cols = tty ? (process.stdout.columns ?? 60) : 60;
  const rule = dim("─".repeat(Math.min(cols, 74)));
  const line = usage.statusParts().join(dim("  ·  "));
  console.log(rule);
  console.log(dim(line) + "\n");
}

/** The plain status string (for the header). */
export function statusLine(usage: UsageTracker): string {
  return usage.statusParts().join("  ·  ");
}

// ── Prompts ───────────────────────────────────────────────────────────────────

export async function confirm(question: string): Promise<"yes" | "no" | "always"> {
  if (!process.stdin.isTTY) return "no";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q  = `\n${accent("?")} ${bold(question)}  ${dim("y · n · a(lways)")}\n${green(">")} `;
  const answer = (await rl.question(q)).trim().toLowerCase();
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
