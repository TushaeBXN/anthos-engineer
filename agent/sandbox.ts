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
 *     (a git hook or config would run code later, outside the sandbox), and .git and .forge
 *     can't be moved, removed or replaced;
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
  /**
   * Call once the command has finished. Returns a message when the command created a protected path
   * that the sandbox couldn't guard because it didn't exist yet (Linux), which is now set aside; else "".
   */
  after?: () => string;
}

/** Paths in the project that commands must not change: Forge's rules and records, and git settings and hooks. */
const PROTECTED = ["forge.policy.yaml", ".forge", ".forge/audit.db", ".git", ".git/config", ".git/hooks"];

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
  // bwrap can be installed and still unable to start a sandbox (user namespaces turned off, as in some containers).
  const broken = kind === "bubblewrap" && platform === process.platform ? bwrapProblem() : null;
  if (broken) return { mode, active: false, kind: null, network: true, reason: `bubblewrap is installed but can't start a sandbox here: ${broken}` };
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
  if (!status.active || !/operation not permitted|permission denied|read-only file system|device or resource busy|could not resolve host|network is unreachable/i.test(output)) return "";
  // A protected path inside the project: say so, since "only inside the project" wouldn't explain it.
  // Whole path parts only: ".forge-cache" or ".github" isn't one of them.
  if (/(?:^|[\s/'"`])(?:forge\.policy\.yaml|\.forge|\.git)(?=$|[\s/'"`:])/m.test(output)) {
    return "\n(Forge's sandbox blocked this: even inside the project, commands can't change forge.policy.yaml or .forge, change git's config or hooks, or move, remove or create .git and .forge (so `git init` and `git config` are blocked). Ordinary git commands work. If this is needed, ask the user to run it.)";
  }
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
; .git and .forge themselves can't be moved, removed or created, so they can't be swapped for others.
(deny file-write*
  (literal (string-append (param "PROJECT") "/forge.policy.yaml"))
  (literal (string-append (param "PROJECT") "/.git"))
  (literal (string-append (param "PROJECT") "/.forge"))
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
  const at = (rel: string) => path.join(project, rel);
  const ro = (rel: string) => (present(at(rel)) ? ["--ro-bind", at(rel), at(rel)] : []);
  // Mounting a folder onto itself makes it a mount point, which can't be moved or removed; what's inside stays writable.
  const pin = (rel: string) => {
    const p = at(rel);
    if (!present(p)) return [];
    return fs.lstatSync(p).isDirectory() ? ["--bind", p, p] : ["--ro-bind", p, p];
  };
  // bubblewrap can only protect paths that exist. Note which don't, to check after the command.
  const missing = PROTECTED.filter((rel) => !present(at(rel)));
  return {
    file: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--unshare-pid",
      "--bind", "/tmp", "/tmp",
      "--bind", project, project,
      // Pinned in place, then read-only again inside the writable project (only possible for paths that exist).
      ...pin(".git"),
      ...pin(".forge"),
      ...ro("forge.policy.yaml"),
      ...ro(".forge/audit.db"),
      ...ro(".git/config"),
      ...ro(".git/hooks"),
      // Credentials: an empty folder in their place.
      ...SECRET_DIRS.flatMap((d) => (exists(path.join(home, d)) ? ["--tmpfs", path.join(home, d)] : [])),
      ...(network ? [] : ["--unshare-net"]),
      "--setenv", INSIDE, "1",
      "--die-with-parent",
      "--chdir", project,
      "--", file, ...args,
    ],
    after: () => setAside(project, missing),
  };
}

/**
 * After a command: any protected path that didn't exist before and does now was made by the command.
 * Rename it to "<name>.blocked-by-forge", so nothing reads or runs it and nothing is lost.
 * The command's own processes are gone by now (it ran in its own process namespace), so none can recreate it.
 */
export function setAside(project: string, missing: string[]): string {
  const moved: string[] = [];
  for (const rel of missing) {
    const p = path.join(project, rel);
    // Inside a path already set aside (a new .git with its config), there's nothing left to move.
    if (!present(p) || moved.some((m) => rel.startsWith(m + "/"))) continue;
    let target = `${p}.blocked-by-forge`;
    for (let n = 2; present(target); n++) target = `${p}.blocked-by-forge-${n}`;
    try {
      fs.renameSync(p, target);
      moved.push(rel);
    } catch {
      moved.push(`${rel} (couldn't be moved: remove it yourself)`);
    }
  }
  if (!moved.length) return "";
  return `Forge's sandbox set aside ${moved.join(", ")}, which the command created: commands can't create Forge's policy or records, or git settings and hooks. Each was renamed to *.blocked-by-forge. If it's needed (git init, say), ask the user to do it.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Exists, counting a symlink even when what it points to doesn't. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

let bwrapChecked: { problem: string | null } | undefined;

/** Try bubblewrap once, the way commands will use it. Null when it works, else why not. */
function bwrapProblem(): string | null {
  if (!bwrapChecked) {
    try {
      execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--", "/bin/true"], { stdio: ["ignore", "ignore", "pipe"], timeout: 5_000 });
      bwrapChecked = { problem: null };
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim().split("\n")[0];
      bwrapChecked = { problem: stderr || (err as Error).message };
    }
  }
  return bwrapChecked.problem;
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
