#!/usr/bin/env bun
/**
 * Materialize the curated parallel filesystem from the metadata DB +
 * the local source mirror.
 *
 *   <output_dir>/<target_classeur>/<target_filename>   ← copy of the source PDF
 *
 * Source PDFs are read from ./data/sources/<md5>__<original_filename>.
 * Run scripts/download-sources.ts first to populate the mirror.
 *
 * Idempotent. Detects cross-doc filename collisions (different docs that
 * would land at the same path) and disambiguates by appending the source
 * document_id to the filename.
 *
 * Usage:
 *   bun scripts/materialize-fs.ts [output_dir] [sources_dir]
 *
 * Defaults: output_dir=./data/output, sources_dir=./data/sources
 */
import { Database } from "bun:sqlite";
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

const FORBIDDEN = /[\\/:*?"<>| ]/g;
function safeFs(s: string): string {
  return s.replace(FORBIDDEN, "_");
}

const OUTPUT_DIR = expandPath(Bun.argv[2] ?? "./data/output");
const SOURCES_DIR = expandPath(Bun.argv[3] ?? "./data/sources");
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

console.log(`Output:   ${OUTPUT_DIR}`);
console.log(`Sources:  ${SOURCES_DIR}`);
console.log(`DB:       ${dbPath}`);
await mkdir(OUTPUT_DIR, { recursive: true });

const db = new Database(dbPath, { readonly: true });
// Skip parents that have been split into children — the children replace them.
// Detected via extra.split presence (set by split-multi-docs.ts).
const rows = db
  .query<
    {
      document_id: number;
      target_classeur: string;
      target_filename: string;
      source_file_name: string | null;
      source_md5: string | null;
    },
    []
  >(
    `SELECT document_id, target_classeur, target_filename, source_file_name, source_md5
     FROM document_metadata
     WHERE target_classeur IS NOT NULL AND target_filename IS NOT NULL
       AND source_md5 IS NOT NULL
       AND (extra IS NULL OR json_extract(extra, '$.split') IS NULL)
     ORDER BY target_classeur, target_filename, document_id`,
  )
  .all();
db.close();

console.log(`${rows.length} docs to materialize`);
const skippedNoMd5 = (() => {
  const all = new Database(dbPath, { readonly: true })
    .query<{ c: number }, []>(
      "SELECT COUNT(*) c FROM document_metadata WHERE target_classeur IS NOT NULL AND target_filename IS NOT NULL AND source_md5 IS NULL",
    )
    .get();
  return all?.c ?? 0;
})();
if (skippedNoMd5 > 0) {
  console.warn(
    `  ⚠ ${skippedNoMd5} docs have target_filename but no source_md5 — run download-sources.ts first.`,
  );
}

interface PlannedItem {
  document_id: number;
  source: string;
  dest: string;
}
const planned: PlannedItem[] = [];
const usedDest = new Map<string, number>();
let unresolved = 0;

for (const r of rows) {
  if (!r.source_md5 || !r.source_file_name) {
    unresolved++;
    continue;
  }
  const source = `${SOURCES_DIR}/${r.source_md5}__${safeFs(r.source_file_name)}`;
  if (!existsSync(source)) {
    unresolved++;
    if (unresolved <= 5) console.warn(`  ⚠ source missing: ${source}`);
    continue;
  }
  let dest = `${OUTPUT_DIR}/${r.target_classeur}/${r.target_filename}`;
  if (usedDest.has(dest)) {
    const dot = r.target_filename.lastIndexOf(".");
    const stem = dot >= 0 ? r.target_filename.slice(0, dot) : r.target_filename;
    const ext = dot >= 0 ? r.target_filename.slice(dot) : ".pdf";
    dest = `${OUTPUT_DIR}/${r.target_classeur}/${stem} - id${r.document_id}${ext}`;
  }
  usedDest.set(dest, r.document_id);
  planned.push({ document_id: r.document_id, source, dest });
}

let copied = 0;
let alreadyThere = 0;
let failed = 0;

for (const item of planned) {
  if (existsSync(item.dest)) {
    alreadyThere++;
    continue;
  }
  try {
    const dir = item.dest.slice(0, item.dest.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await copyFile(item.source, item.dest);
    copied++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${item.document_id}: ${(err as Error).message}`);
  }
  const total = copied + alreadyThere + failed;
  if (total % 50 === 0) {
    console.log(
      `  progress: ${total}/${planned.length} (copied=${copied} already=${alreadyThere} failed=${failed})`,
    );
  }
}

console.log(`\n=== Done ===`);
console.log(`  planned:           ${planned.length}`);
console.log(`  copied:            ${copied}`);
console.log(`  already on disk:   ${alreadyThere}`);
console.log(`  failed:            ${failed}`);
console.log(`  unresolved (no source/md5 missing): ${unresolved}`);
