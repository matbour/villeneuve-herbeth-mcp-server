#!/usr/bin/env bun
/**
 * Restore or merge into the metadata DB from a previous export.
 * Auto-detects format from the file extension.
 *
 * Usage:
 *   bun scripts/import-db.ts <input_path> [--mode=replace|merge]
 *
 * Mode applies only to JSON imports. Binary .db / .sqlite restores
 * always REPLACE the live DB (closes + copies + reopens).
 */
import { MetadataStore } from "../src/metadata.ts";
import { isAbsolute, resolve } from "node:path";
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
const inputPath = positional[0];
if (!inputPath) {
  console.error("Usage: bun scripts/import-db.ts <input_path> [--mode=replace|merge]");
  process.exit(1);
}
const mode = (flags.mode ?? "merge") as "replace" | "merge";

function expand(p: string): string {
  const x = p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(x) ? x : resolve(process.cwd(), x);
}
const source = expand(inputPath);

const store = new MetadataStore(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");
if (/\.json$/i.test(source)) {
  const text = await Bun.file(source).text();
  const data = JSON.parse(text) as { tables: Record<string, unknown[]> };
  console.log(JSON.stringify({ format: "json", mode, ...store.importJson(data, mode) }, null, 2));
} else {
  console.log(JSON.stringify(store.restoreSqlite(source), null, 2));
}
store.close();
