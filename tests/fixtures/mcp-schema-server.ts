// An MCP server whose tool declares an output schema but replies with plain text content only,
// the way Xcode's `xcrun mcpbridge` is reported to. Built on the low-level Server, since McpServer
// refuses to send such a reply.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "schema-test", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "BuildProject",
      description: "Build the open project.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: '{"status":"Build succeeded"}' }],
}));

await server.connect(new StdioServerTransport());
