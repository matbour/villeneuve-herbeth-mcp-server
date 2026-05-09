#!/usr/bin/env bun
/**
 * Generate target_filename for split-out child documents.
 *
 * After scripts/split-multi-docs.ts creates child rows and the OCR +
 * reextract passes populate their per-doc metadata, this script fills in
 * a sensible target_filename per child so they can be materialized.
 *
 * Usage:
 *   bun scripts/finalize-children.ts
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { MetadataStore, type MetadataInput } from "../src/metadata.ts";

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

const FORBIDDEN = /[\\/:*?"<>|]/g;
function safeFs(s: string): string {
  return s.replace(FORBIDDEN, "-").replace(/\s+/g, " ").trim();
}

const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");
const store = new MetadataStore(dbPath);

const db = new Database(dbPath, { readwrite: true });
const rows = db
  .query<
    {
      document_id: number;
      doc_type: string | null;
      target_classeur: string | null;
      target_filename: string | null;
      supplier: string | null;
      document_date: string | null;
      period_start: string | null;
      period_end: string | null;
      reference: string | null;
      parent_document_id: number | null;
      parent_page_range: string | null;
      amount_cents: number | null;
    },
    []
  >(
    `SELECT document_id, doc_type, target_classeur, target_filename, supplier,
            document_date, period_start, period_end, reference,
            parent_document_id, parent_page_range, amount_cents
     FROM document_metadata
     WHERE parent_document_id IS NOT NULL`,
  )
  .all();
db.close();

console.log(`${rows.length} child rows to finalize`);

let updated = 0;
let skipped = 0;
let unknown = 0;

for (const r of rows) {
  if (r.target_filename) {
    skipped++;
    continue;
  }

  const parts: string[] = [];

  // Date prefix: prefer document_date, fall back to period_end
  const date = r.document_date ?? r.period_end ?? null;
  if (date) parts.push(date);

  // Type-specific body
  if (r.doc_type === "invoice") {
    parts.push("Facture");
    if (r.supplier) parts.push(r.supplier);
    if (r.reference) parts.push(`Réf ${r.reference}`);
    if (r.amount_cents) {
      const eur = (r.amount_cents / 100).toFixed(2).replace(".", ",");
      parts.push(`${eur} €`);
    }
  } else if (r.doc_type === "bank_statement") {
    parts.push("Relevé bancaire BPALC");
    if (r.reference) parts.push(`n°${r.reference}`);
  } else if (r.doc_type === "meeting_minutes") {
    parts.push("PV Assemblée Générale");
  } else if (r.doc_type === "contract") {
    parts.push("Contrat");
    if (r.supplier) parts.push(r.supplier);
  } else if (r.doc_type) {
    parts.push(r.doc_type);
  }

  // Append parent info to ensure traceability
  if (r.parent_document_id && r.parent_page_range) {
    parts.push(`(extrait p.${r.parent_page_range} de #${r.parent_document_id})`);
  }

  if (parts.length === 0) {
    unknown++;
    continue;
  }

  const filename = `${safeFs(parts.join(" - "))}.pdf`;
  const update: MetadataInput = {
    document_id: r.document_id,
    target_filename: filename,
  };
  store.upsert(update);
  updated++;
}

store.close();

console.log(`\n=== Done ===`);
console.log(`  updated:          ${updated}`);
console.log(`  already had name: ${skipped}`);
console.log(`  unknown / empty:  ${unknown}`);
