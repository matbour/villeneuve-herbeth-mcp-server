import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../server.ts";
import type { HerbethClient } from "../client.ts";

export async function startStdio(client: HerbethClient): Promise<void> {
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[villeneuve-herbeth-mcp] stdio transport ready.");
}
