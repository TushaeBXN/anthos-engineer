import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clearAllCapabilities } from "../capability/issuer.js";
import {
  currentBranch,
  diffHash,
  createBranch,
  stageFiles,
  commit,
  push,
  gitStatus,
} from "../executor/git.js";
import type { VerifyGate } from "../verify/chain.js";

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@forge.local"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd: dir });
  // Initial commit so HEAD exists
  await fs.writeFile(path.join(dir, "README.md"), "# test", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

async function passingGate(cwd: string): Promise<VerifyGate> {
  const { createHash } = await import("node:crypto");
  const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd });
  return {
    passed: true,
    diffHash: createHash("sha256").update(stdout).digest("hex"),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-git-test-"));
  await initRepo(tmpDir);
  // forge.policy.yaml must be on disk; load from the real project root.
  // The executor calls loadPolicy() which reads from process.cwd().
  // We copy the real policy so tests match production rules.
  const projectRoot = path.resolve(new URL(import.meta.url).pathname, "../..");
  const policyPath = path.join(projectRoot, "forge.policy.yaml");
  try {
    await fs.copyFile(policyPath, path.join(tmpDir, "forge.policy.yaml"));
  } catch {
    // If running without the file (CI), write a permissive test policy.
    await fs.writeFile(
      path.join(tmpDir, "forge.policy.yaml"),
      [
        "version: 1",
        "default: deny",
        "rules:",
        "  - id: deny-force-push",
        "    resource: git",
        "    operation: force-push",
        "    target: '**'",
        "    effect: deny",
        "  - id: deny-push-main",
        "    resource: git",
        "    operation: push",
        "    target: main",
        "    effect: deny",
        "  - id: allow-git-push",
        "    resource: git",
        "    operation: push",
        "    target: 'forge/**'",
        "    effect: allow",
        "    requires_approval: true",
        "  - id: allow-git-commit",
        "    resource: git",
        "    operation: commit",
        "    target: '**'",
        "    effect: allow",
        "    requires_approval: true",
        "  - id: allow-git-add",
        "    resource: git",
        "    operation: add",
        "    target: '**'",
        "    effect: allow",
        "  - id: allow-git-branch",
        "    resource: git",
        "    operation: branch",
        "    target: 'forge/**'",
        "    effect: allow",
        "  - id: allow-git-status",
        "    resource: git",
        "    operation: status",
        "    target: '**'",
        "    effect: allow",
        "  - id: allow-git-diff",
        "    resource: git",
        "    operation: diff",
        "    target: '**'",
        "    effect: allow",
        "  - id: allow-git-rev-parse",
        "    resource: git",
        "    operation: rev-parse",
        "    target: '**'",
        "    effect: allow",
      ].join("\n"),
      "utf8",
    );
  }
  process.chdir(tmpDir);
});

after(async () => {
  clearAllCapabilities();
  process.chdir(os.homedir());
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearAllCapabilities();
});

// ── currentBranch ─────────────────────────────────────────────────────────────

describe("currentBranch", () => {
  test("returns the active branch name", async () => {
    const branch = await currentBranch(tmpDir);
    assert.equal(branch, "main");
  });
});

// ── diffHash ──────────────────────────────────────────────────────────────────

