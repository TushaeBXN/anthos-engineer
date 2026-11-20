/**
 * The sandbox: commands Forge runs (bash, verify) run inside the operating system's own sandbox,
 * so even an approved command can only change the project folder and temp files.
 *
 *   macOS  Seatbelt (sandbox-exec), built into the OS.
 *   Linux  bubblewrap (bwrap), if installed.
 *
 * Inside it:
 *   - writes are allowed only in the project and the temp folders;
 *   - forge.policy.yaml, the audit log, .git/config and .git/hooks can't be changed even there
 *     (a git hook or config would run code later, outside the sandbox);
 *   - ~/.ssh, ~/.aws and ~/.gnupg can't be read or written;
 *   - the internet can be switched off (sandboxNetwork off); this machine (localhost) stays reachable.
 *
 * It covers commands. Forge's own read, write and edit tools run inside Forge and are covered by the policy.
 * Settings: forge config set sandbox auto|on|off (default auto), forge config set sandboxNetwork on|off.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxSettings } from "./models.js";

export interface SandboxStatus {
  /** What was asked for: auto (use it when available), on (required), off. */
  mode: "auto" | "on" | "off";
  /** Whether commands will run sandboxed. */
  active: boolean;
  kind: "seatbelt" | "bubblewrap" | null;
  /** Whether sandboxed commands may reach the internet. */
  network: boolean;
  /** Why it isn't active, when it isn't. */
  reason?: string;
  /** Already running inside Forge's sandbox: what runs now is held by it, and a sandbox can't start inside another. */
  inside?: boolean;
}

/** A command, ready for execFile: the program and its arguments. */
export interface Launch {
  file: string;
  args: string[];
}

const SECRET_DIRS = [".ssh", ".aws", ".gnupg"];
/** Set on every sandboxed command, so anything it starts (a test that runs Forge, say) knows it's already inside. */
const INSIDE = "FORGE_SANDBOXED";

export function sandboxStatus(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): SandboxStatus {
  const settings = sandboxSettings(env);
  const mode = settings.mode === "on" || settings.mode === "off" ? settings.mode : "auto";
  if (env[INSIDE] === "1") return { mode, active: false, kind: null, network: settings.network, inside: true, reason: "already inside Forge's sandbox" };
  if (mode === "off") return { mode, active: false, kind: null, network: true, reason: "turned off (forge config set sandbox off)" };
  const kind = platform === "darwin" && exists("/usr/bin/sandbox-exec") ? "seatbelt" : platform === "linux" && onPath("bwrap") ? "bubblewrap" : null;
  if (!kind) {
    const reason = platform === "linux" ? "bubblewrap isn't installed (apt install bubblewrap, or dnf install bubblewrap)" : `no sandbox support on ${platform}`;
    return { mode, active: false, kind: null, network: true, reason };
  }
  return { mode, active: true, kind, network: settings.network };
}

/**
 * How to run `file args` in cwd: inside the sandbox when it's active, as is when it's off or unavailable in auto mode.
 * Returns an error message instead when the sandbox is required (mode on) but can't be used.
 */
export function sandboxed(file: string, args: string[], cwd: string, status: SandboxStatus = sandboxStatus()): Launch | { error: string } {
  if (!status.active) {
    if (status.mode === "on" && !status.inside) return { error: `The sandbox is required (sandbox on) but can't run here: ${status.reason}. Nothing was run.` };
    return { file, args };
  }
  const project = real(cwd);
  return status.kind === "seatbelt" ? seatbelt(file, args, project, status.network) : bubblewrap(file, args, project, status.network);
}

/** A hint to add to a failed command's output when the sandbox may be why. */
export function sandboxHint(output: string, status: SandboxStatus): string {
  if (!status.active || !/operation not permitted|permission denied|read-only file system|could not resolve host|network is unreachable/i.test(output)) return "";
  return `\n(Forge's sandbox may have blocked this: commands can write only inside the project and temp folders${status.network ? "" : ", and can't reach the internet"}. If the command needs more, ask the user to run it.)`;
}

// ── macOS ─────────────────────────────────────────────────────────────────────

/**
 * Seatbelt profile. Later rules win, so the exceptions come after the rules they narrow.
 * Paths are passed as parameters (-D), so nothing in them needs escaping.
 */
export const SEATBELT_PROFILE = `(version 1)
(allow default)

; Writes: only the project, temp folders and the terminal.
(deny file-write*)
(allow file-write*
  (subpath (param "PROJECT"))
  (subpath (param "TMP"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr")
  (regex #"^/dev/tty") (regex #"^/dev/fd/"))

; Even in the project: Forge's rules and records, and git settings and hooks (they run code later, unsandboxed).
(deny file-write*
  (literal (string-append (param "PROJECT") "/forge.policy.yaml"))
  (regex (string-append "^" (param "PROJECT_RE") "/\\\\.forge/audit\\\\.db"))
  (literal (string-append (param "PROJECT") "/.git/config"))
  (subpath (string-append (param "PROJECT") "/.git/hooks")))

; Credentials: no reading or writing.
(deny file-read* file-write*
  (subpath (string-append (param "HOME") "/.ssh"))
  (subpath (string-append (param "HOME") "/.aws"))
  (subpath (string-append (param "HOME") "/.gnupg")))
`;

const NO_INTERNET = `
; No internet; this machine stays reachable (local model servers, test servers).
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:*"))
`;

function seatbelt(file: string, args: string[], project: string, network: boolean): Launch {
  const params = {
    PROJECT: project,
    PROJECT_RE: project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    TMP: real(os.tmpdir()),
    HOME: os.homedir(),
  };
  return {
    file: "/usr/bin/sandbox-exec",
    args: ["-p", SEATBELT_PROFILE + (network ? "" : NO_INTERNET), ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/usr/bin/env", `${INSIDE}=1`, file, ...args],
  };
}

// ── Linux ─────────────────────────────────────────────────────────────────────

function bubblewrap(file: string, args: string[], project: string, network: boolean): Launch {
  const home = os.homedir();
  const ro = (p: string) => (exists(p) ? ["--ro-bind", p, p] : []);
  return {
    file: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--bind", "/tmp", "/tmp",
      "--bind", project, project,
      // Read-only again inside the writable project (only possible for paths that exist).
      ...ro(path.join(project, "forge.policy.yaml")),
      ...ro(path.join(project, ".forge", "audit.db")),
      ...ro(path.join(project, ".git", "config")),
      ...ro(path.join(project, ".git", "hooks")),
      // Credentials: an empty folder in their place.
      ...SECRET_DIRS.flatMap((d) => (exists(path.join(home, d)) ? ["--tmpfs", path.join(home, d)] : [])),
      ...(network ? [] : ["--unshare-net"]),
      "--setenv", INSIDE, "1",
      "--die-with-parent",
      "--chdir", project,
      "--", file, ...args,
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function onPath(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
