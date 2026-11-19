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
      "function setup(): void {}",
      "export class Store {",
      "  constructor() { setup(); }",
      "  save(): void { this.flush(); }",
      "  flush(): void {}",
      "  onChange = (): number => helper(1);",
      "  static create(): Store { return new Store(); }",
      "}",
      "export interface Saver { save(): void }",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "src/a.ts"),
    [
      'import path from "node:path";',
      'import { helper, helper as plusOne, format, Store, type Saver } from "./b.js";',
      'import * as b from "./b.js";',
      "function local(): number { return 1; }",
      "function join(a: string): string { return a; }",
      "export function main(xs: string[]): string {",
      "  helper(local());",
      "  plusOne(2);",
      "  b.helper(3);",
      "  new Store().save();",
      "  Store.create();",
      "  xs.join(',');",
      '  return path.join(format(1), String(2)).trim();',
      "}",
      "export function viaInterface(s: Saver): void { s.save(); }",
    ].join("\n"),
  );
  process.chdir(dir);
  after(() => process.chdir(before));

  const extractor = new TypeScriptExtractor();
  const extract = async (file: string) => extractor.extract(file);
  const callsFrom = (edges: { kind: string; fromId: string; toId: string }[], from: string) =>
    edges.filter((e) => e.kind === "calls" && e.fromId === from).map((e) => e.toId).sort();

  test("indexes functions, and class methods as Class.method", async () => {
    const { nodes } = await extract("src/b.ts");
    const indexed = nodes.filter((n) => n.kind === "function" || n.kind === "method").map((n) => `${n.kind} ${n.name}`).sort();
    assert.deepEqual(indexed, [
      "function format",
      "function helper",
      "function setup",
      "method Store.constructor",
      "method Store.create",
      "method Store.flush",
      "method Store.onChange",
      "method Store.save",
    ]);
  });

  test("links calls inside methods: this.x(), new, and calls out to functions", async () => {
    const { edges } = await extract("src/b.ts");
    assert.deepEqual(callsFrom(edges, "method:src/b.ts:Store.save"), ["method:src/b.ts:Store.flush"]);
    assert.deepEqual(callsFrom(edges, "method:src/b.ts:Store.constructor"), ["function:src/b.ts:setup"]);
    assert.deepEqual(callsFrom(edges, "method:src/b.ts:Store.onChange"), ["function:src/b.ts:helper"]);
    assert.deepEqual(callsFrom(edges, "method:src/b.ts:Store.create"), ["method:src/b.ts:Store.constructor"]);
  });

  test("links calls across files to functions and methods, never to libraries or unrelated names", async () => {
    await extract("src/b.ts");
    const { edges } = await extract("src/a.ts");
    assert.ok(edges.some((e) => e.kind === "imports" && e.fromId === "module:src/a.ts" && e.toId === "module:src/b.ts"));
    assert.deepEqual(callsFrom(edges, "function:src/a.ts:main"), [
      "function:src/a.ts:local",
      "function:src/b.ts:format",
      // helper(), plusOne() (renamed) and b.helper() (namespace) are one function, linked once.
      "function:src/b.ts:helper",
      "method:src/b.ts:Store.constructor",
      "method:src/b.ts:Store.create",
      "method:src/b.ts:Store.save",
    ]);
    // Not linked: xs.join() (an array method, not the local function join), path.join, String, trim.
  });

  test("a call through an interface is not linked: the index can't know which class runs", async () => {
    await extract("src/b.ts");
    const { edges } = await extract("src/a.ts");
    assert.deepEqual(callsFrom(edges, "function:src/a.ts:viaInterface"), []);
  });
});