describe("diffHash", () => {
  test("returns a 64-char hex string", async () => {
    const hash = await diffHash(tmpDir);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test("changes when the working tree changes", async () => {
    const before = await diffHash(tmpDir);
    await fs.writeFile(path.join(tmpDir, "probe.ts"), "// probe", "utf8");
    const after = await diffHash(tmpDir);
    assert.notEqual(before, after);
    // Clean up
    await fs.rm(path.join(tmpDir, "probe.ts"), { force: true });
  });
});

// ── gitStatus ─────────────────────────────────────────────────────────────────

describe("gitStatus — read-only, goes through policy broker", () => {
  test("returns success on a clean working tree", async () => {
    const result = await gitStatus("agent-1", "session-1", tmpDir);
    assert.equal(result.success, true);
  });

  test("stdout is empty on a clean working tree", async () => {
    const result = await gitStatus("agent-1", "session-1", tmpDir);
    assert.equal(result.stdout.trim(), "");
  });

  test("stdout reflects an untracked file", async () => {
    const probe = path.join(tmpDir, "untracked.ts");
    await fs.writeFile(probe, "// new", "utf8");
    try {
      const result = await gitStatus("agent-1", "session-1", tmpDir);
      assert.equal(result.success, true);
      assert.ok(result.stdout.includes("untracked.ts"), result.stdout);
    } finally {
      await fs.rm(probe, { force: true });
    }
  });
});

// ── createBranch ──────────────────────────────────────────────────────────────

describe("createBranch", () => {
  test("creates a valid forge/* branch", async () => {
    const result = await createBranch("test-feature", "agent-1", "session-1", tmpDir);
    assert.equal(result.success, true);
    const branch = await currentBranch(tmpDir);
    assert.equal(branch, "forge/test-feature");
    // Return to main for subsequent tests
    await git(["checkout", "main"], tmpDir);
  });

  test("rejects a slug that doesn't produce a forge/* name", async () => {
    // An empty slug produces "forge/" which fails the regex
    const result = await createBranch("", "agent-1", "session-1", tmpDir);
    assert.equal(result.success, false);
    assert.equal(result.error, "INVALID_BRANCH");
  });

  test("rejects uppercase characters in slug", async () => {
    const result = await createBranch("MyFeature", "agent-1", "session-1", tmpDir);
    assert.equal(result.success, false);
    assert.equal(result.error, "INVALID_BRANCH");
  });

  test("rejects slugs with spaces", async () => {
    const result = await createBranch("add feature", "agent-1", "session-1", tmpDir);
    assert.equal(result.success, false);
    assert.equal(result.error, "INVALID_BRANCH");
  });
});

// ── stageFiles ────────────────────────────────────────────────────────────────

describe("stageFiles", () => {
  test("stages an existing file successfully", async () => {
    const file = path.join(tmpDir, "staged.ts");
    await fs.writeFile(file, "// staged", "utf8");
    const result = await stageFiles(["staged.ts"], "agent-1", "session-1", tmpDir);
    assert.equal(result.success, true);
    // Unstage to keep repo clean
    await git(["restore", "--staged", "staged.ts"], tmpDir);
    await fs.rm(file, { force: true });
  });

  test("rejects an empty paths array", async () => {
    const result = await stageFiles([], "agent-1", "session-1", tmpDir);
    assert.equal(result.success, false);
    assert.equal(result.error, "EMPTY_PATHS");
  });
});

// ── commit ────────────────────────────────────────────────────────────────────

describe("commit — protected branch guard", () => {
  test("refuses to commit on main", async () => {
    const branch = await currentBranch(tmpDir);
    assert.equal(branch, "main", "Precondition: must be on main");

    const gate = await passingGate(tmpDir);
    const result = await commit(
      "should not land",
      ["README.md"],
      gate,
      "agent-1",
      "session-1",
      tmpDir,
    );
    assert.equal(result.success, false);
    assert.equal(result.error, "PROTECTED_BRANCH");
  });
});

describe("commit — verification gate", () => {
  before(async () => {
    // Move to a forge branch for commit tests
    await git(["checkout", "-b", "forge/commit-tests"], tmpDir);
  });

  after(async () => {
    await git(["checkout", "main"], tmpDir);
    await git(["branch", "-D", "forge/commit-tests"], tmpDir);
  });

  test("refuses to commit when gate.passed is false", async () => {
    const failedGate: VerifyGate = { passed: false, diffHash: "x" };
    const result = await commit(
      "bad commit",
      ["README.md"],
      failedGate,
      "agent-1",
      "session-1",
      tmpDir,
    );
    assert.equal(result.success, false);
    assert.equal(result.error, "VERIFICATION_FAILED");
  });

  test("refuses to commit when working tree changed after gate was recorded", async () => {
    // Record a gate on the clean tree
    const gate = await passingGate(tmpDir);

    // Modify the tree after capturing the gate
    await fs.writeFile(path.join(tmpDir, "post-gate.ts"), "// added after gate", "utf8");

    try {
      const result = await commit(
        "stale gate",
        ["post-gate.ts"],
        gate,
        "agent-1",
        "session-1",
        tmpDir,
      );
      assert.equal(result.success, false);
      assert.equal(result.error, "STALE_GATE");
    } finally {
      await fs.rm(path.join(tmpDir, "post-gate.ts"), { force: true });
    }
  });

  test("commits successfully on a forge branch with a passing gate", async () => {
    // Write a file and capture the gate while it is staged in the diff
    const file = path.join(tmpDir, "new-feature.ts");
    await fs.writeFile(file, "export const x = 1;", "utf8");
    const gate = await passingGate(tmpDir);

    const result = await commit(
      "add new-feature",
      ["new-feature.ts"],
      gate,
      "agent-1",
      "session-1",
      tmpDir,
    );
    assert.equal(result.success, true, result.stderr);

    // Confirm the commit landed
    const log = await git(["log", "--oneline", "-1"], tmpDir);
    assert.ok(log.includes("add new-feature"), log);
  });
});

// ── push ─────────────────────────────────────────────────────────────────────

describe("push — approval guard", () => {
  test("refuses to push without approval", async () => {
    const result = await push(false, "agent-1", "session-1", tmpDir);
    assert.equal(result.success, false);
    assert.equal(result.error, "APPROVAL_REQUIRED");
  });
});

describe("push — protected branch guard", () => {
  test("refuses to push main even with approval", async () => {
    const branch = await currentBranch(tmpDir);
    assert.equal(branch, "main", "Precondition: must be on main");

    const result = await push(true, "agent-1", "session-1", tmpDir);
    assert.equal(result.success, false);
    assert.equal(result.error, "PROTECTED_BRANCH");
  });

  test("refuses to push a non-forge branch even with approval", async () => {
    await git(["checkout", "-b", "feature/not-a-forge-branch"], tmpDir);
    try {
      const result = await push(true, "agent-1", "session-1", tmpDir);
      assert.equal(result.success, false);
      assert.equal(result.error, "PROTECTED_BRANCH");
    } finally {
      await git(["checkout", "main"], tmpDir);
      await git(["branch", "-D", "feature/not-a-forge-branch"], tmpDir);
    }
  });
});
