/**
 * Keeps score for one session and turns it into the status line:
 *
 *   claude-opus-5-5 · closed · hosted    61k used, 939k left    $0.84 used, $4.16 left    +124 −31 in 4 files
 *
 * Three questions, left to right: what am I running, how much have I used and
 * how much is left, and how much code has changed.
 */
import type { ModelInfo } from "./models.js";
import type { Usage } from "./types.js";

/** Cached input is billed at about a tenth of the normal input price. */
const CACHED_PRICE = 0.1;

export class UsageTracker {
  inputTokens = 0;
  cachedTokens = 0;
  outputTokens = 0;
  /** Tokens the conversation occupies right now (the size of the last request). */
  contextUsed = 0;
  private files = new Map<string, { added: number; removed: number }>();

  constructor(
    readonly model: ModelInfo,
    /** Spending limit in dollars the person set with FORGE_BUDGET_USD, if any. */
    readonly budgetUsd: number | null = null,
  ) {}

  /** Record one model reply. */
  addReply(usage: Usage): void {
    this.inputTokens += usage.inputTokens;
    this.cachedTokens += usage.cachedTokens;
    this.outputTokens += usage.outputTokens;
    this.contextUsed = usage.inputTokens + usage.cachedTokens + usage.outputTokens;
  }

  /** Record lines changed in one file by a write or edit. */
  addLines(file: string, added: number, removed: number): void {
    const total = this.files.get(file) ?? { added: 0, removed: 0 };
    this.files.set(file, { added: total.added + added, removed: total.removed + removed });
  }

  /** Estimated dollars spent so far, or null when the price is not known. */
  get costUsd(): number | null {
    const price = this.model.price;
    if (!price) return null;
    const input = this.inputTokens + this.cachedTokens * CACHED_PRICE;
    return (input * price.input + this.outputTokens * price.output) / 1_000_000;
  }

  /** True once spending has reached the budget. */
  get overBudget(): boolean {
    return this.budgetUsd !== null && this.costUsd !== null && this.costUsd >= this.budgetUsd;
  }

  /** Paths of the files the agent has changed. */
  get changedFiles(): string[] {
    return [...this.files.keys()];
  }

  get linesChanged(): { added: number; removed: number; files: number } {
    let added = 0;
    let removed = 0;
    for (const file of this.files.values()) {
      added += file.added;
      removed += file.removed;
    }
    return { added, removed, files: this.files.size };
  }

  /** The parts of the status line, in order. Empty parts are left out. */
  statusParts(): string[] {
    const { model } = this;
    const parts = [[model.model, model.weights === "unknown" ? null : model.weights, model.runs].filter(Boolean).join(" · ")];

    // Context: how full the conversation is.
    if (model.contextWindow) {
      const left = Math.max(0, model.contextWindow - this.contextUsed);
      parts.push(`${tokens(this.contextUsed)} used, ${tokens(left)} left`);
    } else {
      parts.push(`${tokens(this.contextUsed)} used`);
    }

    // Money: what it has cost, against the budget if one is set.
    const cost = this.costUsd;
    if (model.runs === "local") {
      parts.push("free");
    } else if (cost !== null && this.budgetUsd !== null) {
      parts.push(`${dollars(cost)} used, ${dollars(Math.max(0, this.budgetUsd - cost))} left`);
    } else if (cost !== null) {
      parts.push(`${dollars(cost)} used`);
    }

    // Code: lines the agent has added and removed.
    const lines = this.linesChanged;
    if (lines.files > 0) {
      parts.push(`+${lines.added} −${lines.removed} in ${lines.files} file${lines.files === 1 ? "" : "s"}`);
    }
    return parts;
  }
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

/** One decimal below 100, none above: 1.5k, 61k, 939k. */
function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}
