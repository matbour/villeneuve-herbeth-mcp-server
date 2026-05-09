#!/usr/bin/env bun
/**
 * Materialize the parallel filesystem from curated metadata.
 *
 * Walks every row in the metadata DB and downloads the source document into
 *   <output_dir>/<target_classeur>/<target_filename>
 *
 * Idempotent: skips files already on disk. Detects (and avoids) cross-doc
 * filename collisions by appending the source document_id to the filename
 * when two different docs would otherwise land at the same path.
 *
 * Usage:
 *   bun scripts/materialize-fs.ts [output_dir]
 *
 * Default output_dir: ~/Downloads/Villeneuve - Copropriété
 */
import { Database } from "bun:sqlite";
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

const argDir = Bun.argv[2];
const OUTPUT_DIR = expandPath(argDir ?? "~/Downloads/Villeneuve - Copropriété");
const CONCURRENCY = 4;
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

console.log(`DB: ${dbPath}`);
console.log(`Output: ${OUTPUT_DIR}`);
await mkdir(OUTPUT_DIR, { recursive: true });

const client = new HerbethClient(username, password);

const raw = new Database(dbPath, { readonly: true });
const rows = raw
  .query<
    { document_id: number; target_classeur: string; target_filename: string },
    []
  >(
    `SELECT document_id, target_classeur, target_filename
     FROM document_metadata
     WHERE target_classeur IS NOT NULL AND target_filename IS NOT NULL
     ORDER BY target_classeur, target_filename, document_id`,
  )
  .all();
raw.close();

console.log(`${rows.length} docs to materialize`);

// Detect path collisions across rows (different docs → same path); disambiguate by id.
const planned: Array<{ document_id: number; path: string }> = [];
const usedPaths = new Map<string, number>();
for (const r of rows) {
  let path = `${OUTPUT_DIR}/${r.target_classeur}/${r.target_filename}`;
  if (usedPaths.has(path)) {
    const dot = r.target_filename.lastIndexOf(".");
    const stem = dot >= 0 ? r.target_filename.slice(0, dot) : r.target_filename;
    const ext = dot >= 0 ? r.target_filename.slice(dot) : ".pdf";
    path = `${OUTPUT_DIR}/${r.target_classeur}/${stem} - id${r.document_id}${ext}`;
  }
  usedPaths.set(path, r.document_id);
  planned.push({ document_id: r.document_id, path });
}

let done = 0;
let skipped = 0;
let failed = 0;

async function materializeOne(item: typeof planned[number]): Promise<void> {
  if (existsSync(item.path)) {
    skipped++;
    return;
  }
  try {
    const { bytes } = await client.downloadFile(item.document_id);
    const dir = item.path.slice(0, item.path.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await Bun.write(item.path, bytes);
    done++;
  } catch (err) {
    failed++;
    console.error(`✗ ${item.document_id} → ${item.path}: ${(err as Error).message}`);
  }
}

const queue = [...planned];
const workers: Promise<void>[] = [];
async function worker(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) return;
    await materializeOne(item);
    const total = done + skipped + failed;
    if (total % 25 === 0) {
      console.log(
        `  progress: ${total}/${planned.length} (downloaded ${done}, skipped ${skipped}, failed ${failed})`,
      );
    }
  }
}
for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
await Promise.all(workers);

console.log(`\n=== Done ===`);
console.log(`  downloaded: ${done}`);
console.log(`  skipped (already on disk): ${skipped}`);
console.log(`  failed: ${failed}`);
