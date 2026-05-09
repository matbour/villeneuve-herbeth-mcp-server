import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../server.ts";
import type { HerbethClient } from "../client.ts";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

export async function startHttp(client: HerbethClient): Promise<void> {
  const port = Number(Bun.env.PORT ?? 3000);
  const host = Bun.env.HOST ?? "0.0.0.0";
  const token = Bun.env.MCP_AUTH_TOKEN;
  if (!token) {
    throw new Error("MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http");
  }
  const expectedAuth = `Bearer ${token}`;

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === HEALTH_PATH) {
        send(res, 200, { ok: true });
        return;
      }

      if (url.pathname !== MCP_PATH) {
        send(res, 404, { error: "Not Found" });
        return;
      }

      if (req.headers.authorization !== expectedAuth) {
        send(res, 401, { error: "Unauthorized" }, {
          "www-authenticate": 'Bearer realm="mcp"',
        });
        return;
      }

      const body =
        req.method === "POST" ? await readJsonBody(req).catch(() => undefined) : undefined;

      const server = createMcpServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[villeneuve-herbeth-mcp] HTTP handler error:", err);
      if (!res.headersSent) {
        send(res, 500, { error: "Internal Server Error" });
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  await new Promise<void>((resolveStart) => {
    httpServer.listen(port, host, () => resolveStart());
  });

  console.error(
    `[villeneuve-herbeth-mcp] http transport ready on http://${host}:${port}${MCP_PATH} (health: ${HEALTH_PATH}).`,
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.error(`[villeneuve-herbeth-mcp] received ${sig}, shutting down.`);
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}
