import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, policyPath, type Access } from "../policy/check.js";
import { loadPolicy } from "../policy/parser.js";
import { PRESETS, preset } from "../policy/presets.js";
import { runDoctor } from "../agent/doctor.js";
import { verify } from "../tools/project.js";
import { runVerificationChain } from "../verify/chain.js";

const WHO = { agentId: "test", sessionId: "s1" };
const home = os.homedir();

/** Load a preset the way Forge does: from forge.policy.yaml in a project folder. */
function project(name: string): { cwd: string; decide: (a: Access) => string } {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-preset-")));
  fs.writeFileSync(path.join(cwd, "forge.policy.yaml"), preset(name)!.yaml);
  const policy = loadPolicy(path.join(cwd, "forge.policy.yaml"));
  return { cwd, decide: (a) => check(a, policy, WHO, cwd).decision };
}

const read = (p: string): Access => ({ kind: "read", path: p });
const write = (p: string): Access => ({ kind: "write", path: p });
const shell = (command: string): Access => ({ kind: "shell", command });
const fetch = (host: string): Access => ({ kind: "network", operation: "fetch", target: host });
const mcp: Access = { kind: "mcp", server: "xcode", tool: "BuildProject", readOnly: false };

/** Every action, and what each preset should decide. */
const MATRIX: [string, Access, { "read-only": string; "workspace-write": string; "full-access": string }][] = [
  ["read a project file", read("src/a.ts"), { "read-only": "allow", "workspace-write": "allow", "full-access": "allow" }],
  ["search the project (glob/grep)", read("."), { "read-only": "allow", "workspace-write": "allow", "full-access": "allow" }],
  ["read .env", read(".env"), { "read-only": "ask", "workspace-write": "ask", "full-access": "allow" }],
  ["read config/.env.local", read("config/.env.local"), { "read-only": "ask", "workspace-write": "ask", "full-access": "allow" }],
  ["read a file outside the project", read("/etc/hosts"), { "read-only": "ask", "workspace-write": "ask", "full-access": "allow" }],
  ["read an SSH key", read("~/.ssh/id_ed25519"), { "read-only": "deny", "workspace-write": "deny", "full-access": "deny" }],
  ["read AWS credentials by absolute path", read(path.join(home, ".aws", "credentials")), { "read-only": "deny", "workspace-write": "deny", "full-access": "deny" }],
  ["write a project file", write("src/a.ts"), { "read-only": "deny", "workspace-write": "allow", "full-access": "allow" }],
  ["write outside the project", write("/tmp/forge-x.txt"), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["write ~/.ssh/authorized_keys", write("~/.ssh/authorized_keys"), { "read-only": "deny", "workspace-write": "deny", "full-access": "deny" }],
  ["write the policy file itself", write("forge.policy.yaml"), { "read-only": "deny", "workspace-write": "deny", "full-access": "deny" }],
  ["git status", shell("git status"), { "read-only": "allow", "workspace-write": "allow", "full-access": "allow" }],
  ["git diff then git log", shell("git diff && git log --oneline"), { "read-only": "allow", "workspace-write": "allow", "full-access": "allow" }],
  ["git add", shell("git add src/a.ts"), { "read-only": "deny", "workspace-write": "allow", "full-access": "allow" }],
  ["git commit", shell("git commit -m x"), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["git push to a branch", shell("git push origin feature"), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["git push to main", shell("git push origin main"), { "read-only": "deny", "workspace-write": "deny", "full-access": "allow" }],
  ["git force-push", shell("git push --force origin feature"), { "read-only": "deny", "workspace-write": "deny", "full-access": "deny" }],
  ["npm test", shell("npm test"), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["rm -rf", shell("rm -rf build"), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["git status, then something else", shell("git status && curl example.com"), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["verify (type check, tests, lint)", verify.access({}), { "read-only": "deny", "workspace-write": "ask", "full-access": "allow" }],
  ["web fetch", fetch("example.com"), { "read-only": "ask", "workspace-write": "ask", "full-access": "allow" }],
  ["an MCP tool", mcp, { "read-only": "ask", "workspace-write": "ask", "full-access": "allow" }],
];

for (const p of PRESETS) {
  describe(`preset: ${p.name}`, () => {
    const { decide } = project(p.name);
    for (const [what, access, expected] of MATRIX) {
      const want = expected[p.name as keyof typeof expected];
      test(`${what} → ${want}`, () => assert.equal(decide(access), want));
    }
  });
}

describe("presets", () => {
  test("there are exactly these three, each with a summary", () => {
    assert.deepEqual(PRESETS.map((p) => p.name), ["read-only", "workspace-write", "full-access"]);
    for (const p of PRESETS) assert.ok(p.summary.length > 20);
  });

  test("forge doctor finds nothing wrong with any of them", async () => {
    for (const p of PRESETS) {
      const { cwd } = project(p.name);
      const checks = await runDoctor({ cwd, env: { FORGE_PROVIDER: "lmstudio", FORGE_MODEL: "x", FORGE_BASE_URL: "http://127.0.0.1:9/v1" }, mcp: false, engramUrl: "http://127.0.0.1:9" });
      assert.equal(checks.find((c) => c.name === "Policy")!.state, "ok", p.name);
    }
  });

  test("verify runs no type checker without a tsconfig.json, so npx never downloads one", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-"));
    const tsc = (await runVerificationChain(cwd)).stages.find((s) => s.stage === "tsc")!;
    assert.equal(tsc.skipped, true);
    assert.match(tsc.skipReason!, /tsconfig/);
  });

  test("the project folder itself is '.', not an absolute path that looks outside", () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-root-")));
    assert.equal(policyPath(".", cwd), ".");
    assert.equal(policyPath(cwd, cwd), ".");
  });
});
