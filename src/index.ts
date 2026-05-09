#!/usr/bin/env bun
import { HerbethClient } from "./client.ts";
import { MetadataStore } from "./metadata.ts";
import { startStdio } from "./transports/stdio.ts";
import { startHttp } from "./transports/http.ts";

const username = Bun.env.HERBETH_USERNAME;
const password = Bun.env.HERBETH_PASSWORD;
if (!username || !password) {
  console.error(
    "[villeneuve-herbeth-mcp] Missing HERBETH_USERNAME / HERBETH_PASSWORD in environment.",
  );
  process.exit(1);
}

const client = new HerbethClient(username, password);
const metadata = new MetadataStore(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");
const transport = (Bun.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

switch (transport) {
  case "stdio":
    await startStdio(client, metadata);
    break;
  case "http":
  case "streamable-http":
    await startHttp(client, metadata);
    break;
  default:
    console.error(
      `[villeneuve-herbeth-mcp] Unknown MCP_TRANSPORT="${transport}". Use "stdio" or "http".`,
    );
    process.exit(1);
}
