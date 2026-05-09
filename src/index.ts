#!/usr/bin/env bun
import { HerbethClient } from "./client.ts";
import { MetadataStore } from "./metadata.ts";
import { startStdio } from "./transports/stdio.ts";
import { startHttp } from "./transports/http.ts";

const transport = (Bun.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const metadata = new MetadataStore(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

switch (transport) {
  case "stdio": {
    // Stdio is single-user, runs locally — read credentials from env.
    const username = Bun.env.HERBETH_USERNAME;
    const password = Bun.env.HERBETH_PASSWORD;
    if (!username || !password) {
      console.error(
        "[villeneuve-herbeth-mcp] Missing HERBETH_USERNAME / HERBETH_PASSWORD in environment.",
      );
      process.exit(1);
    }
    const client = new HerbethClient(username, password);
    await startStdio(client, metadata);
    break;
  }
  case "http":
  case "streamable-http":
    // HTTP is multi-user — credentials come per request via HTTP Basic auth.
    // We pass null for the client; the transport instantiates one per call.
    await startHttp(null, metadata);
    break;
  default:
    console.error(
      `[villeneuve-herbeth-mcp] Unknown MCP_TRANSPORT="${transport}". Use "stdio" or "http".`,
    );
    process.exit(1);
}
