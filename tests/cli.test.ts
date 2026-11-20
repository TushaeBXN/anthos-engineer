import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { VERSION } from "../agent/version.js";

const run = promisify(execFile);
const cli = (...args: string[]) =>
  run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", ...args], { env: { ...process.env } });

test("VERSION is package.json's version", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.strictEqual(VERSION, pkg.version);
});

test("forge --version and -v print the version without a model", async () => {
  for (const flag of ["--version", "-v", "version"]) {
    const { stdout } = await cli(flag);
    assert.strictEqual(stdout.trim(), VERSION);
  }
});

test("an unknown option fails instead of becoming a request", async () => {
  await assert.rejects(cli("--verison"), (err: { code: number; stderr: string }) => {
    assert.strictEqual(err.code, 1);
    assert.match(err.stderr, /Unknown option: --verison/);
    return true;
  });
});
