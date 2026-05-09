import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { HerbethClient, classeursAsArray, type Space } from "./client.ts";
import {
  DOC_TYPES,
  type MetadataStore,
  type DocumentMetadata,
  type MetadataInput,
} from "./metadata.ts";

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
    doc_type: meta.doc_type,
    title: meta.title,
    classeur_id: meta.classeur_id,
    target_classeur: meta.target_classeur,
    target_filename: meta.target_filename,
    supplier: meta.supplier,
    amount_cents: meta.amount_cents,
    amount_ht_cents: meta.amount_ht_cents,
    vat_cents: meta.vat_cents,
    currency: meta.currency,
    document_date: meta.document_date,
    period_start: meta.period_start,
    period_end: meta.period_end,
    reference: meta.reference,
    language: meta.language,
    tags: meta.tags,
    notes: meta.notes,
    extra: meta.extra,
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

function metadataSummary(meta: DocumentMetadata) {
  return {
    doc_type: meta.doc_type,
    title: meta.title,
    target_classeur: meta.target_classeur,
    target_filename: meta.target_filename,
    supplier: meta.supplier,
    amount_cents: meta.amount_cents,
    currency: meta.currency,
    document_date: meta.document_date,
    period_start: meta.period_start,
    period_end: meta.period_end,
    reference: meta.reference,
    tags: meta.tags,
    notes: meta.notes,
  };
}

