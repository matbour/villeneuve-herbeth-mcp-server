#!/usr/bin/env bun
/**
 * Merge contract + validation-email pairs into a single PDF.
 *
 * Many extranet uploads come as TWO docs with identical (title, date,
 * classeur): the substantive document (contract / devis / quote) plus a
 * short syndic letter that validates / accepts it. The user wants these
 * stitched back together with the substantive doc first and the validation
 * letter as an annex.
 *
 * Detection (size-2 groups only — larger groups are skipped):
 *   group docs by (source_title, source_date_commit, source_classeur_id)
 *   filter to groups with exactly 2 unmerged, unsplit docs
 *   choose the "validation" doc by content + length:
 *     - shorter OCR text
 *     - matches a known acceptance/letter pattern ("DEVIS ACCEPTE",
 *       "Bon pour accord", Cabinet Herbeth signature)
 *
 * Output:
 *   ./data/sources/<merged_md5>__<title>.merged.pdf
 *   New row in document_metadata with a synthetic id (>= 10_000_000_000)
 *     - parent_document_id = null (it's a top-level merged doc)
 *     - extra.merged_from = [id_main, id_validation]
 *   Originals get extra.merged_into = <new_id> so materialize-fs skips them.
 *
 * Usage:
 *   bun scripts/merge-pairs.ts [--dry-run]
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
const DRY_RUN = args.includes("--dry-run");

const SOURCES_DIR = expandPath("./data/sources");
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

console.log(`Sources: ${SOURCES_DIR}`);
console.log(`DB:      ${dbPath}`);
if (DRY_RUN) console.log(`(dry-run)`);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = /[\\/:*?"<>| ]/g;
function safeFs(s: string): string { return s.replace(FORBIDDEN, "_"); }

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => res({ ok: code === 0, stderr }));
    child.on("error", (err) => res({ ok: false, stderr: err.message }));
  });
}

const VALIDATION_MARKERS = [
  /DEVIS\s+ACCEPT[ÉE]/i,
  /\bBON\s+POUR\s+ACCORD\b/i,
  /Cabinet\s+Herbeth\s+Immobilier/,
  /votre\s+entreprise\s+a\s+été\s+retenue/i,
  /nous\s+avons\s+le\s+plaisir\s+de\s+vous\s+informer/i,
  /service\s+syndic/i,
];

function validationScore(text: string): number {
  let score = 0;
  for (const re of VALIDATION_MARKERS) if (re.test(text)) score++;
  return score;
}

// ────────────────────────────────────────────────────────────────────────────
// Discover candidate pairs
// ────────────────────────────────────────────────────────────────────────────

const store = new MetadataStore(dbPath);
const db = new Database(dbPath, { readwrite: true });

interface CandidateRow {
  document_id: number;
  source_title: string | null;
  source_date_commit: string | null;
  source_classeur_id: number | null;
  source_md5: string | null;
  source_file_name: string | null;
  ocr_text_path: string | null;
  doc_type: string | null;
  target_classeur: string | null;
  extra: string | null;
}

const all = db
  .query<CandidateRow, []>(
    `SELECT document_id, source_title, source_date_commit, source_classeur_id,
            source_md5, source_file_name, ocr_text_path, doc_type, target_classeur, extra
     FROM document_metadata
     WHERE parent_document_id IS NULL
       AND source_md5 IS NOT NULL
       AND source_title IS NOT NULL
       AND source_date_commit IS NOT NULL
       AND source_classeur_id IS NOT NULL`,
  )
  .all();

// Group rows
const groups = new Map<string, CandidateRow[]>();
for (const r of all) {
  const key = `${r.source_classeur_id}|${r.source_date_commit}|${(r.source_title ?? "").trim().toLowerCase()}`;
  let arr = groups.get(key);
  if (!arr) { arr = []; groups.set(key, arr); }
  arr.push(r);
}

// Only merge doc types where we expect a "main + validation letter" pattern.
// Bank statements (paired compte courant / livret), invoices, etc. are
// duplicates of a different nature — leave them alone.
const MERGEABLE_TYPES = new Set([
  "contract",
  "quote",
  "quote_acceptance_letter",
  "letter",
  "report",
]);

const pairs: CandidateRow[][] = [];
for (const [, arr] of groups) {
  // Skip already-merged or already-split rows
  const live = arr.filter((r) => {
    if (!r.extra) return true;
    try {
      const ex = JSON.parse(r.extra) as Record<string, unknown>;
      return ex.merged_into == null && ex.split == null;
    } catch { return true; }
  });
  if (live.length !== 2) continue;
  // At least one of the two must be a mergeable type.
  if (!live.some((r) => r.doc_type && MERGEABLE_TYPES.has(r.doc_type))) continue;
  pairs.push(live);
}

console.log(`${all.length} live top-level rows, ${groups.size} unique (title,date,classeur) keys, ${pairs.length} size-2 candidate pairs`);

// ────────────────────────────────────────────────────────────────────────────
// Merge each pair
// ────────────────────────────────────────────────────────────────────────────

let nextSyntheticId = 10_000_000_000;
const maxRow = db
  .query<{ m: number | null }, []>(
    "SELECT MAX(document_id) m FROM document_metadata WHERE document_id >= 10000000000",
  )
  .get();
if (maxRow?.m && maxRow.m >= nextSyntheticId) nextSyntheticId = maxRow.m + 1;

let mergedCount = 0;
let skippedCount = 0;
let unresolved = 0;

for (const pair of pairs) {
  const [a, b] = pair as [CandidateRow, CandidateRow];

  // Need OCR text for both to score
  if (!a.ocr_text_path || !existsSync(a.ocr_text_path) ||
      !b.ocr_text_path || !existsSync(b.ocr_text_path)) {
    unresolved++;
    continue;
  }
  const textA = readFileSync(a.ocr_text_path, "utf8");
  const textB = readFileSync(b.ocr_text_path, "utf8");

  const scoreA = validationScore(textA);
  const scoreB = validationScore(textB);
  // Validation = stronger marker score, breaking ties by shorter text length.
  let main: CandidateRow, validation: CandidateRow;
  if (scoreA > scoreB) { validation = a; main = b; }
  else if (scoreB > scoreA) { validation = b; main = a; }
  else if (textA.length < textB.length) { validation = a; main = b; }
  else { validation = b; main = a; }

  // If neither doc looks like a validation letter (both score 0 and similar
  // length), skip — they may be two-page-each invoices or unrelated dups.
  if (scoreA === 0 && scoreB === 0 && Math.abs(textA.length - textB.length) < 200) {
    skippedCount++;
    continue;
  }

  const mainSrc = `${SOURCES_DIR}/${main.source_md5}__${safeFs(main.source_file_name ?? "doc.pdf")}`;
  const valSrc = `${SOURCES_DIR}/${validation.source_md5}__${safeFs(validation.source_file_name ?? "doc.pdf")}`;
  if (!existsSync(mainSrc) || !existsSync(valSrc)) {
    unresolved++;
    continue;
  }

  const mergedTmp = `${SOURCES_DIR}/.merge.${main.document_id}.${validation.document_id}.tmp.pdf`;
  console.log(
    `\n[merge] ${main.source_title?.trim()} (${main.source_date_commit?.slice(0, 10)} cl.${main.source_classeur_id})\n` +
    `  main:       ${main.document_id} (score ${scoreA === scoreB ? "tie" : main === a ? scoreA : scoreB}, ${textA === (main === a ? textA : textB) ? textA.length : textB.length} chars)\n` +
    `  validation: ${validation.document_id} (score ${main === a ? scoreB : scoreA})`,
  );

  if (DRY_RUN) {
    mergedCount++;
    continue;
  }

  const r = await run("qpdf", ["--empty", "--pages", mainSrc, valSrc, "--", mergedTmp]);
  if (!r.ok) {
    console.error(`  ✗ qpdf merge failed: ${r.stderr.trim().slice(0, 300)}`);
    unresolved++;
    continue;
  }

  const bytes = readFileSync(mergedTmp);
  const md5 = createHash("md5").update(bytes).digest("hex");
  // source_file_name is stored unprefixed; the on-disk mirror at <SOURCES_DIR>
  // uses "<md5>__<source_file_name>".
  const sourceFileName = `${(main.source_file_name ?? "doc").replace(/\.pdf$/i, "")}.merged.pdf`;
  const finalPath = `${SOURCES_DIR}/${md5}__${safeFs(sourceFileName)}`;
  if (!existsSync(finalPath)) await Bun.write(finalPath, bytes);
  try { await Bun.file(mergedTmp).unlink(); } catch { /* */ }

  // Inherit main's target_filename, but strip any " (N)" suffix the
  // bulk-annotate added to disambiguate duplicates — the merged doc replaces
  // the duplicates so the suffix is no longer meaningful.
  const stripSuffix = (s: string | null | undefined): string | null =>
    s ? s.replace(/\s+\(\d+\)(?=\.[A-Za-z0-9]+$)/g, "") : null;
  const mainRow = db
    .query<{ target_filename: string | null }, [number]>(
      "SELECT target_filename FROM document_metadata WHERE document_id = ?",
    )
    .get(main.document_id);
  const mergedFilename = stripSuffix(mainRow?.target_filename ?? null);

  const newId = nextSyntheticId++;
  const mergedRow: MetadataInput = {
    document_id: newId,
    doc_type: main.doc_type ?? validation.doc_type,
    target_classeur: main.target_classeur ?? validation.target_classeur,
    target_filename: mergedFilename,
    source_md5: md5,
    source_file_name: sourceFileName,
    source_classeur_id: main.source_classeur_id,
    source_title: main.source_title,
    source_date_commit: main.source_date_commit,
    extra: { merged_from: [main.document_id, validation.document_id] },
  };
  store.upsert(mergedRow);

  // Mark both originals as merged-into
  for (const orig of [main, validation]) {
    let parsedExtra: Record<string, unknown> = {};
    if (orig.extra) {
      try { parsedExtra = JSON.parse(orig.extra) as Record<string, unknown>; } catch { /* */ }
    }
    store.upsert({
      document_id: orig.document_id,
      extra: { ...parsedExtra, merged_into: newId },
    });
  }

  mergedCount++;
}

db.close();
store.close();

console.log(`\n=== Done ===`);
console.log(`  candidate pairs: ${pairs.length}`);
console.log(`  merged:          ${mergedCount}`);
console.log(`  skipped (no validation marker): ${skippedCount}`);
console.log(`  unresolved (missing files):     ${unresolved}`);
