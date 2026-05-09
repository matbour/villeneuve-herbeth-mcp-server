import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export interface DocumentMetadata {
  document_id: number;
  title: string | null;
  classeur_id: number | null;
  supplier: string | null;
  amount_cents: number | null;
  currency: string | null;
  document_date: string | null;
  tags: string[];
  notes: string | null;
  source_file_name: string | null;
  source_title: string | null;
  source_classeur_id: number | null;
  source_date_commit: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetadataInput {
  document_id: number;
  title?: string | null;
  classeur_id?: number | null;
  supplier?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  document_date?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  source_file_name?: string | null;
  source_title?: string | null;
  source_classeur_id?: number | null;
  source_date_commit?: string | null;
}

export interface SearchFilters {
  text?: string;
  supplier?: string;
  tag?: string;
  classeur_id?: number;
  document_date_from?: string;
  document_date_to?: string;
  amount_min_cents?: number;
  amount_max_cents?: number;
  limit?: number;
}

interface Row {
  document_id: number;
  title: string | null;
  classeur_id: number | null;
  supplier: string | null;
  amount_cents: number | null;
  currency: string | null;
  document_date: string | null;
  tags: string | null;
  notes: string | null;
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

function rowToMetadata(row: Row): DocumentMetadata {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      tags = [];
    }
  }
  return {
    document_id: row.document_id,
    title: row.title,
    classeur_id: row.classeur_id,
    supplier: row.supplier,
    amount_cents: row.amount_cents,
    currency: row.currency,
    document_date: row.document_date,
    tags,
    notes: row.notes,
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
    const merged = {
      title: input.title !== undefined ? input.title : existing?.title ?? null,
      classeur_id:
        input.classeur_id !== undefined ? input.classeur_id : existing?.classeur_id ?? null,
      supplier: input.supplier !== undefined ? input.supplier : existing?.supplier ?? null,
      amount_cents:
        input.amount_cents !== undefined ? input.amount_cents : existing?.amount_cents ?? null,
      currency: input.currency !== undefined ? input.currency : existing?.currency ?? null,
      document_date:
        input.document_date !== undefined
          ? input.document_date
          : existing?.document_date ?? null,
      tags: input.tags !== undefined ? input.tags : existing?.tags ?? null,
      notes: input.notes !== undefined ? input.notes : existing?.notes ?? null,
      source_file_name:
        input.source_file_name !== undefined
          ? input.source_file_name
          : existing?.source_file_name ?? null,
      source_title:
        input.source_title !== undefined ? input.source_title : existing?.source_title ?? null,
      source_classeur_id:
        input.source_classeur_id !== undefined
          ? input.source_classeur_id
          : existing?.source_classeur_id ?? null,
      source_date_commit:
        input.source_date_commit !== undefined
          ? input.source_date_commit
          : existing?.source_date_commit ?? null,
    };

    const tagsJson = merged.tags && merged.tags.length > 0 ? JSON.stringify(merged.tags) : null;

    this.db
      .query(
        `
        INSERT INTO document_metadata (
          document_id, title, classeur_id, supplier, amount_cents, currency,
          document_date, tags, notes, source_file_name, source_title,
          source_classeur_id, source_date_commit, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(document_id) DO UPDATE SET
          title              = excluded.title,
          classeur_id        = excluded.classeur_id,
          supplier           = excluded.supplier,
          amount_cents       = excluded.amount_cents,
          currency           = excluded.currency,
          document_date      = excluded.document_date,
          tags               = excluded.tags,
          notes              = excluded.notes,
          source_file_name   = excluded.source_file_name,
          source_title       = excluded.source_title,
          source_classeur_id = excluded.source_classeur_id,
          source_date_commit = excluded.source_date_commit,
          updated_at         = datetime('now')
        `,
      )
      .run(
        input.document_id,
        merged.title,
        merged.classeur_id,
        merged.supplier,
        merged.amount_cents,
        merged.currency,
        merged.document_date,
        tagsJson,
        merged.notes,
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
      where.push("(title LIKE ? OR notes LIKE ? OR supplier LIKE ? OR source_file_name LIKE ?)");
      const pattern = `%${filters.text}%`;
      params.push(pattern, pattern, pattern, pattern);
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

  close(): void {
    this.db.close();
  }
}
