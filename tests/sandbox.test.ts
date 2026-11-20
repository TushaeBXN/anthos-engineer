import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { sandboxStatus, sandboxed, sandboxHint } from "../agent/sandbox.js";
import { bash } from "../tools/bash.js";

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
    assert.equal(sandboxStatus(env({}), "darwin").network, true);
    assert.equal(sandboxStatus(env({ FORGE_SANDBOX_NETWORK: "off" }), "darwin").network, false);
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

  test("a hint is added only when the sandbox may be why a command failed", () => {
    const on = { mode: "auto" as const, active: true, kind: "seatbelt" as const, network: true };
    assert.match(sandboxHint("touch: /x: Operation not permitted", on), /sandbox may have blocked this/);
    assert.equal(sandboxHint("Error: tests failed", on), "");
    assert.equal(sandboxHint("Operation not permitted", { ...on, active: false }), "");
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
