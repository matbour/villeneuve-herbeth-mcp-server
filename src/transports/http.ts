import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../server.ts";
import { HerbethClient } from "../client.ts";
import type { MetadataStore } from "../metadata.ts";

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

/** Decode `Authorization: Basic base64(user:pass)`. Returns null if missing or malformed. */
function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header) return null;
  const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  if (!username || !password) return null;
  return { username, password };
}

/** Start the HTTP transport.
 *
 * Auth model: each request must carry `Authorization: Basic base64(user:pass)`
 * with the caller's own Herbeth Immobilier extranet credentials. The server
 * uses those credentials to talk to the extranet on behalf of the user — no
 * shared/operator credentials are kept on the server. The shared
 * `MCP_AUTH_TOKEN` from previous versions is gone.
 *
 * The metadata SQLite DB is shared across all callers (it holds the curated
 * Villeneuve copropriété catalog).
 */
export async function startHttp(
  _unusedClient: HerbethClient | null,
  metadata: MetadataStore,
): Promise<void> {
  const port = Number(Bun.env.PORT ?? 3000);
  const host = Bun.env.HOST ?? "0.0.0.0";

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

      const creds = parseBasicAuth(req.headers.authorization);
      if (!creds) {
        send(res, 401,
          {
            error: "Unauthorized",
            hint: "Send `Authorization: Basic base64(extranet_login:extranet_password)` with your own Herbeth Immobilier extranet credentials. The server does not hold shared credentials.",
          },
          { "www-authenticate": 'Basic realm="herbeth-extranet", charset="UTF-8"' },
        );
        return;
      }

      const body =
        req.method === "POST" ? await readJsonBody(req).catch(() => undefined) : undefined;

      const client = new HerbethClient(creds.username, creds.password);
      const server = createMcpServer(client, metadata);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
        client.logout().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[villeneuve-herbeth-mcp] HTTP handler error:", err);
      if (!res.headersSent) {
        // Authentication failures from the extranet bubble up here as plain
        // Errors. Surface a 401 if the message looks credential-related.
        const msg = (err as Error).message ?? "";
        const looksAuth = /authentication failed|401|403/i.test(msg);
        send(res, looksAuth ? 401 : 500, {
          error: looksAuth ? "Extranet authentication failed" : "Internal Server Error",
          detail: msg,
        });
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  await new Promise<void>((resolveStart) => {
    httpServer.listen(port, host, () => resolveStart());
  });

  console.error(
    `[villeneuve-herbeth-mcp] http transport ready on http://${host}:${port}${MCP_PATH} (health: ${HEALTH_PATH}). ` +
      `Each request must carry Basic auth with the caller's own Herbeth credentials.`,
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.error(`[villeneuve-herbeth-mcp] received ${sig}, shutting down.`);
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}
