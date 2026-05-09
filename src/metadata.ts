import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MetadataStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    const resolved = expandPath(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
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

    if (version < 2) {
      const existing = this.db
        .query<{ name: string }, []>("PRAGMA table_info(document_metadata)")
        .all()
        .map((r) => r.name);
      const addCol = (col: string, type: string) => {
        if (!existing.includes(col)) {
          this.db.exec(`ALTER TABLE document_metadata ADD COLUMN ${col} ${type}`);
        }
      };
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
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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

  close(): void {
    this.db.close();
  }
}
