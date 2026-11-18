import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const messages = require("../vscode-extension/messages.js");

describe("vscode extension — messages", () => {
  test("a selection becomes one line naming the file and lines", () => {
    assert.equal(messages.selectionMessage("src/a.ts", 10, 20, "why is\nthis slow?"), "Look at src/a.ts lines 10-20: why is this slow?");
    assert.equal(messages.selectionMessage("src/a.ts", 7, 7, "explain"), "Look at src/a.ts line 7: explain");
  });

  test("line numbers are 1-based and a selection ending at column 0 stops on the line before", () => {
    assert.deepEqual(messages.lineRange(9, 19, 4), { from: 10, to: 20 });
    assert.deepEqual(messages.lineRange(9, 20, 0), { from: 10, to: 20 });
    assert.deepEqual(messages.lineRange(4, 4, 0), { from: 5, to: 5 });
  });
});

// A stand-in for the parts of the vscode API the extension uses.
interface FakeTerminal { name: string; cwd?: string; exitStatus?: unknown; sent: string[]; sendText(t: string): void; show(): void }
const fake = {
  terminals: [] as FakeTerminal[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  warnings: [] as string[],
  answer: "what does this do?" as string | undefined,
  editor: undefined as unknown,
};
const vscode = {
  StatusBarAlignment: { Right: 2 },
  window: {
    get terminals() { return fake.terminals; },
    get activeTextEditor() { return fake.editor; },
    createTerminal(options: { name: string; cwd?: string }) {
      const t: FakeTerminal = { ...options, exitStatus: undefined, sent: [], sendText(x) { this.sent.push(x); }, show() {} };
      fake.terminals.push(t);
      return t;
    },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showInputBox: async () => fake.answer,
    showWarningMessage: (m: string) => fake.warnings.push(m),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/proj" } }],
    getConfiguration: () => ({ get: (_k: string, d: string) => d }),
    asRelativePath: (uri: { rel: string }) => uri.rel,
  },
  commands: {
    registerCommand(name: string, fn: (...args: unknown[]) => unknown) {
      fake.commands.set(name, fn);
      return { dispose() {} };
    },
  },
};

// Make require("vscode") inside the extension return the stand-in.
const resolve = (Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: unknown })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? "vscode" : resolve.call(this, request, ...rest);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscode } as NodeJS.Module;
const extension = require("../vscode-extension/extension.js");
extension.activate({ subscriptions: [] });

function editor(rel: string, line: [number, number, number], dirty = false) {
  return {
    document: { uri: { scheme: "file", rel }, isDirty: dirty },
    selection: { start: { line: line[0] }, end: { line: line[1], character: line[2] } },
  };
}

describe("vscode extension — commands", () => {
  beforeEach(() => {
    fake.terminals.length = 0;
    fake.warnings.length = 0;
    fake.answer = "what does this do?";
  });

  test("registers every command in its manifest", () => {
    const manifest = require("../vscode-extension/package.json");
    const declared = manifest.contributes.commands.map((c: { command: string }) => c.command).sort();
    assert.deepEqual([...fake.commands.keys()].sort(), declared);
  });

  test("Start opens one Forge terminal in the workspace and reuses it", async () => {
    await fake.commands.get("forge.start")!();
    await fake.commands.get("forge.start")!();
    assert.equal(fake.terminals.length, 1);
    assert.equal(fake.terminals[0]!.cwd, "/proj");
    assert.deepEqual(fake.terminals[0]!.sent, ["forge"]);
  });

  test("Ask About Selection sends the file, lines and question to the open terminal", async () => {
    await fake.commands.get("forge.start")!();
    fake.editor = editor("src/loop.ts", [41, 59, 0]);
    await fake.commands.get("forge.askSelection")!();
    assert.deepEqual(fake.terminals[0]!.sent, ["forge", "Look at src/loop.ts lines 42-59: what does this do?"]);
  });

  test("an unsaved file is refused, since Forge reads from disk", async () => {
    fake.editor = editor("src/loop.ts", [0, 3, 2], true);
    await fake.commands.get("forge.askFile")!();
    assert.equal(fake.terminals.length, 0);
    assert.match(fake.warnings[0]!, /Save this file first/);
  });

  test("cancelling the question sends nothing", async () => {
    await fake.commands.get("forge.start")!();
    fake.editor = editor("src/loop.ts", [0, 3, 2]);
    fake.answer = undefined;
    await fake.commands.get("forge.askFile")!();
    assert.deepEqual(fake.terminals[0]!.sent, ["forge"]);
  });

  test("Repo Map and Undo send the slash commands", async () => {
    await fake.commands.get("forge.start")!();
    await fake.commands.get("forge.repomap")!();
    await fake.commands.get("forge.undo")!();
    assert.deepEqual(fake.terminals[0]!.sent, ["forge", "/repomap", "/undo"]);
  });
});
