import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TypeScriptExtractor } from "../model/typescript/ts-extractor.js";

describe("TypeScript extractor", () => {
  const before = process.cwd();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-extract-")));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/b.ts"), "export function helper(x: number): number { return x + 1; }\n");
  fs.writeFileSync(
    path.join(dir, "src/a.ts"),
    [
      'import path from "node:path";',
      'import { helper } from "./b.js";',
      "function local(): number { return 1; }",
      "export function main(): string {",
      "  helper(local());",
      '  return path.join("a", String(2)).trim();',
      "}",
    ].join("\n"),
  );
  process.chdir(dir);
  after(() => process.chdir(before));

  test("records functions, the import between files, and calls, never links into libraries", async () => {
    const extractor = new TypeScriptExtractor();
    await extractor.extract("src/b.ts");
    const { nodes, edges } = await extractor.extract("src/a.ts");

    assert.deepEqual(nodes.filter((n) => n.kind === "function").map((n) => n.name).sort(), ["local", "main"]);
    assert.ok(edges.some((e) => e.kind === "imports" && e.fromId === "module:src/a.ts" && e.toId === "module:src/b.ts"));
    const calls = edges.filter((e) => e.kind === "calls").map((e) => `${e.fromId} -> ${e.toId}`);
    assert.deepEqual(calls, ["function:src/a.ts:main -> function:src/a.ts:local"], "path.join, String and trim are library calls");
  });
});
