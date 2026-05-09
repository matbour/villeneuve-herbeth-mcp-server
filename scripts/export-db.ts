#!/usr/bin/env bun
/**
 * Dump the metadata DB to a backup file.
 *
 * Usage:
 *   bun scripts/export-db.ts <output_path> [--format=sqlite|json]
 *
 * Defaults: format=sqlite (atomic VACUUM INTO).
 */
import { MetadataStore } from "../src/metadata.ts";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

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
const outputPath = positional[0];
if (!outputPath) {
  console.error("Usage: bun scripts/export-db.ts <output_path> [--format=sqlite|json]");
  process.exit(1);
}
const format = (flags.format ?? "sqlite") as "sqlite" | "json";

function expand(p: string): string {
  const x = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(x) ? x : resolve(process.cwd(), x);
}
const target = expand(outputPath);

const store = new MetadataStore(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");
if (format === "sqlite") {
  console.log(JSON.stringify(store.exportSqlite(target), null, 2));
} else {
  const json = store.exportJson();
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, JSON.stringify(json, null, 2));
  console.log(JSON.stringify({
    format: "json",
    path: target,
    schema_version: json.schema_version,
    exported_at: json.exported_at,
    tables: Object.fromEntries(
      Object.entries(json.tables).map(([k, v]) => [k, (v as unknown[]).length]),
    ),
  }, null, 2));
}
store.close();
