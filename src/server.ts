import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { HerbethClient, classeursAsArray, type Space } from "./client.ts";

const DEFAULT_DOWNLOAD_DIR =
  Bun.env.HERBETH_DOWNLOAD_DIR ?? `${homedir()}/Downloads/herbeth`;

const spaceSchema = z
  .enum(["coproprietaire", "conseil-syndical"])
  .default("conseil-syndical")
  .describe(
    "Which extranet space to query. 'conseil-syndical' is the council space (more documents); 'coproprietaire' is the co-owner space.",
  );

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "download";
}

export function createMcpServer(client: HerbethClient): McpServer {
  const server = new McpServer(
    { name: "villeneuve-herbeth-mcp-server", version: "0.1.0" },
    {
      instructions:
        "Tools to interact with the Villeneuve / Herbeth Immobilier copropriété extranet (crypto-extranet.com). " +
        "Use list_classeurs to discover folders, list_documents to enumerate files inside one, and download_file to save a document to disk. " +
        "Document IDs returned by list_documents are stable and required for download_file.",
    },
  );

  server.tool(
    "get_current_user",
    "Return the currently logged-in extranet user (name, role, copropriété, council membership). Useful to verify the session is healthy.",
    {},
    async () => {
      const user = await client.getCurrentUser();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: user.id,
                login: user.login,
                nom: user.nom,
                role: user.acl_roles_libelle,
                nom_copro: user.nom_copro,
                id_copro: user.id_copro,
                membre_conseil: !!user.membre_conseil,
                president_conseil: !!user.president_conseil,
                date_derniere_connexion: user.date_derniere_connexion,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "list_classeurs",
    "List the top-level document folders (classeurs) for a given extranet space. Returns id, nom (name), file count, and last update date.",
    { space: spaceSchema },
    async ({ space }) => {
      const listing = await client.listClasseurs(space as Space);
      const classeurs = classeursAsArray(listing).map((c) => ({
        id: c.id,
        nom: c.nom,
        parent: c.parent,
        fileCount: c.fileCount,
        dateActualisation: c.dateActualisation,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ space, classeurs }, null, 2) }],
      };
    },
  );

  server.tool(
    "list_documents",
    "List documents inside a classeur. Provide either classeur_id (preferred) or classeur_name (case-insensitive match). " +
      "Returns each document's id (use with download_file), file_name, title, mime_type, and date_commit.",
    {
      space: spaceSchema,
      classeur_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Numeric classeur id, as returned by list_classeurs."),
      classeur_name: z
        .string()
        .optional()
        .describe(
          "Classeur name (case-insensitive). Resolved against list_classeurs if classeur_id is omitted.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max documents to return (default: all)."),
    },
    async ({ space, classeur_id, classeur_name, limit }) => {
      let id = classeur_id;
      if (!id) {
        if (!classeur_name) {
          throw new Error("Provide either classeur_id or classeur_name.");
        }
        const root = await client.listClasseurs(space as Space);
        const classeurs = classeursAsArray(root);
        const target = classeur_name.toLowerCase().trim();
        const match = classeurs.find((c) => c.nom.toLowerCase().trim() === target);
        if (!match) {
          const available = classeurs.map((c) => c.nom).join(", ");
          throw new Error(
            `No classeur named "${classeur_name}" in space "${space}". Available: ${available}`,
          );
        }
        id = match.id;
      }

      const listing = await client.listDocumentsInClasseur(id, space as Space);
      const docs = listing.data.Documents.map((d) => ({
        id: d.id,
        file_name: d.file_name,
        title: d.title,
        mime_type: d.mime_type,
        date_commit: d.date_commit,
        date_commit_libelle: d.date_commit_libelle,
        classeur_id: d.documents_classeurs_id,
      }));
      const sliced = limit ? docs.slice(0, limit) : docs;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                space,
                classeur_id: id,
                total: docs.length,
                returned: sliced.length,
                documents: sliced,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "download_file",
    "Download a document by id. In stdio mode, saves to disk and returns the path. In HTTP mode (or when return_base64=true), returns the file contents as base64 — useful for remote clients that can't share a filesystem.",
    {
      document_id: z
        .number()
        .int()
        .positive()
        .describe("Document id from list_documents."),
      output_dir: z
        .string()
        .optional()
        .describe(
          "Directory to save into (stdio mode). Created if missing. Ignored if output_path or return_base64 is set.",
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Explicit absolute or relative file path (stdio mode). Overrides output_dir and filename.",
        ),
      overwrite: z
        .boolean()
        .default(false)
        .describe("If false (default), refuse to overwrite an existing file."),
      return_base64: z
        .boolean()
        .default(false)
        .describe(
          "If true, return file contents as base64 instead of writing to disk. Default true in HTTP mode (set via MCP_DOWNLOAD_RETURN_BASE64).",
        ),
    },
    async ({ document_id, output_dir, output_path, overwrite, return_base64 }) => {
      const { bytes, filename, mimeType } = await client.downloadFile(document_id);

      const forceBase64 =
        Bun.env.MCP_DOWNLOAD_RETURN_BASE64 === "1" ||
        Bun.env.MCP_DOWNLOAD_RETURN_BASE64?.toLowerCase() === "true";

      if (return_base64 || forceBase64) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  document_id,
                  filename,
                  mime_type: mimeType,
                  bytes: bytes.byteLength,
                  base64: Buffer.from(bytes).toString("base64"),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      let target: string;
      if (output_path) {
        target = expandPath(output_path);
      } else {
        const dir = expandPath(output_dir ?? DEFAULT_DOWNLOAD_DIR);
        const name = sanitizeFilename(filename ?? `document-${document_id}`);
        target = `${dir}/${name}`;
      }

      if (!overwrite) {
        const existing = Bun.file(target);
        if (await existing.exists()) {
          throw new Error(
            `Refusing to overwrite existing file: ${target}. Pass overwrite=true to replace it.`,
          );
        }
      }

      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, bytes);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                document_id,
                path: target,
                filename,
                mime_type: mimeType,
                bytes: bytes.byteLength,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
