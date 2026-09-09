import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runVerificationChain } from "../verify/chain.js";

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const REAL_TSC = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsc");

// ── Setup: minimal TS project in a temp dir ───────────────────────────────────

let tmpDir: string;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
  },
  include: ["**/*.ts"],
  exclude: ["node_modules"],
});

const VALID_TS = `
export function add(a: number, b: number): number {
  return a + b;
}
`;

// Type error: assigning a string to a number parameter
const BROKEN_TS = `
export function add(a: number, b: number): number {
  return a + b;
}

const result: number = add("not a number", 2);
`;

async function setupTscSymlink(dir: string): Promise<void> {
  const binDir = path.join(dir, "node_modules", ".bin");
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(REAL_TSC, path.join(binDir, "tsc")).catch(() => { /* already exists */ });
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-verify-"));
  await fs.writeFile(path.join(tmpDir, "tsconfig.json"), TSCONFIG, "utf8");
  await setupTscSymlink(tmpDir);
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("verification chain — tsc stage", () => {
  test("valid TypeScript passes tsc", async () => {
    await fs.writeFile(path.join(tmpDir, "index.ts"), VALID_TS, "utf8");

    const result = await runVerificationChain(tmpDir);
    const tsc = result.stages.find((s) => s.stage === "tsc")!;

    assert.equal(tsc.skipped, false, "tsc stage should not be skipped");
    assert.equal(tsc.passed, true, `tsc should pass — stderr: ${tsc.stderr}`);
  });

  test("type error is caught and reported before change is accepted", async () => {
    // Deliberately broken change — this is the Step 4 checkpoint
    await fs.writeFile(path.join(tmpDir, "index.ts"), BROKEN_TS, "utf8");

    const result = await runVerificationChain(tmpDir);
    const tsc = result.stages.find((s) => s.stage === "tsc")!;

    assert.equal(tsc.skipped, false, "tsc stage should not be skipped");
    assert.equal(tsc.passed, false, "tsc should fail on a type error");
    assert.ok(
      tsc.stderr.includes("error TS") || tsc.stdout.includes("error TS"),
      `Expected a TS error in output — got: ${tsc.stderr}${tsc.stdout}`,
    );
    assert.equal(
      result.passed,
      false,
      "chain should be failed when tsc fails",
    );
  });
});

describe("verification chain — all stages run even after a failure", () => {
  test("chain continues to test/lint stages even when tsc fails", async () => {
    await fs.writeFile(path.join(tmpDir, "index.ts"), BROKEN_TS, "utf8");

    const result = await runVerificationChain(tmpDir);

    // All three stages should be present
    assert.ok(result.stages.find((s) => s.stage === "tsc"), "tsc stage missing");
    assert.ok(result.stages.find((s) => s.stage === "test"), "test stage missing");
    assert.ok(result.stages.find((s) => s.stage === "lint"), "lint stage missing");
  });
});

describe("verification chain — missing package.json", () => {
  test("test stage is skipped when no package.json", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "forge-bare-"));
    try {
      await fs.writeFile(path.join(bare, "tsconfig.json"), TSCONFIG, "utf8");
      await fs.writeFile(path.join(bare, "index.ts"), VALID_TS, "utf8");
      await setupTscSymlink(bare);

      const result = await runVerificationChain(bare);
      const testStage = result.stages.find((s) => s.stage === "test")!;

      assert.equal(testStage.skipped, true);
      assert.match(testStage.skipReason ?? "", /package\.json/);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});

describe("verification chain — lint skipped when no ESLint config", () => {
  test("lint stage skipped when no ESLint config present", async () => {
    await fs.writeFile(path.join(tmpDir, "index.ts"), VALID_TS, "utf8");

    const result = await runVerificationChain(tmpDir);
    const lint = result.stages.find((s) => s.stage === "lint")!;

    assert.equal(lint.skipped, true);
    assert.match(lint.skipReason ?? "", /ESLint/);
  });
});
