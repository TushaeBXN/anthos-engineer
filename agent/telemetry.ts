/**
 * Tool execution telemetry and circuit breaker.
 *
 * Telemetry: logs every tool call result to .forge/telemetry.ndjson so you can
 * see which tools fail most and how long they take.
 *
 * Circuit breaker: after MAX_CONSECUTIVE_FAILURES failures of the same tool
 * (by name, not by arguments), the tool is blocked for the rest of the session
 * so the model can't thrash on a broken tool indefinitely. A call the policy or the person
 * refused never ran, so it says nothing about whether the tool works and doesn't count.
 */
import fs from "node:fs";
import path from "node:path";

export interface TelemetryEvent {
  timestamp: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface ToolStats {
  totalCalls: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  totalDurationMs: number;
}

const MAX_CONSECUTIVE_FAILURES = 3;

export class Telemetry {
  private readonly logPath: string;
  private readonly stats = new Map<string, ToolStats>();

  constructor(logDir = ".forge") {
    const dir = path.resolve(process.cwd(), logDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, "telemetry.ndjson");
  }

  /** Returns true if the tool is tripped by the circuit breaker. */
  isTripped(toolName: string): boolean {
    return (this.stats.get(toolName)?.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES;
  }

  /** refused: the call never ran (policy, person, or no one to ask); logged, but not a failure of the tool. */
  record(toolName: string, success: boolean, durationMs: number, error?: string, refused = false): void {
    const existing = this.stats.get(toolName) ?? {
      totalCalls: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      totalDurationMs: 0,
    };

    this.stats.set(toolName, {
      totalCalls: existing.totalCalls + 1,
      successes: success ? existing.successes + 1 : existing.successes,
      failures: success ? existing.failures : existing.failures + 1,
      consecutiveFailures: success ? 0 : refused ? existing.consecutiveFailures : existing.consecutiveFailures + 1,
      totalDurationMs: existing.totalDurationMs + durationMs,
    });

    const event: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      toolName,
      success,
      durationMs,
      ...(error ? { error } : {}),
    };

    fs.appendFileSync(this.logPath, JSON.stringify(event) + "\n", "utf8");
  }

  summary(): string {
    if (this.stats.size === 0) return "No tool calls recorded this session.";

    const rows: string[] = [];
    let totalCalls = 0;
    let totalSuccesses = 0;

    for (const [name, s] of this.stats.entries()) {
      const rate = ((s.successes / s.totalCalls) * 100).toFixed(0) + "%";
      const avg = (s.totalDurationMs / s.totalCalls).toFixed(0) + "ms";
      const tripped = s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? "  [tripped]" : "";
      rows.push(`  ${name.padEnd(20)} ${String(s.totalCalls).padStart(4)} calls  ${rate.padStart(5)} ok  ${avg.padStart(7)} avg${tripped}`);
      totalCalls += s.totalCalls;
      totalSuccesses += s.successes;
    }

    const overall = ((totalSuccesses / totalCalls) * 100).toFixed(0);
    return [
      "",
      `  Tool telemetry — ${totalCalls} calls, ${overall}% success`,
      "  " + "─".repeat(60),
      ...rows,
      "",
    ].join("\n");
  }
}

export const telemetry = new Telemetry();
