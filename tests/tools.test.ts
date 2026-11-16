import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bash } from "../tools/bash.js";
import { countChangedLines, edit, read, write } from "../tools/files.js";
import { glob, grep } from "../tools/search.js";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("read", () => {
  test("returns numbered lines", async () => {
    const cwd = project({ "a.txt": "one\ntwo\nthree" });
    const result = await read.run({ path: "a.txt" }, cwd);
    assert.match(result.output, /1 {2}one\n\s+2 {2}two\n\s+3 {2}three/);
  });

  test("offset and limit select a range and say what was left out", async () => {
    const cwd = project({ "a.txt": "one\ntwo\nthree\nfour" });
    const result = await read.run({ path: "a.txt", offset: 2, limit: 2 }, cwd);
    assert.match(result.output, /2 {2}two\n\s+3 {2}three/);
    assert.doesNotMatch(result.output, /one/);
    assert.match(result.output, /lines 4–4 not shown/);
  });

  test("a missing file rejects, so the loop can report it", async () => {
    await assert.rejects(read.run({ path: "nope.txt" }, project({})));
  });
});

describe("write", () => {
  test("creates a file and its folders, and counts the new lines", async () => {
    const cwd = project({});
    const result = await write.run({ path: "src/deep/a.ts", content: "a\nb\n" }, cwd);
    assert.equal(fs.readFileSync(path.join(cwd, "src/deep/a.ts"), "utf8"), "a\nb\n");
    assert.deepEqual(result.lines, { file: "src/deep/a.ts", added: 2, removed: 0 });
  });

  test("replacing a file counts only the lines that changed", async () => {
    const cwd = project({ "a.ts": "keep\nold\n" });
    const result = await write.run({ path: "a.ts", content: "keep\nnew\nmore\n" }, cwd);
    assert.deepEqual(result.lines, { file: "a.ts", added: 2, removed: 1 });
  });
});

describe("edit", () => {
  test("replaces one exact match", async () => {
    const cwd = project({ "a.ts": "const a = 1;\nconst b = 2;\n" });
    const result = await edit.run({ path: "a.ts", old_string: "b = 2", new_string: "b = 3" }, cwd);
    assert.equal(fs.readFileSync(path.join(cwd, "a.ts"), "utf8"), "const a = 1;\nconst b = 3;\n");
    assert.deepEqual(result.lines, { file: "a.ts", added: 1, removed: 1 });
  });

  test("text that is not there → error, file untouched", async () => {
    const cwd = project({ "a.ts": "hello\n" });
    const result = await edit.run({ path: "a.ts", old_string: "goodbye", new_string: "x" }, cwd);
    assert.equal(result.isError, true);
    assert.equal(fs.readFileSync(path.join(cwd, "a.ts"), "utf8"), "hello\n");
  });

  test("text that appears twice → error unless replace_all", async () => {
    const cwd = project({ "a.ts": "x\nx\n" });
    const once = await edit.run({ path: "a.ts", old_string: "x", new_string: "y" }, cwd);
    assert.equal(once.isError, true);
    const all = await edit.run({ path: "a.ts", old_string: "x", new_string: "y", replace_all: true }, cwd);
    assert.equal(all.isError, undefined);
    assert.equal(fs.readFileSync(path.join(cwd, "a.ts"), "utf8"), "y\ny\n");
  });

  test("dollar signs in the replacement stay literal", async () => {
    const cwd = project({ "a.ts": "price\n" });
    await edit.run({ path: "a.ts", old_string: "price", new_string: "$& and $1" }, cwd);
    assert.equal(fs.readFileSync(path.join(cwd, "a.ts"), "utf8"), "$& and $1\n");
  });
});

describe("countChangedLines", () => {
  test("identical text → nothing changed", () => {
    assert.deepEqual(countChangedLines("a\nb\n", "a\nb\n"), { added: 0, removed: 0 });
  });
  test("empty to something, and back", () => {
    assert.deepEqual(countChangedLines("", "a\nb"), { added: 2, removed: 0 });
    assert.deepEqual(countChangedLines("a\nb", ""), { added: 0, removed: 2 });
  });
  test("repeated lines are counted one for one", () => {
    assert.deepEqual(countChangedLines("x\nx\nx", "x"), { added: 0, removed: 2 });
  });
});

describe("glob and grep", () => {
  const cwd = project({
    "src/a.ts": "export function alpha() {}\n",
    "src/b.ts": "export function beta() {}\n",
    "node_modules/pkg/index.ts": "export function alpha() {}\n",
    "README.md": "alpha docs\n",
  });

  test("glob finds files and skips node_modules", async () => {
    const result = await glob.run({ pattern: "**/*.ts" }, cwd);
    assert.equal(result.output, "src/a.ts\nsrc/b.ts");
  });

  test("grep returns path:line: text and skips node_modules", async () => {
    const result = await grep.run({ pattern: "function alpha" }, cwd);
    assert.equal(result.output, "src/a.ts:1: export function alpha() {}");
  });

  test("grep can be limited to some files", async () => {
    const result = await grep.run({ pattern: "alpha", files: "*.md" }, cwd);
    assert.equal(result.output, "README.md:1: alpha docs");
  });

  test("grep with a bad pattern → error", async () => {
    const result = await grep.run({ pattern: "(" }, cwd);
    assert.equal(result.isError, true);
  });

  test("nothing found is said plainly", async () => {
    assert.equal((await glob.run({ pattern: "*.py" }, cwd)).output, "No files match.");
    assert.equal((await grep.run({ pattern: "zzz" }, cwd)).output, "No matches.");
  });
});

describe("bash", () => {
  test("returns output", async () => {
    const result = await bash.run({ command: "echo hello" }, os.tmpdir());
    assert.equal(result.output, "hello");
    assert.equal(result.isError, undefined);
  });

  test("a failing command is an error that includes the exit code and output", async () => {
    const result = await bash.run({ command: "echo oops >&2; exit 3" }, os.tmpdir());
    assert.equal(result.isError, true);
    assert.match(result.output, /oops/);
    assert.match(result.output, /exit code 3/);
  });

  test("runs in the project folder", async () => {
    const cwd = fs.realpathSync(project({}));
    assert.equal((await bash.run({ command: "pwd" }, cwd)).output, cwd);
  });
});
