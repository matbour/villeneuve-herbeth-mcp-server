import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { HerbethClient, classeursAsArray, type Space } from "./client.ts";
import type { MetadataStore, DocumentMetadata } from "./metadata.ts";

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

function metadataView(meta: DocumentMetadata) {
  return {
    document_id: meta.document_id,
    title: meta.title,
    classeur_id: meta.classeur_id,
    supplier: meta.supplier,
    amount_cents: meta.amount_cents,
    currency: meta.currency,
    document_date: meta.document_date,
    tags: meta.tags,
    notes: meta.notes,
    source: {
      file_name: meta.source_file_name,
      title: meta.source_title,
      classeur_id: meta.source_classeur_id,
      date_commit: meta.source_date_commit,
    },
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
}

export function createMcpServer(
  client: HerbethClient,
  metadata: MetadataStore,
): McpServer {
  const server = new McpServer(
    { name: "villeneuve-herbeth-mcp-server", version: "0.1.0" },
    {
      instructions:
        "Tools to interact with the Villeneuve / Herbeth Immobilier copropriété extranet (crypto-extranet.com). " +
        "Use list_classeurs to discover folders, list_documents to enumerate files inside one, and download_file to save a document to disk. " +
        "Document IDs returned by list_documents are stable and required for download_file. " +
        "Source filenames and classeurs are often inaccurate, so use get/set_document_metadata and search_documents to layer corrected titles, suppliers, amounts, dates, tags, and notes on top.",
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
      "Returns each document's id (use with download_file), file_name, title, mime_type, date_commit, and any user-curated metadata override (corrected_title, supplier, amount, tags, etc.).",
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
      const overrides = metadata.getMany(listing.data.Documents.map((d) => d.id));
      const docs = listing.data.Documents.map((d) => {
        const meta = overrides.get(d.id);
        return {
          id: d.id,
          file_name: d.file_name,
          title: d.title,
          mime_type: d.mime_type,
          date_commit: d.date_commit,
          date_commit_libelle: d.date_commit_libelle,
          classeur_id: d.documents_classeurs_id,
          metadata: meta
            ? {
                title: meta.title,
                classeur_id: meta.classeur_id,
                supplier: meta.supplier,
                amount_cents: meta.amount_cents,
                currency: meta.currency,
                document_date: meta.document_date,
                tags: meta.tags,
                notes: meta.notes,
              }
            : null,
        };
      });
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
                annotated: docs.filter((d) => d.metadata).length,
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

  server.tool(
    "get_document_metadata",
    "Read user-curated metadata for a document (corrected title, supplier, amount, document_date, tags, notes, etc.). Returns null if no metadata has been recorded yet.",
    {
      document_id: z
        .number()
        .int()
        .positive()
        .describe("Document id from list_documents."),
    },
    async ({ document_id }) => {
      const meta = metadata.get(document_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { document_id, metadata: meta ? metadataView(meta) : null },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "set_document_metadata",
    "Upsert user-curated metadata for a document. Only fields provided are updated; omit a field to leave it unchanged. Pass null to clear a single field. Tags replace the previous tag list (pass [] to clear). Useful for fixing wrong titles, recording the real classeur a document belongs to, or tagging invoices with supplier/amount/date.",
    {
      document_id: z.number().int().positive().describe("Document id from list_documents."),
      title: z
        .string()
        .nullable()
        .optional()
        .describe("Corrected human-readable title. Pass null to clear."),
      classeur_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Override classeur (the one the doc *should* live in). Pass null to clear."),
      supplier: z
        .string()
        .nullable()
        .optional()
        .describe("Supplier / vendor name (e.g. for invoices). Pass null to clear."),
      amount_cents: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Amount in cents (integer to avoid floats). Pass null to clear."),
      currency: z
        .string()
        .length(3)
        .nullable()
        .optional()
        .describe("ISO 4217 currency code (e.g. EUR). Pass null to clear."),
      document_date: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Real document date as ISO 8601 YYYY-MM-DD (the date on the document itself, not the upload date). Pass null to clear.",
        ),
      tags: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("Replace the tag list. Pass [] to clear all tags."),
      notes: z
        .string()
        .nullable()
        .optional()
        .describe("Free-form notes. Pass null to clear."),
      capture_source_snapshot: z
        .boolean()
        .default(true)
        .describe(
          "When true (default), fetches the document's current source fields (file_name, title, classeur_id, date_commit) and stores them alongside, so you can later detect drift if the extranet entry changes.",
        ),
      space: spaceSchema.optional(),
    },
    async ({
      document_id,
      title,
      classeur_id,
      supplier,
      amount_cents,
      currency,
      document_date,
      tags,
      notes,
      capture_source_snapshot,
      space,
    }) => {
      const input: Parameters<typeof metadata.upsert>[0] = { document_id };
      if (title !== undefined) input.title = title;
      if (classeur_id !== undefined) input.classeur_id = classeur_id;
      if (supplier !== undefined) input.supplier = supplier;
      if (amount_cents !== undefined) input.amount_cents = amount_cents;
      if (currency !== undefined) input.currency = currency;
      if (document_date !== undefined) input.document_date = document_date;
      if (tags !== undefined) input.tags = tags;
      if (notes !== undefined) input.notes = notes;

      if (capture_source_snapshot) {
        const existing = metadata.get(document_id);
        const snapshotClasseur = existing?.source_classeur_id ?? classeur_id ?? undefined;
        if (snapshotClasseur) {
          try {
            const listing = await client.listDocumentsInClasseur(
              snapshotClasseur,
              (space ?? "conseil-syndical") as Space,
            );
            const found = listing.data.Documents.find((d) => d.id === document_id);
            if (found) {
              input.source_file_name = found.file_name;
              input.source_title = found.title;
              input.source_classeur_id = found.documents_classeurs_id;
              input.source_date_commit = found.date_commit;
            }
          } catch {
            /* snapshot is best-effort; ignore failures */
          }
        }
      }

      const saved = metadata.upsert(input);
      return {
        content: [
          { type: "text", text: JSON.stringify({ saved: metadataView(saved) }, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "delete_document_metadata",
    "Delete all user-curated metadata for a document. The source file on the extranet is not affected.",
    {
      document_id: z.number().int().positive().describe("Document id from list_documents."),
    },
    async ({ document_id }) => {
      const deleted = metadata.delete(document_id);
      return {
        content: [
          { type: "text", text: JSON.stringify({ document_id, deleted }, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "search_documents",
    "Search the user-curated metadata DB. Combines filters (text on title/notes/supplier/source_file_name, supplier, tag, classeur_id override, document_date range, amount range). Only returns documents that have stored metadata — for unannotated documents, use list_documents.",
    {
      text: z
        .string()
        .optional()
        .describe("Free-text LIKE match against title, notes, supplier, source_file_name."),
      supplier: z.string().optional().describe("Exact supplier match."),
      tag: z.string().optional().describe("Match a single tag from the tags list."),
      classeur_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by override classeur_id."),
      document_date_from: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD inclusive lower bound on document_date."),
      document_date_to: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD inclusive upper bound on document_date."),
      amount_min_cents: z
        .number()
        .int()
        .optional()
        .describe("Inclusive minimum amount in cents."),
      amount_max_cents: z
        .number()
        .int()
        .optional()
        .describe("Inclusive maximum amount in cents."),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max results (default 100, max 500)."),
    },
    async (filters) => {
      const results = metadata.search(filters);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: results.length,
                results: results.map(metadataView),
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
