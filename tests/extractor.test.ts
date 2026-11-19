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
  fs.writeFileSync(
    path.join(dir, "src/b.ts"),
    [
      "export function helper(x: number): number { return x + 1; }",
      "export const format = (n: number): string => `#${n}`;",
      "export class Store { save(): void {} }",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "src/a.ts"),
    [
      'import path from "node:path";',
      'import { helper, helper as plusOne, format, Store } from "./b.js";',
      'import * as b from "./b.js";',
      "function local(): number { return 1; }",
      "export function main(): string {",
      "  helper(local());",
      "  plusOne(2);",
      "  b.helper(3);",
      "  new Store().save();",
      '  return path.join(format(1), String(2)).trim();',
      "}",
    ].join("\n"),
  );
  process.chdir(dir);
  after(() => process.chdir(before));

  test("records functions, the import between files, and calls into project code only", async () => {
    const extractor = new TypeScriptExtractor();
    await extractor.extract("src/b.ts");
    const { nodes, edges } = await extractor.extract("src/a.ts");

    assert.deepEqual(nodes.filter((n) => n.kind === "function").map((n) => n.name).sort(), ["local", "main"]);
    assert.ok(edges.some((e) => e.kind === "imports" && e.fromId === "module:src/a.ts" && e.toId === "module:src/b.ts"));

    const calls = edges.filter((e) => e.kind === "calls").map((e) => `${e.fromId} -> ${e.toId}`).sort();
    assert.deepEqual(calls, [
      // helper(), plusOne() (a renamed import) and b.helper() are all one function, linked once.
      "function:src/a.ts:main -> function:src/a.ts:local",
      "function:src/a.ts:main -> function:src/b.ts:format",
      "function:src/a.ts:main -> function:src/b.ts:helper",
    ]);
    // Not linked: Store.save (a method; the index has no node for it), and path.join, String, trim (libraries).
  });
});
