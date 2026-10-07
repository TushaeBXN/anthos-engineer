/**
 * Verification chain — runs after every agent-executed change.
 * Stages: tsc --noEmit → test runner → linter (if configured).
 * All stages run even if an earlier one fails, so you get the full picture.
 * This is a platform component, not an agent; it may use execFile directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type StageName = "tsc" | "test" | "lint";

export interface StageResult {
  stage: StageName;
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
}

export interface ChainResult {
  passed: boolean; // true only when every non-skipped stage passed
  stages: StageResult[];
  /** SHA-256 of `git diff HEAD` at the moment verification completed.
   *  The git executor compares this against the working tree before committing
   *  to detect changes made after verification passed. */
  diffHash: string;
}

/** Returned by runVerificationChain; passed into executor/git.ts commit(). */
export type VerifyGate = Pick<ChainResult, "passed" | "diffHash">;

async function runStage(
  stage: StageName,
  binary: string,
  args: string[],
  cwd: string,
): Promise<StageResult> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      timeout: 120_000,
    });
    return { stage, passed: true, stdout, stderr, durationMs: Date.now() - start, skipped: false };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return {
      stage,
      passed: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      durationMs: Date.now() - start,
      skipped: false,
    };
  }
}

function skip(stage: StageName, reason: string): StageResult {
  return { stage, passed: true, stdout: "", stderr: "", durationMs: 0, skipped: true, skipReason: reason };
}

export async function runVerificationChain(cwd = process.cwd()): Promise<ChainResult> {
  const stages: StageResult[] = [];

  // Stage 1 — type check
  // Prefer the project-local tsc so the chain works in directories that have
  // typescript installed but no global tsc (e.g. test temp dirs with a symlink).
  const localTsc = path.join(cwd, "node_modules", ".bin", "tsc");
  const [tscBin, tscArgs]: [string, string[]] = fs.existsSync(localTsc)
    ? [localTsc, ["--noEmit"]]
    : ["npx", ["tsc", "--noEmit"]];
  stages.push(await runStage("tsc", tscBin, tscArgs, cwd));

  // Stage 2 — test runner (read test script from package.json)
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.test) {
      stages.push(await runStage("test", "npm", ["test"], cwd));
    } else {
      stages.push(skip("test", "No test script in package.json"));
    }
  } else {
    stages.push(skip("test", "No package.json found"));
  }

  // Stage 3 — lint (only if a config exists)
  const eslintConfigs = [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
  ];
  const hasEslint = eslintConfigs.some((f) => fs.existsSync(path.join(cwd, f)));
  if (hasEslint) {
    stages.push(
      await runStage("lint", "npx", ["eslint", ".", "--ext", ".ts,tsx"], cwd),
    );
  } else {
    stages.push(skip("lint", "No ESLint config found"));
  }

  const passed = stages.filter((s) => !s.skipped).every((s) => s.passed);

  // Record the diff state at the moment verification completes so commits
  // can reject a stale gate (something changed after verification passed).
  let hash = "";
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd, timeout: 15_000 });
    hash = createHash("sha256").update(stdout).digest("hex");
  } catch {
    // Not in a git repo or git not available — gate still works, hash is empty.
  }

  return { passed, stages, diffHash: hash };
}

// Pretty-print a ChainResult to stdout
export function printChainResult(result: ChainResult): void {
  const SEP = "─".repeat(44);
  console.log(`\nVERIFICATION CHAIN`);
  console.log(SEP);

  for (const stage of result.stages) {
    if (stage.skipped) {
      console.log(`  SKIP  ${stage.stage.padEnd(6)}  ${stage.skipReason}`);
      continue;
    }
    const icon = stage.passed ? "  PASS" : "  FAIL";
    console.log(`${icon}  ${stage.stage.padEnd(6)}  (${stage.durationMs}ms)`);
    if (!stage.passed) {
      const output = (stage.stderr || stage.stdout).trim().slice(0, 800);
      for (const line of output.split("\n").slice(0, 20)) {
        console.log(`         ${line}`);
      }
    }
  }

  console.log(SEP);
  console.log(result.passed ? "  All checks passed.\n" : "  FAILED — changes not accepted.\n");
}
