/**
 * MCP: tools from Model Context Protocol servers, as ordinary Forge tools.
 *
 * Servers are listed in ~/.forge/mcp.json (yours, trusted) and .forge/mcp.json
 * (the project's), in the same shape Claude Code uses:
 *
 *   { "mcpServers": {
 *       "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
 *                   "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
 *       "docs":   { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }
 *
 * "${VAR}" is read from the environment, so secrets stay out of the file.
 *
 * A project's servers run commands on this machine, so each one needs the
 * person's OK before it starts, remembered in ~/.forge/trusted-mcp.json until
 * its config changes. With no one to ask, untrusted servers are skipped.
 *
 * Every MCP tool call goes through the policy as resource "mcp", operation =
 * tool name, target = server name.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "./types.js";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerStatus {
  name: string;
  source: "user" | "project";
  state: "connected" | "failed" | "skipped";
  tools: number;
  detail?: string;
}

export interface McpConnection {
  tools: Tool[];
  servers: McpServerStatus[];
  close(): Promise<void>;
}

export interface McpOptions {
  /** Ask whether a project's server may start. Leave out when no one can answer: untrusted servers are skipped. */
  trust?: (question: string) => Promise<"yes" | "no" | "always">;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

/** Where Forge keeps per-user files (FORGE_HOME overrides, for tests). */
export function forgeHome(): string {
  return process.env["FORGE_HOME"] ?? path.join(os.homedir(), ".forge");
}

let current: McpServerStatus[] = [];

/** The servers from the last connectMcp(), for /mcp. */
export function mcpStatus(): McpServerStatus[] {
  return current;
}

export async function connectMcp(cwd: string, options: McpOptions = {}): Promise<McpConnection> {
  const user = readConfig(path.join(forgeHome(), "mcp.json"));
  const project = readConfig(path.join(cwd, ".forge", "mcp.json"));
  const servers: McpServerStatus[] = [];
  const toStart: { name: string; config: McpServerConfig; source: "user" | "project" }[] = [];

  for (const [name, config] of Object.entries(user)) toStart.push({ name, config, source: "user" });
  for (const [name, config] of Object.entries(project)) {
    if (name in user) {
      servers.push({ name, source: "project", state: "skipped", tools: 0, detail: "your own server with this name is used instead" });
      continue;
    }
    const answer = await trusted(cwd, name, config, options);
    if (answer) toStart.push({ name, config, source: "project" });
    else servers.push({ name, source: "project", state: "skipped", tools: 0, detail: "not trusted; start Forge in a terminal to approve it" });
  }

  const clients: Client[] = [];
  const names = new Set<string>();
  const tools: Tool[] = [];
  const results = await Promise.all(
    toStart.map(async ({ name, config, source }) => {
      const client = new Client({ name: "forge", version: "1.0.0" });
      try {
        await withTimeout(connect(client, name, config, cwd), CONNECT_TIMEOUT_MS, `${name} did not start within ${CONNECT_TIMEOUT_MS / 1000}s`);
        clients.push(client);
        const listed = await listAllTools(client);
        return { status: { name, source, state: "connected" as const, tools: listed.length }, client, listed };
      } catch (err) {
        // Stop whatever did start, so a failed server leaves no process behind.
        await client.close().catch(() => {});
        return { status: { name, source, state: "failed" as const, tools: 0, detail: (err as Error).message } };
      }
    }),
  );
  for (const result of results) {
    servers.push(result.status);
    if (!result.client || !result.listed) continue;
    for (const tool of result.listed) tools.push(wrapTool(result.status.name, tool, result.client, names));
  }

  current = servers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    tools,
    servers: current,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}

function readConfig(file: string): Record<string, McpServerConfig> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServerConfig> };
  return parsed.mcpServers ?? {};
}

