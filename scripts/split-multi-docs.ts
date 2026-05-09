#!/usr/bin/env bun
/**
 * Detect multi-document PDFs from OCR text and split them with qpdf.
 *
 * Detection heuristics per parent doc_type:
 *   invoice         → count occurrences of "FACTURE" / "Facture N°" headers
 *                     across pages; a page that starts a new invoice opens
 *                     a new child range.
 *   bank_statement  → count occurrences of "Votre relevé de compte n°X au
 *                     DD/MM/YYYY" or "RELEVE N° X AU DD/MM/YYYY".
 *   meeting_minutes → typically single doc; no split.
 *   contract        → typically single doc; no split.
 *
 * For each detected child:
 *   - run qpdf to extract the page range to data/sources/<child_md5>__<orig>.split.<n>.pdf
 *   - compute child MD5
 *   - insert a new row in document_metadata with:
 *       document_id        = synthetic negative id derived from parent + n
 *       parent_document_id = parent's id
 *       parent_page_range  = "P1-P2"
 *       source_md5         = child MD5
 *       source_file_name   = "<parent original>.split.<n>.pdf"
 *       doc_type           = parent's doc_type
 *
 * Synthetic negative IDs avoid colliding with real extranet doc_ids.
 *
 * Usage:
 *   bun scripts/split-multi-docs.ts [--dry-run]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { MetadataStore, type MetadataInput } from "../src/metadata.ts";

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

const args = Bun.argv.slice(2);
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq < 0 ? [a.slice(2), "true"] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const DRY_RUN = flags["dry-run"] === "true";

const SOURCES_DIR = expandPath("./data/sources");
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

console.log(`Sources: ${SOURCES_DIR}`);
console.log(`DB:      ${dbPath}`);
if (DRY_RUN) console.log(`(dry-run; no files will be written, no rows inserted)`);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolveProm) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolveProm({ ok: code === 0, stderr }));
    child.on("error", (err) => resolveProm({ ok: false, stderr: err.message }));
  });
}

interface DetectedChild {
  page_start: number;
  page_end: number;
  marker?: string;
}

/** Pages are separated by form-feed (\f) in pdftotext output. */
function splitByFormFeed(text: string): string[] {
  return text.split(/\f/);
}

const INVOICE_HEADERS = [
  /\bFACTURE\b/,
  /\bFacture\s*N[°ºo]/i,
  /\bF\s*N[°º]\s*[A-Z0-9]/,
];
const BANK_HEADERS = [
  /relev[ée]\s*de\s*compte\s*n[°ºo]\s*\d+/i,
  /RELEVE\s+N[°ºo]\s+\d+\s+AU\s+\d{1,2}/,
];

function detectInvoiceChildren(pages: string[]): DetectedChild[] {
  const starts: number[] = [];
  pages.forEach((page, idx) => {
    const head = page.slice(0, 600); // top of page is where header lives
    if (INVOICE_HEADERS.some((re) => re.test(head))) starts.push(idx + 1);
  });
  if (starts.length <= 1) return [];
  const children: DetectedChild[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : pages.length;
    children.push({ page_start: start, page_end: end });
  }
  return children;
}

function detectBankChildren(pages: string[]): DetectedChild[] {
  const starts: number[] = [];
  pages.forEach((page, idx) => {
    const head = page.slice(0, 800);
    if (BANK_HEADERS.some((re) => re.test(head))) starts.push(idx + 1);
  });
  if (starts.length <= 1) return [];
  const children: DetectedChild[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : pages.length;
    children.push({ page_start: start, page_end: end });
  }
  return children;
}

