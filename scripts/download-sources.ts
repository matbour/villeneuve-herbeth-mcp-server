#!/usr/bin/env bun
/**
 * Download every annotated document from the extranet into ./data/sources/,
 * keeping the *original* extranet filename (prefixed by MD5 for traceback &
 * dedup), and populate document_metadata.source_md5.
 *
 * Layout:
 *   ./data/sources/<md5>__<original_filename>
 *
 * Idempotent: skips downloads when (md5, file) is already on disk. If
 * source_md5 isn't yet known for a row, the script downloads, hashes, then
 * stores the path.
 *
 * Usage:
 *   bun scripts/download-sources.ts [sources_dir] [--concurrency=N]
 *
 * Defaults: sources_dir=./data/sources, concurrency=4
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { HerbethClient } from "../src/client.ts";

const username = Bun.env.HERBETH_USERNAME;
const password = Bun.env.HERBETH_PASSWORD;
if (!username || !password) {
  console.error("Missing HERBETH_USERNAME / HERBETH_PASSWORD");
  process.exit(1);
}

function expandPath(p: string): string {
  const expanded = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

const args = Bun.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq < 0 ? [a.slice(2), "true"] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

const SOURCES_DIR = expandPath(positional[0] ?? "./data/sources");
const CONCURRENCY = Number(flags.concurrency ?? 4);
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

console.log(`Sources:    ${SOURCES_DIR}`);
console.log(`DB:         ${dbPath}`);
console.log(`Concurrency: ${CONCURRENCY}`);
await mkdir(SOURCES_DIR, { recursive: true });

const FORBIDDEN = /[\\/:*?"<>| ]/g;
function safeFs(s: string): string {
  return s.replace(FORBIDDEN, "_");
}

const client = new HerbethClient(username, password);
const db = new Database(dbPath, { readwrite: true });
db.exec("PRAGMA journal_mode = WAL");

interface RowMin {
  document_id: number;
  source_file_name: string | null;
  source_md5: string | null;
  parent_document_id: number | null;
}

const rows = db
  .query<RowMin, []>(
    `SELECT document_id, source_file_name, source_md5, parent_document_id
     FROM document_metadata
     WHERE parent_document_id IS NULL
     ORDER BY document_id`,
  )
  .all();
console.log(`${rows.length} top-level docs to download`);

const update = db.prepare<unknown, [string, number]>(
  "UPDATE document_metadata SET source_md5 = ?, updated_at = datetime('now') WHERE document_id = ?",
);

let downloaded = 0;
let alreadyOnDisk = 0;
let failed = 0;

async function processOne(row: RowMin): Promise<void> {
  // If MD5 already known and the corresponding file exists, skip.
  if (row.source_md5) {
    const orig = row.source_file_name ?? `document-${row.document_id}.pdf`;
    const candidate = `${SOURCES_DIR}/${row.source_md5}__${safeFs(orig)}`;
    if (existsSync(candidate)) {
      alreadyOnDisk++;
      return;
    }
  }

  try {
    const { bytes, filename } = await client.downloadFile(row.document_id);
    const md5 = createHash("md5").update(bytes).digest("hex");
    const original =
      filename ?? row.source_file_name ?? `document-${row.document_id}.pdf`;
    const dest = `${SOURCES_DIR}/${md5}__${safeFs(original)}`;
    if (!existsSync(dest)) {
      await Bun.write(dest, bytes);
      downloaded++;
    } else {
      alreadyOnDisk++;
    }
    update.run(md5, row.document_id);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${row.document_id}: ${(err as Error).message}`);
  }
}

const queue = [...rows];
async function worker(): Promise<void> {
  while (queue.length > 0) {
    const row = queue.shift();
    if (!row) return;
    await processOne(row);
    const total = downloaded + alreadyOnDisk + failed;
    if (total % 25 === 0) {
      console.log(
        `  progress: ${total}/${rows.length} (downloaded=${downloaded} on-disk=${alreadyOnDisk} failed=${failed})`,
      );
    }
  }
}
const workers: Promise<void>[] = [];
for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
await Promise.all(workers);

db.close();

console.log(`\n=== Done ===`);
console.log(`  downloaded:    ${downloaded}`);
console.log(`  already on disk: ${alreadyOnDisk}`);
console.log(`  failed:        ${failed}`);
