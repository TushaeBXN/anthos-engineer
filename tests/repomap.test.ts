import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRepoMap, definitions } from "../agent/repomap.js";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-map-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("definitions", () => {
  test("TypeScript: exported and top-level functions, classes, types, consts", () => {
    const names = definitions(
      `export async function runTurn() {}\nexport class Agent {}\nexport interface Tool {}\nexport type Id = string;\nexport const tools = [];\nfunction helper() {}\n  const inner = 1;`,
      "ts",
    );
    assert.deepEqual(names, ["runTurn", "Agent", "Tool", "Id", "tools", "helper"]);
  });

  test("Swift: attributes and modifiers before the keyword; class func is a function; an extension's methods count, the extension itself doesn't", () => {
    const names = definitions(
      [
        "import SwiftUI",
        "@MainActor",
        "public final class AppModel: ObservableObject {",
        "  @Published var count = 0",
        "  public static func shared() -> AppModel { AppModel() }",
        "  class func make() -> AppModel { AppModel() }",
        "  private mutating func reset() {}",
        "}",
        "struct ContentView: View { var body: some View { Text(\"hi\") } }",
        "protocol Store {",
        "  func save()",
        "}",
        "actor Cache {}",
        "enum Mode { case light, dark }",
        "extension AppModel {",
        "  func extra() {}",
        "}",
        "typealias ID = String",
      ].join("\n"),
      "swift",
    );
    assert.deepEqual(names, ["AppModel", "shared", "make", "reset", "ContentView", "Store", "save", "Cache", "Mode", "extra", "ID"]);
  });

  test("Python, Go and Rust", () => {
    assert.deepEqual(definitions("class Store:\n    def get(self): pass\ndef load_all():\n    pass", "py"), ["Store", "load_all"]);
    assert.deepEqual(definitions("func (s *Server) Start() {}\ntype Config struct {}", "go"), ["Start", "Config"]);
    assert.deepEqual(definitions("pub fn parse() {}\npub(crate) struct Token;\nenum Kind {}", "rs"), ["parse", "Token", "Kind"]);
  });
});

describe("buildRepoMap", () => {
  const files = {
    "src/core.ts": "export function computeTotal() {}\nexport class Ledger {}",
    "src/a.ts": "import { computeTotal, Ledger } from './core';\nexport function showA() { computeTotal(); }",
    "src/b.ts": "import { computeTotal } from './core';\nexport function showB() { computeTotal(); }",
    "src/c.ts": "import { showA } from './a';\nexport function leaf() { showA(); }",
    "README.md": "not source",
  };

  test("the file everything depends on comes first, with its names", () => {
    const map = buildRepoMap(project(files), 1024);
    const lines = map.text.split("\n");
    assert.equal(lines[0], "src/core.ts: computeTotal, Ledger");
    assert.equal(map.files, 4, "only source files are mapped");
    assert.ok(lines.indexOf("src/a.ts: showA") < lines.indexOf("src/c.ts: leaf"), "a.ts is used by c.ts, so it outranks it");
  });

  test("stays within the budget and says how much was left out", () => {
    const map = buildRepoMap(project(files), 10);
    assert.ok(map.text.length <= 10 * 4 + 40);
    assert.match(map.text, /more files not shown/);
    assert.ok(map.shown < map.files);
  });

  test("a budget of 0 turns it off; a folder with no source gives nothing", () => {
    assert.equal(buildRepoMap(project(files), 0).text, "");
    assert.equal(buildRepoMap(project({ "notes.md": "hi" }), 1024).text, "");
  });

  test("node_modules is skipped", () => {
    const map = buildRepoMap(project({ ...files, "node_modules/x/index.js": "export function huge() {}" }), 1024);
    assert.doesNotMatch(map.text, /node_modules/);
  });
});
