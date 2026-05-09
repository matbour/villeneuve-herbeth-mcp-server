import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export const DOC_TYPES = [
  "invoice",
  "quote",
  "quote_acceptance_letter",
  "contract",
  "meeting_minutes",
  "meeting_convocation",
  "annual_accounts",
  "bank_statement",
  "regulation",
  "plan",
  "registration_form",
  "owner_list",
  "cost_allocation_keys",
  "letter",
  "report",
  "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface DocumentMetadata {
  document_id: number;
  doc_type: string | null;
  title: string | null;
  classeur_id: number | null;
  target_classeur: string | null;
  target_filename: string | null;
  supplier: string | null;
  amount_cents: number | null;
  amount_ht_cents: number | null;
  vat_cents: number | null;
  currency: string | null;
  document_date: string | null;
  period_start: string | null;
  period_end: string | null;
  reference: string | null;
  language: string | null;
  tags: string[];
  notes: string | null;
  extra: Record<string, unknown> | null;
  source_file_name: string | null;
  source_title: string | null;
  source_classeur_id: number | null;
  source_date_commit: string | null;
  source_md5: string | null;
  parent_document_id: number | null;
  parent_page_range: string | null;
  ocr_status: string | null;
  ocr_text_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetadataInput {
  document_id: number;
  doc_type?: string | null;
  title?: string | null;
  classeur_id?: number | null;
  target_classeur?: string | null;
  target_filename?: string | null;
  supplier?: string | null;
  amount_cents?: number | null;
  amount_ht_cents?: number | null;
  vat_cents?: number | null;
  currency?: string | null;
  document_date?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  reference?: string | null;
  language?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  extra?: Record<string, unknown> | null;
  source_file_name?: string | null;
  source_title?: string | null;
  source_classeur_id?: number | null;
  source_date_commit?: string | null;
  source_md5?: string | null;
  parent_document_id?: number | null;
  parent_page_range?: string | null;
  ocr_status?: string | null;
  ocr_text_path?: string | null;
}

export interface SupplierEntry {
  id: number;
  canonical_name: string;
  pattern: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface SearchFilters {
  text?: string;
  doc_type?: string;
  supplier?: string;
  tag?: string;
  classeur_id?: number;
  target_classeur?: string;
  reference?: string;
  document_date_from?: string;
  document_date_to?: string;
  amount_min_cents?: number;
  amount_max_cents?: number;
  limit?: number;
}

interface Row {
  document_id: number;
  doc_type: string | null;
  title: string | null;
  classeur_id: number | null;
  target_classeur: string | null;
  target_filename: string | null;
  supplier: string | null;
  amount_cents: number | null;
  amount_ht_cents: number | null;
  vat_cents: number | null;
  currency: string | null;
  document_date: string | null;
  period_start: string | null;
  period_end: string | null;
  reference: string | null;
  language: string | null;
  tags: string | null;
  notes: string | null;
  extra: string | null;
  source_file_name: string | null;
  source_title: string | null;
  source_classeur_id: number | null;
  source_date_commit: string | null;
  source_md5: string | null;
  parent_document_id: number | null;
  parent_page_range: string | null;
  ocr_status: string | null;
  ocr_text_path: string | null;
  created_at: string;
  updated_at: string;
}

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function rowToMetadata(row: Row): DocumentMetadata {
  return {
    document_id: row.document_id,
    doc_type: row.doc_type,
    title: row.title,
    classeur_id: row.classeur_id,
    target_classeur: row.target_classeur,
    target_filename: row.target_filename,
    supplier: row.supplier,
    amount_cents: row.amount_cents,
    amount_ht_cents: row.amount_ht_cents,
    vat_cents: row.vat_cents,
    currency: row.currency,
    document_date: row.document_date,
    period_start: row.period_start,
    period_end: row.period_end,
    reference: row.reference,
    language: row.language,
    tags: parseTags(row.tags),
    notes: row.notes,
    extra: parseJsonObject(row.extra),
    source_file_name: row.source_file_name,
    source_title: row.source_title,
    source_classeur_id: row.source_classeur_id,
    source_date_commit: row.source_date_commit,
    source_md5: row.source_md5,
    parent_document_id: row.parent_document_id,
    parent_page_range: row.parent_page_range,
    ocr_status: row.ocr_status,
    ocr_text_path: row.ocr_text_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MetadataStore {
  private db: Database;
  private readonly resolvedPath: string;

  constructor(dbPath: string) {
    this.resolvedPath = expandPath(dbPath);
    mkdirSync(dirname(this.resolvedPath), { recursive: true });
    this.db = new Database(this.resolvedPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /** Path to the on-disk SQLite file. */
  path(): string {
    return this.resolvedPath;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_metadata (
        document_id        INTEGER PRIMARY KEY,
        title              TEXT,
        classeur_id        INTEGER,
        supplier           TEXT,
        amount_cents       INTEGER,
        currency           TEXT,
        document_date      TEXT,
        tags               TEXT,
        notes              TEXT,
        source_file_name   TEXT,
        source_title       TEXT,
        source_classeur_id INTEGER,
        source_date_commit TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_doc_meta_classeur ON document_metadata(classeur_id);
      CREATE INDEX IF NOT EXISTS idx_doc_meta_supplier ON document_metadata(supplier);
      CREATE INDEX IF NOT EXISTS idx_doc_meta_date ON document_metadata(document_date);
    `);

    const version =
      (this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0);

    const addCol = (col: string, type: string) => {
      const cols = this.db
        .query<{ name: string }, []>("PRAGMA table_info(document_metadata)")
        .all()
        .map((r) => r.name);
      if (!cols.includes(col)) {
        this.db.exec(`ALTER TABLE document_metadata ADD COLUMN ${col} ${type}`);
      }
    };

    if (version < 2) {
      addCol("doc_type", "TEXT");
      addCol("target_classeur", "TEXT");
      addCol("target_filename", "TEXT");
      addCol("amount_ht_cents", "INTEGER");
      addCol("vat_cents", "INTEGER");
      addCol("period_start", "TEXT");
      addCol("period_end", "TEXT");
      addCol("reference", "TEXT");
      addCol("language", "TEXT");
      addCol("extra", "TEXT");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_meta_type ON document_metadata(doc_type)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_meta_target ON document_metadata(target_classeur)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_meta_reference ON document_metadata(reference)",
      );
      this.db.exec("PRAGMA user_version = 2");
    }

    if (version < 3) {
      addCol("source_md5", "TEXT");
      addCol("parent_document_id", "INTEGER");
      addCol("parent_page_range", "TEXT");
      addCol("ocr_status", "TEXT");
      addCol("ocr_text_path", "TEXT");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_meta_md5 ON document_metadata(source_md5)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_meta_parent ON document_metadata(parent_document_id)",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_meta_ocr_status ON document_metadata(ocr_status)",
      );
      this.db.exec("PRAGMA user_version = 3");
    }

    if (version < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_name  TEXT NOT NULL,
          pattern         TEXT NOT NULL,
          priority        INTEGER NOT NULL DEFAULT 100,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(canonical_name, pattern)
        );
        CREATE INDEX IF NOT EXISTS idx_suppliers_priority ON suppliers(priority);
        CREATE INDEX IF NOT EXISTS idx_suppliers_canonical ON suppliers(canonical_name);
      `);
      this.db.exec("PRAGMA user_version = 4");
    }

    if (version < 5) {
      // FTS5 virtual table for full-text search over metadata + OCR body.
      // Populated on demand via rebuildFts(); not auto-synced (we'd otherwise
      // pay the cost of reading OCR text on every upsert).
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
          document_id UNINDEXED,
          title,
          notes,
          supplier,
          source_title,
          source_file_name,
          reference,
          target_classeur,
          target_filename,
          ocr_text,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
      this.db.exec("PRAGMA user_version = 5");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Suppliers table
  // ──────────────────────────────────────────────────────────────────────────

  listSuppliers(): SupplierEntry[] {
    return this.db
      .query<SupplierEntry, []>(
        "SELECT id, canonical_name, pattern, priority, created_at, updated_at FROM suppliers ORDER BY priority ASC, canonical_name ASC",
      )
      .all();
  }

  addSupplier(input: { canonical_name: string; pattern: string; priority?: number }): SupplierEntry {
    const priority = input.priority ?? 100;
    this.db
      .query(
        `INSERT INTO suppliers (canonical_name, pattern, priority)
         VALUES (?, ?, ?)
         ON CONFLICT(canonical_name, pattern) DO UPDATE SET
           priority = excluded.priority,
           updated_at = datetime('now')`,
      )
      .run(input.canonical_name, input.pattern, priority);
    const row = this.db
      .query<SupplierEntry, [string, string]>(
        "SELECT id, canonical_name, pattern, priority, created_at, updated_at FROM suppliers WHERE canonical_name = ? AND pattern = ?",
      )
      .get(input.canonical_name, input.pattern);
    if (!row) throw new Error("addSupplier: failed to read back row");
    return row;
  }

  deleteSupplier(id: number): boolean {
    return this.db.query("DELETE FROM suppliers WHERE id = ?").run(id).changes > 0;
  }

  /** Try to canonicalize a raw supplier prefix using stored regex patterns. */
  canonicalizeSupplier(rawPrefix: string): string | null {
    const trimmed = rawPrefix.trim();
    if (!trimmed) return null;
    for (const s of this.listSuppliers()) {
      try {
        const re = new RegExp(s.pattern, "i");
        if (re.test(trimmed)) return s.canonical_name;
      } catch {
        /* skip invalid pattern */
      }
    }
    return null;
  }

  get(documentId: number): DocumentMetadata | null {
    const row = this.db
      .query<Row, [number]>("SELECT * FROM document_metadata WHERE document_id = ?")
      .get(documentId);
    return row ? rowToMetadata(row) : null;
  }

  getMany(documentIds: number[]): Map<number, DocumentMetadata> {
    const out = new Map<number, DocumentMetadata>();
    if (documentIds.length === 0) return out;
    const placeholders = documentIds.map(() => "?").join(",");
    const rows = this.db
      .query<Row, number[]>(
        `SELECT * FROM document_metadata WHERE document_id IN (${placeholders})`,
      )
      .all(...documentIds);
    for (const row of rows) out.set(row.document_id, rowToMetadata(row));
    return out;
  }

  upsert(input: MetadataInput): DocumentMetadata {
    const existing = this.get(input.document_id);
    const pick = <T>(
      value: T | null | undefined,
      fallback: T | null | undefined,
    ): T | null => {
      if (value !== undefined) return value ?? null;
      return fallback ?? null;
    };

    const merged = {
      doc_type: pick(input.doc_type, existing?.doc_type),
      title: pick(input.title, existing?.title),
      classeur_id: pick(input.classeur_id, existing?.classeur_id),
      target_classeur: pick(input.target_classeur, existing?.target_classeur),
      target_filename: pick(input.target_filename, existing?.target_filename),
      supplier: pick(input.supplier, existing?.supplier),
      amount_cents: pick(input.amount_cents, existing?.amount_cents),
      amount_ht_cents: pick(input.amount_ht_cents, existing?.amount_ht_cents),
      vat_cents: pick(input.vat_cents, existing?.vat_cents),
      currency: pick(input.currency, existing?.currency),
      document_date: pick(input.document_date, existing?.document_date),
      period_start: pick(input.period_start, existing?.period_start),
      period_end: pick(input.period_end, existing?.period_end),
      reference: pick(input.reference, existing?.reference),
      language: pick(input.language, existing?.language),
      tags: pick(input.tags, existing?.tags),
      notes: pick(input.notes, existing?.notes),
      extra: pick(input.extra, existing?.extra),
      source_file_name: pick(input.source_file_name, existing?.source_file_name),
      source_title: pick(input.source_title, existing?.source_title),
      source_classeur_id: pick(input.source_classeur_id, existing?.source_classeur_id),
      source_date_commit: pick(input.source_date_commit, existing?.source_date_commit),
      source_md5: pick(input.source_md5, existing?.source_md5),
      parent_document_id: pick(input.parent_document_id, existing?.parent_document_id),
      parent_page_range: pick(input.parent_page_range, existing?.parent_page_range),
      ocr_status: pick(input.ocr_status, existing?.ocr_status),
      ocr_text_path: pick(input.ocr_text_path, existing?.ocr_text_path),
    };

    const tagsJson =
      merged.tags && merged.tags.length > 0 ? JSON.stringify(merged.tags) : null;
    const extraJson =
      merged.extra && Object.keys(merged.extra).length > 0
        ? JSON.stringify(merged.extra)
        : null;

    this.db
      .query(
        `
        INSERT INTO document_metadata (
          document_id, doc_type, title, classeur_id, target_classeur, target_filename,
          supplier, amount_cents, amount_ht_cents, vat_cents, currency,
          document_date, period_start, period_end, reference, language,
          tags, notes, extra,
          source_file_name, source_title, source_classeur_id, source_date_commit,
          source_md5, parent_document_id, parent_page_range, ocr_status, ocr_text_path,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                datetime('now'), datetime('now'))
        ON CONFLICT(document_id) DO UPDATE SET
          doc_type           = excluded.doc_type,
          title              = excluded.title,
          classeur_id        = excluded.classeur_id,
          target_classeur    = excluded.target_classeur,
          target_filename    = excluded.target_filename,
          supplier           = excluded.supplier,
          amount_cents       = excluded.amount_cents,
          amount_ht_cents    = excluded.amount_ht_cents,
          vat_cents          = excluded.vat_cents,
          currency           = excluded.currency,
          document_date      = excluded.document_date,
          period_start       = excluded.period_start,
          period_end         = excluded.period_end,
          reference          = excluded.reference,
          language           = excluded.language,
          tags               = excluded.tags,
          notes              = excluded.notes,
          extra              = excluded.extra,
          source_file_name   = excluded.source_file_name,
          source_title       = excluded.source_title,
          source_classeur_id = excluded.source_classeur_id,
          source_date_commit = excluded.source_date_commit,
          source_md5         = excluded.source_md5,
          parent_document_id = excluded.parent_document_id,
          parent_page_range  = excluded.parent_page_range,
          ocr_status         = excluded.ocr_status,
          ocr_text_path      = excluded.ocr_text_path,
          updated_at         = datetime('now')
        `,
      )
      .run(
        input.document_id,
        merged.doc_type,
        merged.title,
        merged.classeur_id,
        merged.target_classeur,
        merged.target_filename,
        merged.supplier,
        merged.amount_cents,
        merged.amount_ht_cents,
        merged.vat_cents,
        merged.currency,
        merged.document_date,
        merged.period_start,
        merged.period_end,
        merged.reference,
        merged.language,
        tagsJson,
        merged.notes,
        extraJson,
        merged.source_file_name,
        merged.source_title,
        merged.source_classeur_id,
        merged.source_date_commit,
        merged.source_md5,
        merged.parent_document_id,
        merged.parent_page_range,
        merged.ocr_status,
        merged.ocr_text_path,
      );

    const result = this.get(input.document_id);
    if (!result) throw new Error(`Failed to upsert document ${input.document_id}`);
    return result;
  }

  delete(documentId: number): boolean {
    const result = this.db
      .query("DELETE FROM document_metadata WHERE document_id = ?")
      .run(documentId);
    return result.changes > 0;
  }

  search(filters: SearchFilters): DocumentMetadata[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filters.text) {
      where.push(
        "(title LIKE ? OR notes LIKE ? OR supplier LIKE ? OR source_file_name LIKE ? OR reference LIKE ?)",
      );
      const pattern = `%${filters.text}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (filters.doc_type) {
      where.push("doc_type = ?");
      params.push(filters.doc_type);
    }
    if (filters.supplier) {
      where.push("supplier = ?");
      params.push(filters.supplier);
    }
    if (filters.tag) {
      where.push("tags LIKE ?");
      params.push(`%${JSON.stringify(filters.tag).slice(1, -1)}%`);
    }
    if (filters.classeur_id !== undefined) {
      where.push("classeur_id = ?");
      params.push(filters.classeur_id);
    }
    if (filters.target_classeur) {
      where.push("target_classeur = ?");
      params.push(filters.target_classeur);
    }
    if (filters.reference) {
      where.push("reference = ?");
      params.push(filters.reference);
    }
    if (filters.document_date_from) {
      where.push("document_date >= ?");
      params.push(filters.document_date_from);
    }
    if (filters.document_date_to) {
      where.push("document_date <= ?");
      params.push(filters.document_date_to);
    }
    if (filters.amount_min_cents !== undefined) {
      where.push("amount_cents >= ?");
      params.push(filters.amount_min_cents);
    }
    if (filters.amount_max_cents !== undefined) {
      where.push("amount_cents <= ?");
      params.push(filters.amount_max_cents);
    }

    const sql =
      "SELECT * FROM document_metadata" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY document_date DESC NULLS LAST, updated_at DESC" +
      ` LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}`;

    const rows = this.db.query<Row, (string | number)[]>(sql).all(...params);
    return rows.map(rowToMetadata);
  }

  stats(): {
    total: number;
    by_doc_type: { doc_type: string | null; count: number }[];
    by_supplier: { supplier: string | null; count: number }[];
    by_target_classeur: { target_classeur: string | null; count: number }[];
  } {
    const total =
      this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM document_metadata").get()?.c ??
      0;
    const by_doc_type = this.db
      .query<{ doc_type: string | null; count: number }, []>(
        "SELECT doc_type, COUNT(*) as count FROM document_metadata GROUP BY doc_type ORDER BY count DESC",
      )
      .all();
    const by_supplier = this.db
      .query<{ supplier: string | null; count: number }, []>(
        "SELECT supplier, COUNT(*) as count FROM document_metadata WHERE supplier IS NOT NULL GROUP BY supplier ORDER BY count DESC LIMIT 50",
      )
      .all();
    const by_target_classeur = this.db
      .query<{ target_classeur: string | null; count: number }, []>(
        "SELECT target_classeur, COUNT(*) as count FROM document_metadata WHERE target_classeur IS NOT NULL GROUP BY target_classeur ORDER BY count DESC",
      )
      .all();
    return { total, by_doc_type, by_supplier, by_target_classeur };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Export / import
  // ──────────────────────────────────────────────────────────────────────────

  /** Atomic binary export via VACUUM INTO. Safe with the DB still open;
   *  the resulting file is a fully self-contained, compacted SQLite database. */
  exportSqlite(targetPath: string): { format: "sqlite"; path: string; bytes: number; tables: Record<string, number> } {
    const resolved = expandPath(targetPath);
    mkdirSync(dirname(resolved), { recursive: true });
    // VACUUM INTO refuses to overwrite an existing file
    if (existsSync(resolved)) rmSync(resolved);
    this.db.exec(`VACUUM INTO '${resolved.replace(/'/g, "''")}'`);
    return {
      format: "sqlite",
      path: resolved,
      bytes: statSync(resolved).size,
      tables: this.tableCounts(),
    };
  }

  /** Restore the live DB from a binary SQLite file. Closes and re-opens. */
  restoreSqlite(sourcePath: string): { restored_from: string; bytes: number; tables: Record<string, number> } {
    const resolved = expandPath(sourcePath);
    if (!existsSync(resolved)) throw new Error(`No such file: ${resolved}`);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    copyFileSync(resolved, this.resolvedPath);
    // Drop any leftover -wal / -shm sidecars from the old DB so the freshly
    // copied file is read in isolation.
    for (const ext of ["-wal", "-shm"]) {
      const sidecar = `${this.resolvedPath}${ext}`;
      if (existsSync(sidecar)) rmSync(sidecar);
    }
    this.db = new Database(this.resolvedPath, { readwrite: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    return {
      restored_from: resolved,
      bytes: statSync(this.resolvedPath).size,
      tables: this.tableCounts(),
    };
  }

  /** Dump the DB as a plain JSON object (lossless for our schema). */
  exportJson(): {
    format: "json";
    schema_version: number;
    exported_at: string;
    tables: Record<string, unknown[]>;
  } {
    const v =
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0;
    return {
      format: "json",
      schema_version: v,
      exported_at: new Date().toISOString(),
      tables: {
        document_metadata: this.db
          .query("SELECT * FROM document_metadata")
          .all() as unknown[],
        suppliers: this.db.query("SELECT * FROM suppliers").all() as unknown[],
      },
    };
  }

  /** Import a JSON dump produced by exportJson(). mode='replace' truncates
   *  before insert; mode='merge' uses INSERT OR REPLACE on each row. */
  importJson(
    data: { tables: Record<string, unknown[]> },
    mode: "replace" | "merge" = "merge",
  ): { tables: Record<string, number> } {
    const counts: Record<string, number> = {};
    const importTables = (tables: Record<string, unknown[]>) => {
      for (const [tableName, rows] of Object.entries(tables)) {
        if (tableName !== "document_metadata" && tableName !== "suppliers") continue;
        if (mode === "replace") this.db.exec(`DELETE FROM ${tableName}`);
        let count = 0;
        for (const r of rows) {
          const row = r as Record<string, unknown>;
          const cols = Object.keys(row);
          const placeholders = cols.map(() => "?").join(",");
          const values = cols.map((c) => row[c] as unknown) as never[];
          this.db
            .query(
              `INSERT OR REPLACE INTO ${tableName} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders})`,
            )
            .run(...values);
          count++;
        }
        counts[tableName] = count;
      }
    };
    const tx = this.db.transaction(importTables);
    tx(data.tables);
    return { tables: counts };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Full-text search
  // ──────────────────────────────────────────────────────────────────────────

  /** Re-build the FTS5 index from current document_metadata + OCR text files. */
  rebuildFts(): { indexed: number; ocr_loaded: number; ocr_missing: number } {
    this.db.exec("DELETE FROM document_search");
    const rows = this.db
      .query<
        {
          document_id: number;
          title: string | null;
          notes: string | null;
          supplier: string | null;
          source_title: string | null;
          source_file_name: string | null;
          reference: string | null;
          target_classeur: string | null;
          target_filename: string | null;
          ocr_text_path: string | null;
        },
        []
      >(
        `SELECT document_id, title, notes, supplier, source_title, source_file_name,
                reference, target_classeur, target_filename, ocr_text_path
         FROM document_metadata`,
      )
      .all();
    let ocrLoaded = 0;
    let ocrMissing = 0;
    const insert = this.db.prepare<unknown, [number, string, string, string, string, string, string, string, string, string]>(
      `INSERT INTO document_search (
        document_id, title, notes, supplier, source_title, source_file_name,
        reference, target_classeur, target_filename, ocr_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ingestAll = this.db.transaction(() => {
      for (const r of rows) {
        let ocrText = "";
        if (r.ocr_text_path) {
          try {
            ocrText = readFileSync(r.ocr_text_path, "utf8");
            ocrLoaded++;
          } catch {
            ocrMissing++;
          }
        }
        insert.run(
          r.document_id,
          r.title ?? "",
          r.notes ?? "",
          r.supplier ?? "",
          r.source_title ?? "",
          r.source_file_name ?? "",
          r.reference ?? "",
          r.target_classeur ?? "",
          r.target_filename ?? "",
          ocrText,
        );
      }
    });
    ingestAll();
    return { indexed: rows.length, ocr_loaded: ocrLoaded, ocr_missing: ocrMissing };
  }

  /** FTS5 query. Accepts standard fts5 query syntax (e.g. "FZ NETTOYAGE",
   *  "Lavéran NEAR/5 garage", '"126-128 Strasbourg"', "supplier:ATHOME").
   *  Returns the matched documents with their full metadata + a snippet. */
  searchFts(
    query: string,
    options: { limit?: number; columns?: string[] } = {},
  ): Array<DocumentMetadata & { snippet: string; rank: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    // snippet(table, col_index, prefix, suffix, ellipsis, max_tokens)
    const sql = `
      SELECT s.document_id AS doc_id,
             snippet(document_search, -1, '«', '»', ' … ', 16) AS snippet,
             bm25(document_search) AS rank
      FROM document_search s
      WHERE document_search MATCH ?
      ORDER BY rank
      LIMIT ${limit}
    `;
    const hits = this.db
      .query<{ doc_id: number; snippet: string; rank: number }, [string]>(sql)
      .all(query);
    const out: Array<DocumentMetadata & { snippet: string; rank: number }> = [];
    for (const h of hits) {
      const meta = this.get(h.doc_id);
      if (!meta) continue;
      out.push({ ...meta, snippet: h.snippet, rank: h.rank });
    }
    return out;
  }

  private tableCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of ["document_metadata", "suppliers", "document_search"]) {
      try {
        out[t] = this.db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${t}`).get()?.c ?? 0;
      } catch { /* table missing pre-migration */ }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