export function createMcpServer(
  client: HerbethClient,
  metadata: MetadataStore,
): McpServer {
  const server = new McpServer(
    { name: "villeneuve-herbeth-mcp-server", version: "0.2.0" },
    {
      instructions:
        "Tools to interact with the Villeneuve / Herbeth Immobilier copropriété extranet (crypto-extranet.com). " +
        "Use list_classeurs to discover folders, list_documents to enumerate files inside one, and download_file to save a document. " +
        "Document IDs returned by list_documents are stable and required for download_file. " +
        "Source filenames and classeurs are often inaccurate or wrong; use set_document_metadata to layer corrected metadata " +
        "(doc_type, title, supplier, amount, dates, period, reference, tags, notes, target_classeur, target_filename, plus a free-form `extra` JSON bag for type-specific fields). " +
        `Recommended doc_type values: ${DOC_TYPES.join(", ")}. ` +
        "search_documents and metadata_stats query the curated DB. The goal is to enable building a properly-named, properly-organized parallel filesystem.",
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
      "Returns each document's id (use with download_file), source file_name/title/date_commit, plus any user-curated metadata (doc_type, corrected title, supplier, amount, dates, target_classeur, etc.).",
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
          metadata: meta ? metadataSummary(meta) : null,
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
    "Read full user-curated metadata for a document. Returns null if no metadata has been recorded yet.",
    {
      document_id: z.number().int().positive().describe("Document id from list_documents."),
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
    "Upsert user-curated metadata for a document. Only fields explicitly provided are updated; omit a field to leave it unchanged. " +
      "Pass null on a field to clear it. Tags / extra are wholesale replacements (pass [] / {} to clear). " +
      "Use this to fix wrong titles, tag the doc_type, record real document dates, supplier, amount HT/TTC/VAT, period, " +
      "and choose where the file lives in the parallel filesystem (target_classeur + target_filename). " +
      "Use the `extra` JSON bag for type-specific fields (e.g. attendees for meeting_minutes, IBAN for bank_statement, contract terms, etc.).",
    {
      document_id: z.number().int().positive().describe("Document id from list_documents."),
      doc_type: z
        .string()
        .nullable()
        .optional()
        .describe(
          `Document type tag. Recommended values: ${DOC_TYPES.join(", ")}. Free-form, but stick to one of these for consistency.`,
        ),
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
        .describe(
          "Override the extranet classeur this doc *should* live in (numeric id). Mostly for tracking miscategorization. Pass null to clear.",
        ),
      target_classeur: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Logical bucket for the parallel filesystem (e.g. 'Factures/2026', 'Contrats/Syndic', 'AG/PV'). Free-form path-like string. Pass null to clear.",
        ),
      target_filename: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Desired filename in the parallel filesystem (e.g. '2026-04-23_FZ-Nettoyage_Facture-26-04-67644.pdf'). Pass null to clear.",
        ),
      supplier: z
        .string()
        .nullable()
        .optional()
        .describe("Supplier / vendor / counterparty name. Pass null to clear."),
      amount_cents: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Amount TTC in cents. Pass null to clear."),
      amount_ht_cents: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Amount HT (excl. VAT) in cents. Pass null to clear."),
      vat_cents: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("VAT amount in cents. Pass null to clear."),
      currency: z
        .string()
        .length(3)
        .nullable()
        .optional()
        .describe("ISO 4217 currency code. Pass null to clear."),
      document_date: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Real document date (date on the doc itself) as ISO YYYY-MM-DD. Pass null to clear.",
        ),
      period_start: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Start of the period the document covers (ISO YYYY-MM-DD). Useful for invoices, bank statements, contracts, accounts. Pass null to clear.",
        ),
      period_end: z
        .string()
        .nullable()
        .optional()
        .describe("End of the covered period (ISO YYYY-MM-DD). Pass null to clear."),
      reference: z
        .string()
        .nullable()
        .optional()
        .describe(
          "External reference / number (invoice number, contract number, devis ref, etc.). Pass null to clear.",
        ),
      language: z
        .string()
        .nullable()
        .optional()
        .describe("ISO 639-1 language code (default 'fr'). Pass null to clear."),
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
      extra: z
        .record(z.unknown())
        .nullable()
        .optional()
        .describe(
          "Free-form JSON bag for type-specific fields (attendees, parties, IBAN, contract terms, etc.). Pass {} to clear.",
        ),
      capture_source_snapshot: z
        .boolean()
        .default(true)
        .describe(
          "When true (default) and a source classeur is known (via source_classeur_id arg, prior snapshot, or classeur_id override), " +
            "fetch the doc's current source fields (file_name, title, classeur_id, date_commit) and store them. Lets you detect later if the extranet entry drifted.",
        ),
      source_classeur_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Hint: the extranet classeur where this doc currently lives. Required (or already known from a prior snapshot) for the snapshot capture to succeed. " +
            "Just pass the same classeur_id you used in list_documents.",
        ),
      space: spaceSchema.optional(),
    },
    async (args) => {
      const {
        document_id,
        capture_source_snapshot,
        source_classeur_id,
        space,
        ...rest
      } = args;

      const input: MetadataInput = { document_id, ...rest };

      if (capture_source_snapshot) {
        const existing = metadata.get(document_id);
        const snapshotClasseur =
          source_classeur_id ??
          existing?.source_classeur_id ??
          (input.classeur_id ?? undefined);
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
    "Search the user-curated metadata DB. Combines filters (text, doc_type, supplier, tag, classeur_id, target_classeur, reference, document_date range, amount range). " +
      "Only returns documents that have stored metadata — for unannotated documents, use list_documents.",
    {
      text: z
        .string()
        .optional()
        .describe(
          "Free-text LIKE match against title, notes, supplier, source_file_name, reference.",
        ),
      doc_type: z
        .string()
        .optional()
        .describe(
          `Filter by doc_type. Recommended values: ${DOC_TYPES.join(", ")}.`,
        ),
      supplier: z.string().optional().describe("Exact supplier match."),
      tag: z.string().optional().describe("Match a single tag from the tags list."),
      classeur_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by override classeur_id."),
      target_classeur: z
        .string()
        .optional()
        .describe("Filter by target_classeur (parallel filesystem bucket)."),
      reference: z.string().optional().describe("Exact reference / invoice number."),
      document_date_from: z
        .string()
        .optional()
        .describe("ISO YYYY-MM-DD inclusive lower bound on document_date."),
      document_date_to: z
        .string()
        .optional()
        .describe("ISO YYYY-MM-DD inclusive upper bound on document_date."),
      amount_min_cents: z
        .number()
        .int()
        .optional()
        .describe("Inclusive minimum amount_cents (TTC)."),
      amount_max_cents: z
        .number()
        .int()
        .optional()
        .describe("Inclusive maximum amount_cents (TTC)."),
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
              { count: results.length, results: results.map(metadataView) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "list_suppliers",
    "List every entry in the suppliers canonicalization table. Each row maps a regex pattern (case-insensitive) to a canonical_name. Used by the bulk-annotate pipeline to normalize varied supplier prefixes (\"FZ\", \"FZ Nettoyage\", \"FZ NETTOYAGE\") into a single canonical name. Lower priority = checked first.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ suppliers: metadata.listSuppliers() }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "add_supplier",
    "Add or update a supplier canonicalization rule. Maps a regex `pattern` (case-insensitive) to a `canonical_name`. Lower `priority` is checked first when canonicalizing. Idempotent on (canonical_name, pattern).",
    {
      canonical_name: z
        .string()
        .min(1)
        .describe("Canonical supplier name to use everywhere (e.g. \"FZ NETTOYAGE\")."),
      pattern: z
        .string()
        .min(1)
        .describe(
          "Regex pattern matched case-insensitively against the raw supplier prefix (e.g. \"^FZ$\" or \"^FZ( NETTOYAGE)?$\").",
        ),
      priority: z
        .number()
        .int()
        .optional()
        .describe("Lower = checked first. Default 100. Use 50 for more-specific patterns."),
    },
    async ({ canonical_name, pattern, priority }) => {
      try {
        new RegExp(pattern, "i");
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
      }
      const saved = metadata.addSupplier({ canonical_name, pattern, priority });
      return {
        content: [{ type: "text", text: JSON.stringify({ saved }, null, 2) }],
      };
    },
  );

  server.tool(
    "delete_supplier",
    "Delete a supplier canonicalization rule by id (use list_suppliers to find ids).",
    {
      id: z.number().int().positive().describe("Supplier rule id."),
    },
    async ({ id }) => {
      const deleted = metadata.deleteSupplier(id);
      return {
        content: [{ type: "text", text: JSON.stringify({ id, deleted }, null, 2) }],
      };
    },
  );

  server.tool(
    "canonicalize_supplier",
    "Look up the canonical supplier name for a raw input string. Returns null if no rule matches. Useful to test patterns or to canonicalize ad-hoc.",
    {
      raw: z.string().min(1).describe("Raw supplier prefix from a document title or file."),
    },
    async ({ raw }) => {
      const canonical = metadata.canonicalizeSupplier(raw);
      return {
        content: [
          { type: "text", text: JSON.stringify({ raw, canonical }, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "full_text_search",
    "Run a full-text search (SQLite FTS5) over indexed metadata + OCR text. " +
      "Returns matched documents with their full curated metadata plus a snippet showing where the match landed. " +
      "Query syntax: bare terms ('FZ NETTOYAGE'), exact phrase ('\"126-128 Strasbourg\"'), boolean ('cuisine AND extincteur'), prefix ('ascens*'), per-column ('supplier:ATHOME'). " +
      "If the index seems stale, call `rebuild_search_index` to re-populate.",
    {
      query: z
        .string()
        .min(1)
        .describe("FTS5 query. Examples: 'FZ NETTOYAGE', '\"rue Lavéran\"', 'amiante', 'supplier:ATHOME'."),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max results (default 50, max 500)."),
    },
    async ({ query, limit }) => {
      try {
        const results = metadata.searchFts(query, { limit });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  count: results.length,
                  results: results.map((r) => ({
                    rank: r.rank,
                    snippet: r.snippet,
                    document: metadataView(r),
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = (err as Error).message;
        // Common: "no such table: document_search" if migration was skipped,
        // or fts5 syntax errors. Surface a friendly hint.
        throw new Error(
          msg.includes("no such table")
            ? "FTS index not present — run `rebuild_search_index` first."
            : `FTS query failed: ${msg}`,
        );
      }
    },
  );

  server.tool(
    "rebuild_search_index",
    "Re-populate the full-text search index from current document_metadata + OCR text files. " +
      "Run after a bulk metadata change, after import_database, or when full_text_search reports staleness.",
    {},
    async () => {
      const result = metadata.rebuildFts();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "export_database",
    "Export the metadata DB to a file. format='sqlite' (default) produces an atomic, compacted SQLite file via VACUUM INTO — recommended for backups. " +
      "format='json' produces a portable JSON dump of the document_metadata + suppliers tables. Returns the absolute path + size + per-table row counts.",
    {
      output_path: z
        .string()
        .describe(
          "Where to write the dump. Created if missing. For format='sqlite', any existing file is overwritten.",
        ),
      format: z
        .enum(["sqlite", "json"])
        .default("sqlite")
        .describe("Output format. 'sqlite' = binary backup; 'json' = portable text dump."),
    },
    async ({ output_path, format }) => {
      const expanded = output_path.startsWith("~/")
        ? `${homedir()}/${output_path.slice(2)}`
        : isAbsolute(output_path)
        ? output_path
        : resolve(process.cwd(), output_path);
      if (format === "sqlite") {
        const r = metadata.exportSqlite(expanded);
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      }
      const json = metadata.exportJson();
      await mkdir(dirname(expanded), { recursive: true });
      const text = JSON.stringify(json, null, 2);
      await Bun.write(expanded, text);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                format: "json",
                path: expanded,
                bytes: text.length,
                tables: Object.fromEntries(
                  Object.entries(json.tables).map(([k, v]) => [k, (v as unknown[]).length]),
                ),
                schema_version: json.schema_version,
                exported_at: json.exported_at,
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
    "import_database",
    "Restore or merge into the metadata DB. Provide EITHER `input_path` (file " +
      "already on the server's filesystem; format auto-detected from extension) " +
      "OR `input_base64` (inline upload — required when calling the deployed " +
      "HTTP server from a remote client). For inline uploads pass `format` " +
      "explicitly. Binary restore CLOSES and REPLACES the live DB. JSON import " +
      "respects the `mode` flag.",
    {
      input_path: z
        .string()
        .optional()
        .describe(
          "Path to a dump file already on the server's filesystem. Mutually exclusive with input_base64.",
        ),
      input_base64: z
        .string()
        .optional()
        .describe(
          "Base64-encoded dump content. Use when uploading from a remote client. Requires `format`.",
        ),
      format: z
        .enum(["sqlite", "json"])
        .optional()
        .describe(
          "Required when using input_base64. Auto-detected from extension when using input_path.",
        ),
      mode: z
        .enum(["replace", "merge"])
        .default("merge")
        .describe(
          "Only applies to JSON imports. 'replace' truncates each table before insert; 'merge' uses INSERT OR REPLACE per row.",
        ),
    },
    async ({ input_path, input_base64, format, mode }) => {
      if (!input_path && !input_base64) {
        throw new Error("Provide either input_path or input_base64.");
      }
      if (input_path && input_base64) {
        throw new Error("Provide only one of input_path or input_base64.");
      }

      // Resolve to a usable file on disk + a known format.
      let onDisk: string;
      let resolvedFormat: "sqlite" | "json";
      let cleanup: (() => Promise<void>) | null = null;

      if (input_path) {
        onDisk = input_path.startsWith("~/")
          ? `${homedir()}/${input_path.slice(2)}`
          : isAbsolute(input_path)
          ? input_path
          : resolve(process.cwd(), input_path);
        resolvedFormat = format ?? (/\.json$/i.test(onDisk) ? "json" : "sqlite");
      } else {
        if (!format) {
          throw new Error("`format` is required when using input_base64.");
        }
        resolvedFormat = format;
        const bytes = Buffer.from(input_base64!, "base64");
        const tmpDir = `${process.cwd()}/data/.imports`;
        await mkdir(tmpDir, { recursive: true });
        onDisk = `${tmpDir}/upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${resolvedFormat === "json" ? "json" : "db"}`;
        await Bun.write(onDisk, bytes);
        cleanup = async () => {
          try { await Bun.file(onDisk).unlink(); } catch { /* */ }
        };
      }

      try {
        if (resolvedFormat === "json") {
          const text = await Bun.file(onDisk).text();
          const data = JSON.parse(text) as { tables: Record<string, unknown[]> };
          const r = metadata.importJson(data, mode);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ format: "json", mode, ...r }, null, 2),
              },
            ],
          };
        }
        const r = metadata.restoreSqlite(onDisk);
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      } finally {
        if (cleanup) await cleanup();
      }
    },
  );

  server.tool(
    "metadata_stats",
    "Aggregate counts across the curated metadata DB: total annotated docs, breakdown by doc_type, top suppliers, breakdown by target_classeur. Useful to gauge progress building the parallel filesystem.",
    {},
    async () => {
      return {
        content: [{ type: "text", text: JSON.stringify(metadata.stats(), null, 2) }],
      };
    },
  );

  return server;
}