/** True when this project server may start: already trusted with this exact config, or the person says yes now. */
async function trusted(cwd: string, name: string, config: McpServerConfig, options: McpOptions): Promise<boolean> {
  const store = path.join(forgeHome(), "trusted-mcp.json");
  const key = path.resolve(cwd);
  const hash = crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
  let trust: Record<string, Record<string, string>> = {};
  try {
    trust = JSON.parse(fs.readFileSync(store, "utf8"));
  } catch {
    // No trust file yet.
  }
  if (trust[key]?.[name] === hash) return true;
  if (!options.trust) return false;

  const what = config.url ? `connect to ${config.url}` : `run: ${[config.command, ...(config.args ?? [])].join(" ")}`;
  const answer = await options.trust(`This project's MCP server "${name}" wants to ${what}. Start it`);
  if (answer === "always") {
    trust[key] = { ...trust[key], [name]: hash };
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(trust, null, 2) + "\n", "utf8");
  }
  return answer !== "no";
}

/** "${VAR}" becomes the environment variable's value. */
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

function expandAll(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, expand(v)]));
}

async function connect(client: Client, name: string, config: McpServerConfig, cwd: string): Promise<void> {
  if (config.url) {
    await client.connect(new StreamableHTTPClientTransport(new URL(expand(config.url)), { requestInit: { headers: expandAll(config.headers) } }));
  } else if (config.command) {
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: (config.args ?? []).map(expand),
        // Only the safe defaults plus what the config names: your whole environment is not handed to every server.
        env: { ...getDefaultEnvironment(), ...expandAll(config.env) },
        cwd: config.cwd ? path.resolve(cwd, config.cwd) : cwd,
        stderr: "ignore",
      }),
    );
  } else {
    throw new Error(`"${name}" needs a "command" or a "url"`);
  }
}

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

async function listAllTools(client: Client): Promise<ListedTool[]> {
  const all: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    all.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** mcp__server__tool, limited to the characters and length model APIs accept, and unique. */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  let name = `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
  for (let i = 2; taken.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
  taken.add(name);
  return name;
}

function wrapTool(server: string, tool: ListedTool, client: Client, taken: Set<string>): Tool {
  const schema = tool.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const readOnly = tool.annotations?.readOnlyHint === true;
  return {
    name: mcpToolName(server, tool.name, taken),
    description: `${(tool.description ?? tool.title ?? tool.name).trim()} (from MCP server "${server}")`,
    inputSchema: { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [] },
    access: () => ({ kind: "mcp", server, tool: tool.name, readOnly }),
    label: () => `MCP ${server} · ${tool.name}`,
    async run(input) {
      // Not client.callTool(): it fails any reply from a tool with an output schema that lacks structured
      // content, which servers such as Xcode's `xcrun mcpbridge` send. Forge reads the text either way.
      const result = await client.request(
        { method: "tools/call", params: { name: tool.name, arguments: input } },
        CallToolResultSchema,
        { timeout: CALL_TIMEOUT_MS },
      );
      return { output: resultText(result), isError: result.isError === true };
    },
  };
}

/** Text parts as they are; anything else described, so the model knows it was there. */
export function resultText(result: Record<string, unknown>): string {
  const parts = Array.isArray(result["content"]) ? (result["content"] as Record<string, unknown>[]) : [];
  const text = parts.map((part) => {
    if (part["type"] === "text") return String(part["text"]);
    if (part["type"] === "image") return `[image: ${part["mimeType"]}]`;
    if (part["type"] === "audio") return `[audio: ${part["mimeType"]}]`;
    if (part["type"] === "resource") {
      const resource = part["resource"] as Record<string, unknown>;
      return typeof resource?.["text"] === "string" ? resource["text"] : `[resource: ${resource?.["uri"]}]`;
    }
    if (part["type"] === "resource_link") return `[link: ${part["uri"]}]`;
    return JSON.stringify(part);
  });
  if (text.length === 0 && result["structuredContent"]) return JSON.stringify(result["structuredContent"], null, 2);
  return text.join("\n") || "(no output)";
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
