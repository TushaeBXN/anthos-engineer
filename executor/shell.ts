/**
 * Executes whitelisted shell commands on behalf of an agent.
 * Every call must present a valid, unexpired capability token.
 * Agents never get a raw shell handle — only this module spawns processes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCapability } from "../capability/issuer.js";
import { CapabilityError } from "../capability/schema.js";
import { recordDecision } from "../policy/audit.js";
import type { PolicyDecisionRecord } from "../policy/schema.js";

const execFileAsync = promisify(execFile);

export interface ShellResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

// Only these commands may be executed by agents for MVP.
// Each entry is [binary, ...allowedArgPrefixes].
const WHITELIST: Array<{ binary: string; args: RegExp }> = [
  { binary: "npm", args: /^(test|run test)$/ },
  { binary: "npx", args: /^(tsc|tsc --noEmit|eslint)/ },
  { binary: "node", args: /^--test/ },
];

function isWhitelisted(binary: string, args: string[]): boolean {
  const argStr = args.join(" ");
  return WHITELIST.some(
    (entry) => entry.binary === binary && entry.args.test(argStr),
  );
}

function revalidate(
  capabilityId: string,
  binary: string,
  args: string[],
): void {
  const cap = getCapability(capabilityId);

  if (new Date() > new Date(cap.expiresAt)) {
    throw new CapabilityError(
      `Capability '${capabilityId}' expired at ${cap.expiresAt}`,
      "EXPIRED",
    );
  }

  if (cap.resource !== "shell") {
    throw new CapabilityError(
      `Capability resource is '${cap.resource}', not 'shell'`,
      "OPERATION_MISMATCH",
    );
  }

  const fullCommand = [binary, ...args].join(" ");
  if (cap.operation !== "*" && !fullCommand.startsWith(cap.operation)) {
    throw new CapabilityError(
      `Capability grants '${cap.operation}', but requested '${fullCommand}'`,
      "OPERATION_MISMATCH",
    );
  }

  if (!isWhitelisted(binary, args)) {
    throw new CapabilityError(
      `Command '${binary} ${args.join(" ")}' is not on the executor whitelist`,
      "NOT_WHITELISTED",
    );
  }
}

export async function runCommand(
  capabilityId: string,
  binary: string,
  args: string[],
  cwd = process.cwd(),
): Promise<ShellResult> {
  const command = `${binary} ${args.join(" ")}`;
  try {
    revalidate(capabilityId, binary, args);
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      timeout: 120_000,
    });
    return { success: true, command, stdout, stderr, exitCode: 0 };
  } catch (err) {
    const execErr = err as Error & { stdout?: string; stderr?: string; code?: number };
    const msg = execErr.message;
    _auditFailure(capabilityId, command, msg);
    return {
      success: false,
      command,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? msg,
      exitCode: execErr.code ?? 1,
      error: msg,
    };
  }
}

function _auditFailure(
  capabilityId: string,
  command: string,
  reason: string,
): void {
  try {
    const rec: PolicyDecisionRecord = {
      request: {
        resource: "shell",
        operation: command,
        target: "*",
        agentId: "unknown",
        sessionId: capabilityId,
      },
      decision: "deny",
      matchedRuleId: null,
      reason: `Executor re-validation failed: ${reason}`,
      timestamp: new Date().toISOString(),
    };
    recordDecision(rec);
  } catch {
    // Swallow audit errors
  }
}
