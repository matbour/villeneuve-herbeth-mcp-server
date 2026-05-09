#!/usr/bin/env bun
/**
 * Strip " (N)" disambiguation suffixes from existing target_filename values.
 *
 * The bulk-annotate pass added "(1)" / "(2)" / etc to the filename when
 * multiple docs shared the same (date, supplier, description). The user
 * prefers no such suffixes — materialize-fs handles real filename
 * collisions on its own (by appending "- id<N>" only when needed).
 *
 * Usage:
 *   bun scripts/strip-suffix.ts [--dry-run]
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

const DRY_RUN = Bun.argv.includes("--dry-run");
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

const db = new Database(dbPath, { readwrite: true });
const rows = db
  .query<{ document_id: number; target_filename: string }, []>(
    "SELECT document_id, target_filename FROM document_metadata WHERE target_filename LIKE '%(%)%'",
  )
  .all();

let updated = 0;
const update = db.prepare<unknown, [string, number]>(
  "UPDATE document_metadata SET target_filename = ?, updated_at = datetime('now') WHERE document_id = ?",
);

const SUFFIX = /\s+\(\d+\)(?=\.[A-Za-z0-9]+$)/g;
for (const r of rows) {
  const next = r.target_filename.replace(SUFFIX, "");
  if (next === r.target_filename) continue;
  if (DRY_RUN) {
    console.log(`[dry] ${r.document_id}: ${r.target_filename} → ${next}`);
  } else {
    update.run(next, r.document_id);
  }
  updated++;
}

db.close();
console.log(`\n${DRY_RUN ? "would update" : "updated"} ${updated} rows`);
