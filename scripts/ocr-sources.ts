#!/usr/bin/env bun
/**
 * Run ocrmypdf + pdftotext over every PDF in <artifacts>/sources/.
 * Produces:
 *   <artifacts>/ocr/<md5>__<original>     — searchable PDF (OCR layer added)
 *   <artifacts>/text/<md5>.txt             — plain text extracted via pdftotext -layout
 *
 * For each row in document_metadata that points at a source MD5, sets
 *   ocr_status     = 'done' | 'failed' | 'skipped'
 *   ocr_text_path  = absolute path to the .txt file (when done)
 *
 * Idempotent: skips work whose outputs already exist on disk.
 *
 * Usage:
 *   bun scripts/ocr-sources.ts [artifacts_dir] [--concurrency=N]
 *
 * Default artifacts_dir = ./data/artifacts
 * Default concurrency  = 2
 */
import { Database } from "bun:sqlite";
import { mkdir, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";

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
const OCR_DIR = expandPath(positional[1] ?? "./data/ocr");
const TEXT_DIR = expandPath(positional[2] ?? "./data/text");
const CONCURRENCY = Number(flags.concurrency ?? 2);
const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

console.log(`Sources:    ${SOURCES_DIR}`);
console.log(`OCR:        ${OCR_DIR}`);
console.log(`Text:       ${TEXT_DIR}`);
console.log(`DB:         ${dbPath}`);
console.log(`Concurrency: ${CONCURRENCY}`);

await mkdir(OCR_DIR, { recursive: true });
await mkdir(TEXT_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface CmdResult {
  ok: boolean;
  code: number | null;
  stderr: string;
  signal: NodeJS.Signals | null;
}

function run(cmd: string, args: string[], timeoutMs = 600_000): Promise<CmdResult> {
  return new Promise((resolveProm) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveProm({ ok: code === 0, code, stderr, signal });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveProm({ ok: false, code: null, stderr: err.message, signal: null });
    });
  });
}

// ocrmypdf exit codes:
//   0 = ok, OCR added
//   6 = file already had text and --skip-text was set → fine
//   8 = input is encrypted / damaged → mark failed
function ocrSucceeded(r: CmdResult): "done" | "skipped" | "failed" {
  if (r.code === 0) return "done";
  if (r.code === 6) return "skipped";
  return "failed";
}

// ────────────────────────────────────────────────────────────────────────────
// Discover files
// ────────────────────────────────────────────────────────────────────────────

const sourceFiles = (await readdir(SOURCES_DIR)).filter((f) => /\.pdf$/i.test(f));
console.log(`${sourceFiles.length} source files to process`);

