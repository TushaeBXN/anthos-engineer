import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, policyPath } from "../policy/check.js";
import type { ForgePolicy } from "../policy/schema.js";

const WHO = { agentId: "test", sessionId: "s1" };

const POLICY: ForgePolicy = {
  version: 1,
  default: "deny",
  rules: [
    { id: "deny-ssh", resource: "filesystem", operation: "write", target: "~/.ssh/**", effect: "deny" },
    { id: "allow-reads", resource: "filesystem", operation: "read", target: "**", effect: "allow" },
    { id: "allow-src", resource: "filesystem", operation: "write", target: "src/**", effect: "allow" },
    { id: "allow-test", resource: "shell", operation: "npm test", target: "*", effect: "allow" },
    { id: "deny-force", resource: "git", operation: "force-push", target: "**", effect: "deny" },
    { id: "deny-main", resource: "git", operation: "push", target: "main", effect: "deny" },
    { id: "ask-commit", resource: "git", operation: "commit", target: "**", effect: "allow", requiresApproval: true },
    { id: "allow-status", resource: "git", operation: "status", target: "**", effect: "allow" },
  ],
};

function project(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-check-")));
}

describe("check — files", () => {
  const cwd = project();

  test("write inside src → allow", () => {
    assert.equal(check({ kind: "write", path: "src/a.ts" }, POLICY, WHO, cwd).decision, "allow");
  });

  test("write with no matching rule → ask, not deny", () => {
    assert.equal(check({ kind: "write", path: "docs/a.md" }, POLICY, WHO, cwd).decision, "ask");
  });

  test("write to ~/.ssh → deny, however the path is spelled", () => {
    const ssh = path.join(os.homedir(), ".ssh", "authorized_keys");
    assert.equal(check({ kind: "write", path: "~/.ssh/authorized_keys" }, POLICY, WHO, cwd).decision, "deny");
    assert.equal(check({ kind: "write", path: ssh }, POLICY, WHO, cwd).decision, "deny");
    assert.equal(check({ kind: "write", path: path.relative(cwd, ssh) }, POLICY, WHO, cwd).decision, "deny");
  });

  test("src/../ escape is not treated as inside src", () => {
    assert.equal(check({ kind: "write", path: "src/../../outside.ts" }, POLICY, WHO, cwd).decision, "ask");
  });

  test("a symlink inside the project that points outside is treated as outside", () => {
    const outside = project();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, "src", "link"));
    assert.equal(policyPath("src/link/x.ts", cwd), path.join(outside, "x.ts"));
    assert.equal(check({ kind: "write", path: "src/link/x.ts" }, POLICY, WHO, cwd).decision, "ask");
  });

  test("the policy file, .forge and .git are never writable", () => {
    for (const p of ["forge.policy.yaml", ".forge/audit.db", ".git/config"]) {
      assert.equal(check({ kind: "write", path: p }, POLICY, WHO, cwd).decision, "deny", p);
    }
  });

  test("reads are allowed by the read rule", () => {
    assert.equal(check({ kind: "read", path: "." }, POLICY, WHO, cwd).decision, "allow");
  });

  test("no access → allow", () => {
    assert.equal(check({ kind: "none" }, POLICY, WHO, cwd).decision, "allow");
  });
});

describe("check — shell", () => {
  const run = (command: string) => check({ kind: "shell", command }, POLICY, WHO).decision;

  test("an allowed command, with or without extra arguments → allow", () => {
    assert.equal(run("npm test"), "allow");
    assert.equal(run("npm test -- --watch"), "allow");
  });

  test("a command with no rule → ask", () => {
    assert.equal(run("ls -la"), "ask");
    assert.equal(run("npm testing"), "ask");
  });

  test("an allowed command chained with an unknown one → ask", () => {
    assert.equal(run("npm test && rm -rf build"), "ask");
  });

  test("redirection, substitution and background jobs → ask even on an allowed command", () => {
    assert.equal(run("npm test > out.txt"), "ask");
    assert.equal(run("npm test $(cat x)"), "ask");
    assert.equal(run("npm test &"), "ask");
    assert.equal(run("npm test & rm -rf build"), "ask");
  });

  test("allowed commands chained with && → allow (&& is not a background job)", () => {
    assert.equal(run("npm test && git status"), "allow");
    assert.equal(run("npm test&&npm test"), "allow");
  });

  test("git push to main → deny, alone or hidden in a chain", () => {
    assert.equal(run("git push origin main"), "deny");
    assert.equal(run("npm test && git push origin main"), "deny");
  });

  test("force push → deny", () => {
    assert.equal(run("git push --force origin feature"), "deny");
    assert.equal(run("git push -f"), "deny");
  });

  test("git push to another branch → ask", () => {
    assert.equal(run("git push origin feature"), "ask");
  });

  test("git commit requires approval → ask; git status → allow", () => {
    assert.equal(run("git commit -m wip"), "ask");
    assert.equal(run("git status"), "allow");
  });

  test("every decision is returned for the audit log", () => {
    const verdict = check({ kind: "shell", command: "git push origin main" }, POLICY, WHO);
    assert.ok(verdict.records.some((r) => r.matchedRuleId === "deny-main"));
  });
});

describe("check — default allow policy", () => {
  test("unmatched actions are allowed when the policy default is allow", () => {
    const open: ForgePolicy = { version: 1, default: "allow", rules: [] };
    assert.equal(check({ kind: "shell", command: "ls" }, open, WHO).decision, "allow");
  });
});
