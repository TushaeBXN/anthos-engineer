import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp, mcpToolName, resultText, type McpConnection } from "../agent/mcp.js";
import { check } from "../policy/check.js";
import type { ForgePolicy } from "../policy/schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = { command: path.join(root, "node_modules/.bin/tsx"), args: [path.join(root, "tests/fixtures/mcp-server.ts")] };
const WHO = { agentId: "test", sessionId: "s1" };

let home = "";
let cwd = "";
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
async function withConnection<T>(mcp: Promise<McpConnection>, fn: (c: McpConnection) => T | Promise<T>): Promise<T> {
  const connection = await mcp;
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-")));
  process.env["FORGE_HOME"] = home;
});

describe("MCP — your own servers", () => {
  test("tools become Forge tools that call the server", async () => {
    writeJson(path.join(home, "mcp.json"), { mcpServers: { calc: SERVER } });
    await withConnection(connectMcp(cwd), async (mcp) => {
      assert.deepEqual(mcp.servers, [{ name: "calc", source: "user", state: "connected", tools: 3 }]);
      assert.deepEqual(mcp.tools.map((t) => t.name).sort(), ["mcp__calc__add", "mcp__calc__fail", "mcp__calc__save_note"]);

      const add = mcp.tools.find((t) => t.name === "mcp__calc__add")!;
      assert.deepEqual(add.inputSchema.required, ["a", "b"]);
      assert.equal(add.inputSchema.properties["a"]!.type, "number");
      assert.match(add.description, /Add two numbers\. \(from MCP server "calc"\)/);
      assert.deepEqual(await add.run({ a: 2, b: 3 }, cwd), { output: "5", isError: false });

      const fail = mcp.tools.find((t) => t.name === "mcp__calc__fail")!;
      assert.deepEqual(await fail.run({}, cwd), { output: "Something went wrong on the server.", isError: true });
    });
  });

  test("read-only comes from the server's hint; the policy sees server and tool", async () => {
    writeJson(path.join(home, "mcp.json"), { mcpServers: { calc: SERVER } });
    await withConnection(connectMcp(cwd), (mcp) => {
      const access = (name: string) => mcp.tools.find((t) => t.name === name)!.access({});
      assert.deepEqual(access("mcp__calc__add"), { kind: "mcp", server: "calc", tool: "add", readOnly: true });
      assert.deepEqual(access("mcp__calc__save_note"), { kind: "mcp", server: "calc", tool: "save_note", readOnly: false });

      const none: ForgePolicy = { version: 1, default: "deny", rules: [] };
      assert.equal(check(access("mcp__calc__add"), none, WHO).decision, "ask", "no rule → ask");
      const rules: ForgePolicy = {
        version: 1,
        default: "deny",
        rules: [
          { id: "calc-add", resource: "mcp", operation: "add", target: "calc", effect: "allow" },
          { id: "no-notes", resource: "mcp", operation: "save_note", target: "*", effect: "deny" },
        ],
      };
      assert.equal(check(access("mcp__calc__add"), rules, WHO).decision, "allow");
      assert.equal(check(access("mcp__calc__save_note"), rules, WHO).decision, "deny");
    });
  });

  test("a server that cannot start is reported, not fatal", async () => {
    writeJson(path.join(home, "mcp.json"), { mcpServers: { broken: { command: "/nonexistent/forge-mcp" }, calc: SERVER } });
    await withConnection(connectMcp(cwd), (mcp) => {
      const broken = mcp.servers.find((s) => s.name === "broken")!;
      assert.equal(broken.state, "failed");
      assert.ok(broken.detail);
      assert.equal(mcp.tools.length, 3, "the working server still gives its tools");
    });
  });
});

describe("MCP — servers that declare an output schema but reply in plain text (like Xcode's bridge)", () => {
  test("the reply's text is used instead of failing the call", async () => {
    const schemaServer = { command: SERVER.command, args: [path.join(root, "tests/fixtures/mcp-schema-server.ts")] };
    writeJson(path.join(home, "mcp.json"), { mcpServers: { xcode: schemaServer } });
    await withConnection(connectMcp(cwd), async (mcp) => {
      const build = mcp.tools.find((t) => t.name === "mcp__xcode__BuildProject")!;
      assert.deepEqual(await build.run({}, cwd), { output: '{"status":"Build succeeded"}', isError: false });
    });
  });
});

describe("MCP — a project's servers need trust", () => {
  test("with no one to ask, an untrusted project server is skipped", async () => {
    writeJson(path.join(cwd, ".forge/mcp.json"), { mcpServers: { calc: SERVER } });
    await withConnection(connectMcp(cwd), (mcp) => {
      assert.equal(mcp.servers[0]!.state, "skipped");
      assert.equal(mcp.tools.length, 0);
    });
  });

  test("'always' starts it and remembers; a changed config asks again", async () => {
    writeJson(path.join(cwd, ".forge/mcp.json"), { mcpServers: { calc: SERVER } });
    const asked: string[] = [];
    await withConnection(connectMcp(cwd, { trust: async (q) => (asked.push(q), "always") }), (mcp) => {
      assert.equal(mcp.servers[0]!.state, "connected");
    });
    assert.match(asked[0]!, /This project's MCP server "calc" wants to run: .*tsx .*mcp-server\.ts/);

    await withConnection(connectMcp(cwd), (mcp) => assert.equal(mcp.servers[0]!.state, "connected", "remembered"));

    writeJson(path.join(cwd, ".forge/mcp.json"), { mcpServers: { calc: { ...SERVER, args: [...SERVER.args, "--changed"] } } });
    await withConnection(connectMcp(cwd), (mcp) => assert.equal(mcp.servers[0]!.state, "skipped", "changed config is not trusted"));
  });

  test("'no' skips it; a project cannot replace one of your servers", async () => {
    writeJson(path.join(cwd, ".forge/mcp.json"), { mcpServers: { other: SERVER } });
    await withConnection(connectMcp(cwd, { trust: async () => "no" }), (mcp) => assert.equal(mcp.servers[0]!.state, "skipped"));

    writeJson(path.join(home, "mcp.json"), { mcpServers: { calc: SERVER } });
    writeJson(path.join(cwd, ".forge/mcp.json"), { mcpServers: { calc: { command: "/bin/echo" } } });
    await withConnection(connectMcp(cwd, { trust: async () => "always" }), (mcp) => {
      const fromProject = mcp.servers.find((s) => s.source === "project")!;
      assert.equal(fromProject.state, "skipped");
      assert.match(fromProject.detail!, /your own server/);
      assert.equal(mcp.servers.find((s) => s.source === "user")!.state, "connected");
    });
  });
});

describe("MCP — names and results", () => {
  test("tool names are safe for model APIs, unique, and at most 64 characters", () => {
    const taken = new Set<string>();
    assert.equal(mcpToolName("my server", "get.thing", taken), "mcp__my_server__get_thing");
    assert.equal(mcpToolName("my server", "get thing", taken), "mcp__my_server__get_thing_2");
    assert.ok(mcpToolName("s".repeat(40), "t".repeat(40), taken).length <= 64);
  });

  test("non-text results are described instead of dropped", () => {
    assert.equal(
      resultText({ content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data: "x" }, { type: "resource", resource: { uri: "file:///a", text: "body" } }] }),
      "hi\n[image: image/png]\nbody",
    );
    assert.equal(resultText({ content: [], structuredContent: { ok: true } }), '{\n  "ok": true\n}');
  });
});
