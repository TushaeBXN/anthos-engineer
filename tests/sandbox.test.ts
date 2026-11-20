import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { sandboxStatus, sandboxed, sandboxHint, setAside } from "../agent/sandbox.js";
import { bash } from "../tools/bash.js";
import { sandboxSettings } from "../agent/models.js";

const env = (vars: Record<string, string>) => ({ ...vars });

describe("sandbox — settings", () => {
  test("auto uses what the OS has; off turns it off; on without support says so", () => {
    assert.equal(sandboxStatus(env({}), "darwin").kind, fs.existsSync("/usr/bin/sandbox-exec") ? "seatbelt" : null);
    assert.deepEqual(sandboxStatus(env({ FORGE_SANDBOX: "off" }), "darwin").active, false);
    const windows = sandboxStatus(env({ FORGE_SANDBOX: "on" }), "win32");
    assert.equal(windows.active, false);
    assert.match(windows.reason!, /no sandbox support on win32/);
  });

  test("required but unavailable: nothing runs, and the reason is given", () => {
    const status = sandboxStatus(env({ FORGE_SANDBOX: "on" }), "win32");
    const launch = sandboxed("/bin/sh", ["-c", "echo hi"], os.tmpdir(), status);
    assert.ok("error" in launch);
    assert.match(launch.error, /required.*Nothing was run/);
  });

  test("auto but unavailable: runs as before", () => {
    const status = sandboxStatus(env({}), "win32");
    assert.deepEqual(sandboxed("/bin/sh", ["-c", "echo hi"], os.tmpdir(), status), { file: "/bin/sh", args: ["-c", "echo hi"] });
  });

  test("inside the sandbox already: run as is, even when required (the outer sandbox holds)", () => {
    const status = sandboxStatus(env({ FORGE_SANDBOXED: "1", FORGE_SANDBOX: "on" }), "darwin");
    assert.equal(status.inside, true);
    assert.deepEqual(sandboxed("/bin/sh", ["-c", "echo hi"], os.tmpdir(), status), { file: "/bin/sh", args: ["-c", "echo hi"] });
  });

  test("network off: only on request", () => {
    // Settings alone, so this runs the same on every OS.
    assert.equal(sandboxSettings(env({})).network, true);
    assert.equal(sandboxSettings(env({ FORGE_SANDBOX_NETWORK: "off" })).network, false);
  });

  test("bubblewrap on Linux: the project is writable, the rest read-only, credentials hidden", () => {
    const status = { mode: "auto" as const, active: true, kind: "bubblewrap" as const, network: false };
    const launch = sandboxed("/bin/sh", ["-c", "make"], os.tmpdir(), status);
    assert.ok(!("error" in launch));
    const a = launch.args.join(" ");
    assert.equal(launch.file, "bwrap");
    assert.match(a, /^--ro-bind \/ \//);
    assert.match(a, new RegExp(`--bind ${fs.realpathSync(os.tmpdir()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
    assert.match(a, /--unshare-net/);
    assert.match(a, /-- \/bin\/sh -c make$/);
  });

  test("bubblewrap pins .git and .forge in place, and checks afterwards for protected paths that didn't exist", () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-")));
    fs.mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(project, ".git", "config"), "");
    const status = { mode: "auto" as const, active: true, kind: "bubblewrap" as const, network: true };
    const launch = sandboxed("/bin/sh", ["-c", "true"], project, status);
    assert.ok(!("error" in launch));
    const a = launch.args.join(" ");
    assert.match(a, new RegExp(`--bind ${project}/\\.git ${project}/\\.git `));
    assert.match(a, new RegExp(`--ro-bind ${project}/\\.git/hooks `));
    assert.equal(typeof launch.after, "function");
    // Nothing created: nothing to report.
    assert.equal(launch.after!(), "");
    fs.rmSync(project, { recursive: true, force: true });
  });

  test("setAside renames protected paths a command created, and only those", () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-aside-")));
    fs.writeFileSync(path.join(project, "forge.policy.yaml"), "default: allow\n");
    fs.mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(project, ".git", "hooks", "pre-commit"), "evil");
    fs.writeFileSync(path.join(project, "notes.txt"), "mine");
    const message = setAside(project, ["forge.policy.yaml", ".git", ".git/config", ".git/hooks"]);
    assert.match(message, /set aside forge\.policy\.yaml, \.git, which the command created/);
    assert.equal(fs.existsSync(path.join(project, "forge.policy.yaml")), false);
    assert.equal(fs.readFileSync(path.join(project, "forge.policy.yaml.blocked-by-forge"), "utf8"), "default: allow\n");
    assert.equal(fs.existsSync(path.join(project, ".git.blocked-by-forge", "hooks", "pre-commit")), true);
    assert.equal(fs.existsSync(path.join(project, "notes.txt")), true);
    // A second time: the earlier copy is kept, the new one gets a number.
    fs.writeFileSync(path.join(project, "forge.policy.yaml"), "again\n");
    setAside(project, ["forge.policy.yaml"]);
    assert.equal(fs.readFileSync(path.join(project, "forge.policy.yaml.blocked-by-forge-2"), "utf8"), "again\n");
    assert.equal(setAside(project, ["forge.policy.yaml"]), "");
    fs.rmSync(project, { recursive: true, force: true });
  });

  test("a hint is added only when the sandbox may be why a command failed", () => {
    const on = { mode: "auto" as const, active: true, kind: "seatbelt" as const, network: true };
    assert.match(sandboxHint("touch: /x: Operation not permitted", on), /sandbox may have blocked this/);
    assert.equal(sandboxHint("Error: tests failed", on), "");
    assert.equal(sandboxHint("Operation not permitted", { ...on, active: false }), "");
  });

  test("when a protected file inside the project is what was blocked, the hint says so", () => {
    const on = { mode: "auto" as const, active: true, kind: "seatbelt" as const, network: true };
    assert.match(sandboxHint("/p/.git/hooks/: Operation not permitted", on), /git init/);
    assert.match(sandboxHint("sh: forge.policy.yaml: Read-only file system", on), /can't change forge\.policy\.yaml/);
    assert.match(sandboxHint("mv: cannot move '.git' to '.git-old': Device or resource busy", on), /move, remove or create \.git/);
    assert.doesNotMatch(sandboxHint("touch: /Users/x/a.txt: Operation not permitted", on), /git init/);
    // .github isn't .git
    assert.doesNotMatch(sandboxHint("/p/.github/x: Operation not permitted", on), /git init/);
  });
});

// The real thing, on a Mac: escape attempts through Forge's own bash tool.
const mac = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
// Run by Forge's own verify, these tests are already inside a sandbox, which a second one can't be started in.
const inside = process.env["FORGE_SANDBOXED"] === "1";

describe("sandbox — macOS, for real", { skip: !mac ? "needs macOS" : inside ? "already inside Forge's sandbox" : false }, () => {
  let cwd = "";
  let server: http.Server;
  let local = "";
  const saved = process.env["FORGE_SANDBOX_NETWORK"];
  const run = async (command: string) => bash.run({ command }, cwd);
  const outsideFile = path.join(os.homedir(), `forge-sandbox-test-${process.pid}.txt`);

  before(async () => {
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-sandbox-")));
    execFileSync("git", ["init", "-q"], { cwd });
    fs.mkdirSync(path.join(cwd, ".forge"));
    fs.writeFileSync(path.join(cwd, ".forge", "audit.db"), "");
    fs.writeFileSync(path.join(cwd, "forge.policy.yaml"), "version: 1\n");
    server = http.createServer((_req, res) => res.end("local ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => {
    server.close();
    fs.rmSync(outsideFile, { force: true });
    if (saved === undefined) delete process.env["FORGE_SANDBOX_NETWORK"];
    else process.env["FORGE_SANDBOX_NETWORK"] = saved;
  });

  test("writes in the project and temp folders work", async () => {
    assert.equal((await run("echo hi > inside.txt && cat inside.txt")).output, "hi");
    assert.equal((await run("echo x > .forge/telemetry.ndjson && echo ok")).output, "ok");
    assert.equal((await run(`echo x > "${path.join(os.tmpdir(), `forge-sb-${process.pid}`)}" && echo ok`)).output, "ok");
  });

  test("writes outside the project are blocked, with a hint for the model", async () => {
    const r = await run(`echo escaped > "${outsideFile}"`);
    assert.equal(r.isError, true);
    assert.equal(fs.existsSync(outsideFile), false);
    assert.match(r.output, /sandbox may have blocked this/);
  });

  test("the policy file and the audit log can't be changed, even inside the project", async () => {
    assert.equal((await run("echo 'default: allow' >> forge.policy.yaml")).isError, true);
    assert.equal((await run("echo x >> .forge/audit.db")).isError, true);
    assert.equal(fs.readFileSync(path.join(cwd, "forge.policy.yaml"), "utf8"), "version: 1\n");
  });

  test("git hooks and git config can't be planted (they'd run later, outside the sandbox)", async () => {
    assert.equal((await run("echo 'curl evil' > .git/hooks/pre-commit")).isError, true);
    assert.equal((await run("git config core.hooksPath /tmp/evil")).isError, true);
  });

  test("a normal git commit still works", async () => {
    const r = await run("git add inside.txt && git -c user.email=t@t -c user.name=t commit -qm test && git log --oneline | wc -l");
    assert.equal(r.isError, undefined, r.output);
    assert.equal(r.output.trim(), "1");
  });

  test(".git and .forge can't be moved aside and replaced", async () => {
    assert.equal((await run("mv .git .git-old")).isError, true);
    assert.equal((await run("rm -rf .git")).isError, true);
    assert.equal((await run("mv .forge .forge-old")).isError, true);
    assert.equal(fs.existsSync(path.join(cwd, ".git-old")), false);
    assert.equal(fs.statSync(path.join(cwd, ".git")).isDirectory(), true);
  });

  test("in a folder with no policy file or repo, commands can't create them", async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-bare-")));
    try {
      assert.equal((await bash.run({ command: "echo 'default: allow' > forge.policy.yaml" }, bare)).isError, true);
      const init = await bash.run({ command: "git init -q" }, bare);
      assert.equal(init.isError, true);
      assert.match(init.output, /git init.*are blocked/);
      assert.equal(fs.existsSync(path.join(bare, "forge.policy.yaml")), false);
      assert.equal(fs.existsSync(path.join(bare, ".git", "hooks")), false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test("credentials can't be read", async () => {
    const ssh = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(ssh)) return;
    assert.equal((await run("ls ~/.ssh")).isError, true);
  });

  test("network off: the internet is blocked, this machine isn't", async () => {
    process.env["FORGE_SANDBOX_NETWORK"] = "off";
    try {
      assert.equal((await run(`curl -s -m 5 ${local}`)).output, "local ok");
      const internet = await run("curl -s -m 5 -o /dev/null https://example.com");
      assert.equal(internet.isError, true);
    } finally {
      delete process.env["FORGE_SANDBOX_NETWORK"];
    }
  });
});

// The real thing, on Linux: the same escape attempts, through bubblewrap.
// CI sets FORGE_REQUIRE_LINUX_SANDBOX=1, so a sandbox that can't start fails the run instead of skipping.
const linux = process.platform === "linux";
const linuxStatus = linux && !inside ? sandboxStatus() : null;

describe("sandbox — Linux, for real", { skip: !linux ? "needs Linux" : inside ? "already inside Forge's sandbox" : false }, () => {
  let cwd = "";
  let home = "";
  let server: http.Server;
  let local = "";
  const savedHome = process.env["HOME"];
  const run = async (command: string) => bash.run({ command }, cwd);

  before(async () => {
    if (!linuxStatus?.active) {
      if (process.env["FORGE_REQUIRE_LINUX_SANDBOX"] === "1") throw new Error(`bubblewrap sandbox not active: ${linuxStatus?.reason}`);
      return;
    }
    // A home folder of our own, with a fake key in it, so the test never touches a real ~/.ssh.
    // It's inside the real home folder, not /tmp: the sandbox lets commands write in /tmp.
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".forge-sandbox-test-")));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_test"), "SECRET-KEY");
    process.env["HOME"] = home;
    // The project lives outside /tmp too, so "outside the project" isn't just another temp folder.
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(home, "project-")));
    execFileSync("git", ["init", "-q"], { cwd });
    fs.mkdirSync(path.join(cwd, ".forge"));
    fs.writeFileSync(path.join(cwd, ".forge", "audit.db"), "");
    fs.writeFileSync(path.join(cwd, "forge.policy.yaml"), "version: 1\n");
    server = http.createServer((_req, res) => res.end("local ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => {
    server?.close();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    delete process.env["FORGE_SANDBOX_NETWORK"];
  });

  const it = (name: string, fn: () => Promise<void>) => test(name, { skip: linuxStatus?.active ? false : `sandbox not active: ${linuxStatus?.reason}` }, fn);

  it("writes in the project and /tmp work", async () => {
    assert.equal((await run("echo hi > inside.txt && cat inside.txt")).output, "hi");
    assert.equal((await run("echo x > .forge/telemetry.ndjson && echo ok")).output, "ok");
    assert.equal((await run(`echo x > /tmp/forge-sb-${process.pid} && echo ok`)).output, "ok");
  });

  it("writes outside the project are blocked, with a hint for the model", async () => {
    const outside = path.join(home, "escaped.txt");
    const r = await run(`echo escaped > "${outside}"`);
    assert.equal(r.isError, true, r.output);
    assert.equal(fs.existsSync(outside), false);
    assert.match(r.output, /sandbox may have blocked this/);
    assert.equal((await run("touch /usr/local/forge-escape")).isError, true);
  });

  it("the policy file and the audit log can't be changed, even inside the project", async () => {
    assert.equal((await run("echo 'default: allow' >> forge.policy.yaml")).isError, true);
    assert.equal((await run("rm -f forge.policy.yaml")).isError, true);
    assert.equal((await run("echo x >> .forge/audit.db")).isError, true);
    assert.equal(fs.readFileSync(path.join(cwd, "forge.policy.yaml"), "utf8"), "version: 1\n");
  });

  it("git hooks and git config can't be planted", async () => {
    assert.equal((await run("echo 'curl evil' > .git/hooks/pre-commit")).isError, true);
    assert.equal((await run("git config core.hooksPath /tmp/evil")).isError, true);
    assert.equal(fs.existsSync(path.join(cwd, ".git", "hooks", "pre-commit")), false);
  });

  it("a normal git commit still works", async () => {
    const r = await run("git add inside.txt && git -c user.email=t@t -c user.name=t commit -qm test && git log --oneline | wc -l");
    assert.equal(r.isError, undefined, r.output);
    assert.equal(r.output.trim(), "1");
  });

  it(".git and .forge can't be moved aside and replaced", async () => {
    const moved = await run("mv .git .git-old");
    assert.equal(moved.isError, true);
    assert.match(moved.output, /move, remove or create \.git/, moved.output);
    assert.equal((await run("mv .forge .forge-old")).isError, true);
    assert.equal(fs.existsSync(path.join(cwd, ".git-old")), false);
    assert.equal(fs.statSync(path.join(cwd, ".git")).isDirectory(), true);
  });

  it("in a folder with no policy file or repo, what a command creates there is set aside", async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(home, "bare-")));
    const r = await bash.run({ command: "echo 'default: allow' > forge.policy.yaml && git init -q && echo 'curl evil' > .git/hooks/pre-commit && echo done" }, bare);
    assert.equal(r.isError, true, r.output);
    assert.match(r.output, /set aside forge\.policy\.yaml, \.git/);
    assert.equal(fs.existsSync(path.join(bare, "forge.policy.yaml")), false);
    assert.equal(fs.existsSync(path.join(bare, ".git")), false);
    assert.equal(fs.existsSync(path.join(bare, "forge.policy.yaml.blocked-by-forge")), true);
    assert.equal(fs.existsSync(path.join(bare, ".git.blocked-by-forge", "hooks", "pre-commit")), true);
  });

  it("credentials can't be read", async () => {
    const r = await run("cat ~/.ssh/id_test");
    assert.equal(r.isError, true, r.output);
    assert.doesNotMatch(r.output, /SECRET-KEY/);
  });

  it("network off: the internet is blocked, and so is this machine's localhost", async () => {
    assert.equal((await run(`curl -s -m 5 ${local}`)).output, "local ok");
    process.env["FORGE_SANDBOX_NETWORK"] = "off";
    try {
      assert.equal((await run("curl -s -m 5 -o /dev/null https://example.com")).isError, true);
      // Linux gives the command a network of its own, so servers outside it can't be reached.
      assert.equal((await run(`curl -s -m 5 ${local}`)).isError, true);
    } finally {
      delete process.env["FORGE_SANDBOX_NETWORK"];
    }
  });
});