function detectChildrenForType(docType: string | null, pages: string[]): DetectedChild[] {
  switch (docType) {
    case "invoice":
      return detectInvoiceChildren(pages);
    case "bank_statement":
      return detectBankChildren(pages);
    default:
      return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────────────

const store = new MetadataStore(dbPath);
const db = new Database(dbPath, { readwrite: true });
const rows = db
  .query<
    {
      document_id: number;
      doc_type: string | null;
      ocr_text_path: string | null;
      source_file_name: string | null;
      source_md5: string | null;
      target_classeur: string | null;
    },
    []
  >(
    `SELECT document_id, doc_type, ocr_text_path, source_file_name, source_md5, target_classeur
     FROM document_metadata
     WHERE parent_document_id IS NULL
       AND ocr_text_path IS NOT NULL
       AND source_md5 IS NOT NULL
     ORDER BY document_id`,
  )
  .all();
db.close();

console.log(`${rows.length} candidate parents`);

let inspected = 0;
let multiFound = 0;
let childrenCreated = 0;
let parentsTagged = 0;

for (const parent of rows) {
  if (!parent.ocr_text_path || !existsSync(parent.ocr_text_path)) continue;
  inspected++;
  const text = readFileSync(parent.ocr_text_path, "utf8");
  const pages = splitByFormFeed(text);
  if (pages.length <= 1) continue;
  const children = detectChildrenForType(parent.doc_type, pages);
  if (children.length === 0) continue;

  multiFound++;
  console.log(
    `\nMulti-doc detected: ${parent.document_id} (${parent.doc_type}, ${pages.length} pages, ${children.length} children)`,
  );
  for (const c of children) {
    console.log(`  → pages ${c.page_start}-${c.page_end}`);
  }
  if (DRY_RUN) continue;

  // Find the source PDF
  const sourcePath = `${SOURCES_DIR}/${parent.source_md5}__${(parent.source_file_name ?? "").replace(/[\\/:*?"<>| ]/g, "_")}`;
  if (!existsSync(sourcePath)) {
    console.warn(`    ⚠ source missing: ${sourcePath}`);
    continue;
  }

  let n = 0;
  for (const c of children) {
    n++;
    const childOut = `${sourcePath}.split.${n}.pdf`;
    if (!existsSync(childOut)) {
      const r = await run("qpdf", [
        sourcePath,
        "--pages",
        sourcePath,
        `${c.page_start}-${c.page_end}`,
        "--",
        childOut,
      ]);
      if (!r.ok) {
        console.error(`    ✗ qpdf failed for pages ${c.page_start}-${c.page_end}: ${r.stderr.trim()}`);
        continue;
      }
    }
    const childBytes = readFileSync(childOut);
    const childMd5 = createHash("md5").update(childBytes).digest("hex");
    // Move child to canonical location: data/sources/<md5>__<original>.split.N.pdf
    const childCanonical = `${SOURCES_DIR}/${childMd5}__${(parent.source_file_name ?? "doc").replace(/[\\/:*?"<>| ]/g, "_")}.split.${n}.pdf`;
    if (!existsSync(childCanonical)) {
      await Bun.write(childCanonical, childBytes);
    }
    try { await Bun.file(childOut).unlink(); } catch { /* */ }

    const childId = -(parent.document_id * 100 + n); // synthetic negative id
    const childRow: MetadataInput = {
      document_id: childId,
      parent_document_id: parent.document_id,
      parent_page_range: `${c.page_start}-${c.page_end}`,
      source_md5: childMd5,
      source_file_name: `${parent.source_file_name ?? "doc"}.split.${n}.pdf`,
      source_classeur_id: null,
      doc_type: parent.doc_type,
      target_classeur: parent.target_classeur,
      // Children inherit until reextract pass updates them
    };
    store.upsert(childRow);
    childrenCreated++;
  }

  // Tag the parent so we know it's been split
  store.upsert({
    document_id: parent.document_id,
    extra: {
      // merged with existing extra
      split: { children: children.length, at: new Date().toISOString() },
    },
  });
  parentsTagged++;
}

store.close();

console.log(`\n=== Done ===`);
console.log(`  parents inspected:  ${inspected}`);
console.log(`  multi-doc detected: ${multiFound}`);
console.log(`  children created:   ${childrenCreated}`);
console.log(`  parents tagged:     ${parentsTagged}`);
