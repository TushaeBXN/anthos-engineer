import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { issueCapability, issueExpiredCapability, clearAllCapabilities } from "../capability/issuer.js";
import { writeFile, readFile } from "../executor/filesystem.js";
import type { PolicyDecisionRecord } from "../policy/schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-test-"));
  // Executor resolves paths relative to cwd. Override cwd to tmpDir for tests.
  process.chdir(tmpDir);
});

after(async () => {
  clearAllCapabilities();
  process.chdir(os.homedir());
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function allowRecord(operation: "read" | "write", target: string): PolicyDecisionRecord {
  return {
    request: {
      resource: "filesystem",
      operation,
      target,
      agentId: "test-agent",
      sessionId: "test-session",
    },
    decision: "allow",
    matchedRuleId: "test-rule",
    reason: "Test",
    timestamp: new Date().toISOString(),
  };
}

// ── Filesystem executor ───────────────────────────────────────────────────────

describe("filesystem executor — valid capability", () => {
  test("write inside granted glob succeeds", async () => {
    const cap = issueCapability(allowRecord("write", "src/**"));
    const result = await writeFile(cap.id, "src/hello.ts", "export const x = 1;");
    assert.equal(result.success, true);
    const written = await fs.readFile(path.join(tmpDir, "src/hello.ts"), "utf8");
    assert.equal(written, "export const x = 1;");
  });

  test("read inside granted glob succeeds", async () => {
    // Write directly so we can read it back
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/data.ts"), "const y = 2;", "utf8");

    const cap = issueCapability(allowRecord("read", "src/**"));
    const result = await readFile(cap.id, "src/data.ts");
    assert.equal(result.success, true);
    assert.equal(result.content, "const y = 2;");
  });
});

describe("filesystem executor — path outside granted glob", () => {
  test("write to lib/ with src/** capability → fails", async () => {
    const cap = issueCapability(allowRecord("write", "src/**"));
    const result = await writeFile(cap.id, "lib/util.ts", "// nope");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("outside the granted glob"), result.error);
  });

  test("file is NOT written to disk on rejection", async () => {
    const cap = issueCapability(allowRecord("write", "src/**"));
    await writeFile(cap.id, "lib/should-not-exist.ts", "// never");
    await assert.rejects(
      fs.access(path.join(tmpDir, "lib/should-not-exist.ts")),
      "File should not exist on disk after rejected write",
    );
  });
});

describe("filesystem executor — expired capability", () => {
  test("write with expired capability → fails", async () => {
    const cap = issueExpiredCapability(allowRecord("write", "src/**"));
    const result = await writeFile(cap.id, "src/expired.ts", "// expired");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("expired"), result.error);
  });

  test("file is NOT written to disk on expiry", async () => {
    const cap = issueExpiredCapability(allowRecord("write", "src/**"));
    await writeFile(cap.id, "src/ghost.ts", "// ghost");
    await assert.rejects(
      fs.access(path.join(tmpDir, "src/ghost.ts")),
      "File should not exist after expired write",
    );
  });
});

describe("filesystem executor — unknown capability id", () => {
  test("bogus capabilityId → fails with NOT_FOUND", async () => {
    const result = await writeFile("no-such-id", "src/x.ts", "// x");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("not found"), result.error);
  });
});

describe("filesystem executor — operation mismatch", () => {
  test("using a read capability to write → fails", async () => {
    const cap = issueCapability(allowRecord("read", "src/**"));
    const result = await writeFile(cap.id, "src/mismatch.ts", "// mismatch");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("not 'write'"), result.error);
  });
});