interface Job {
  source: string;       // basename in sources/
  md5: string;
  ocrPath: string;
  textPath: string;
}
const jobs: Job[] = [];
for (const f of sourceFiles) {
  const md5 = f.split("__")[0];
  if (!md5 || md5.length !== 32) continue;
  jobs.push({
    source: f,
    md5,
    ocrPath: `${OCR_DIR}/${f}`,
    textPath: `${TEXT_DIR}/${md5}.txt`,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Process
// ────────────────────────────────────────────────────────────────────────────

const db = new Database(dbPath, { readwrite: true });
db.exec("PRAGMA journal_mode = WAL");
const updateOcr = db.prepare<unknown, [string, string | null, string]>(
  "UPDATE document_metadata SET ocr_status = ?, ocr_text_path = ?, updated_at = datetime('now') WHERE source_md5 = ?",
);

let ocrDone = 0;
let ocrSkipped = 0;
let ocrFailed = 0;
let textExtracted = 0;
let alreadyDone = 0;

/** Probe a PDF for an existing text layer. Returns the extracted text. */
async function probeText(pdfPath: string): Promise<string> {
  const tmp = `${pdfPath}.probe.txt`;
  const r = await run(
    "pdftotext",
    ["-layout", "-enc", "UTF-8", pdfPath, tmp],
    60_000,
  );
  if (!r.ok || !existsSync(tmp)) return "";
  try {
    return await Bun.file(tmp).text();
  } finally {
    try { await Bun.file(tmp).unlink(); } catch { /* */ }
  }
}

/** Heuristic: treat a PDF as text-native if pdftotext yields enough non-whitespace chars per page. */
async function pdfHasTextLayer(pdfPath: string): Promise<{ hasText: boolean; text: string }> {
  const text = await probeText(pdfPath);
  const meaningful = text.replace(/\s+/g, "").length;
  // ~150 non-whitespace chars total is a low bar but rules out empty / one-line scans.
  // Many invoices have several hundred chars per page; a 1-page form has ~50-100.
  // Be generous: if >150 chars, consider it text-native.
  return { hasText: meaningful >= 150, text };
}

async function processOne(job: Job): Promise<void> {
  const sourcePath = `${SOURCES_DIR}/${job.source}`;

  // Short-circuit: if both outputs already exist, mark done.
  if (existsSync(job.ocrPath) && existsSync(job.textPath) && statSync(job.textPath).size > 0) {
    alreadyDone++;
    updateOcr.run("done", job.textPath, job.md5);
    return;
  }

  // 1. Probe for an existing text layer.
  const probe = await pdfHasTextLayer(sourcePath);

  if (probe.hasText) {
    // Text-native PDF — no OCR needed. Just cache the text and link the source.
    if (!existsSync(job.textPath) || statSync(job.textPath).size === 0) {
      await Bun.write(job.textPath, probe.text);
      textExtracted++;
    }
    if (!existsSync(job.ocrPath)) {
      // Symlink the original as the "OCR'd" PDF for downstream tools that expect one.
      await Bun.write(job.ocrPath, Bun.file(sourcePath));
    }
    ocrSkipped++;
    updateOcr.run("skipped", job.textPath, job.md5);
    return;
  }

  // 2. PDF is a scan — run OCR.
  if (!existsSync(job.ocrPath)) {
    const r = await run(
      "ocrmypdf",
      [
        "--language", "fra+eng",
        "--skip-text",
        "--output-type", "pdf",
        "--rotate-pages",
        "--deskew",
        "--quiet",
        sourcePath,
        job.ocrPath,
      ],
      600_000,
    );
    const state = ocrSucceeded(r);
    if (state === "failed") {
      ocrFailed++;
      console.error(`  ✗ ocr failed [${r.code}]: ${job.source}`);
      if (r.stderr.length < 600) console.error(`    ${r.stderr.trim()}`);
      updateOcr.run("failed", null, job.md5);
      return;
    }
    ocrDone++;
  }

  // 3. Re-extract text from the OCR'd PDF.
  if (!existsSync(job.textPath) || statSync(job.textPath).size === 0) {
    const r = await run(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", job.ocrPath, job.textPath],
      120_000,
    );
    if (!r.ok) {
      console.error(`  ✗ pdftotext failed: ${job.source}\n    ${r.stderr.trim().slice(0, 300)}`);
      updateOcr.run("failed", null, job.md5);
      return;
    }
    textExtracted++;
  }

  updateOcr.run("done", job.textPath, job.md5);
}

// Worker pool
const queue = [...jobs];
async function worker(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) return;
    try {
      await processOne(job);
    } catch (err) {
      console.error(`  ✗ unexpected: ${job.source}: ${(err as Error).message}`);
      updateOcr.run("failed", null, job.md5);
    }
    const total = ocrDone + ocrSkipped + ocrFailed + alreadyDone;
    if (total % 10 === 0) {
      console.log(
        `  progress: ${total}/${jobs.length} (ocr=${ocrDone} skipped=${ocrSkipped} alreadyDone=${alreadyDone} failed=${ocrFailed} text=${textExtracted})`,
      );
    }
  }
}
const workers: Promise<void>[] = [];
for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
await Promise.all(workers);

db.close();

console.log(`\n=== Done ===`);
console.log(`  jobs:                  ${jobs.length}`);
console.log(`  OCR added:             ${ocrDone}`);
console.log(`  OCR skipped (had text): ${ocrSkipped}`);
console.log(`  OCR already on disk:   ${alreadyDone}`);
console.log(`  OCR failed:            ${ocrFailed}`);
console.log(`  text extracted now:    ${textExtracted}`);
