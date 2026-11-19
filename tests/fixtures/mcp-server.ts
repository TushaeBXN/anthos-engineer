// A small real MCP server over stdio, for tests and for trying Forge's MCP support by hand.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const notes: string[] = [];
const server = new McpServer({ name: "forge-test", version: "1.0.0" });

server.registerTool(
  "add",
  { description: "Add two numbers.", inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "save_note",
  { description: "Save a note on the server.", inputSchema: { text: z.string().describe("The note") } },
  async ({ text }) => {
    notes.push(text);
    return { content: [{ type: "text", text: `Saved. ${notes.length} note(s).` }] };
  },
);

server.registerTool(
  "fail",
  { description: "Always reports an error.", annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: "Something went wrong on the server." }], isError: true }),
);

await server.connect(new StdioServerTransport());
