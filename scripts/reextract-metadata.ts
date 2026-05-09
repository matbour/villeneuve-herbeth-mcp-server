#!/usr/bin/env bun
/**
 * Re-extract metadata from OCR text.
 *
 * For every row whose ocr_text_path is populated, reads the text file and
 * applies type-specific regex extractors to derive real values for:
 *   document_date, period_start/end, reference, supplier (from text header),
 *   amount_cents (TTC), amount_ht_cents, vat_cents, currency, and a richer
 *   `extra` JSON bag.
 *
 * The original supplier name from the title prefix is replaced if a more
 * confident hit is found in the OCR text. Manual curations (rows with
 * extra.manual_curation = true) are skipped.
 *
 * Usage:
 *   bun scripts/reextract-metadata.ts [--only-doc-type=invoice] [--dry-run]
 */
import { readFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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
const ONLY_TYPE = flags["only-doc-type"];
const DRY_RUN = flags["dry-run"] === "true";

const dbPath = expandPath(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");
const store = new MetadataStore(dbPath);

// ────────────────────────────────────────────────────────────────────────────
// Number parsing — French formats
// ────────────────────────────────────────────────────────────────────────────

function parseFrenchAmount(raw: string): number | null {
  // "1 234,56" / "1234.56" / "1.234,56" → cents
  const cleaned = raw.replace(/[€\s]/g, "").replace(/[  ]/g, "");
  // Detect decimal: last separator with 2 digits after = decimal
  const m = cleaned.match(/^(-?)([\d.,]+)$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  let body = m[2]!;
  // If both . and , present: assume European (',' is decimal, '.' is thousand sep)
  if (body.includes(",") && body.includes(".")) {
    body = body.replace(/\./g, "").replace(",", ".");
  } else if (body.includes(",")) {
    // ',' is decimal
    const parts = body.split(",");
    if (parts.length === 2 && parts[1]!.length <= 2) {
      body = parts[0] + "." + parts[1];
    } else {
      body = body.replace(/,/g, "");
    }
  }
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return Math.round(sign * n * 100);
}

// ────────────────────────────────────────────────────────────────────────────
// Date parsing
// ────────────────────────────────────────────────────────────────────────────

const FRENCH_MONTHS_LC: Record<string, number> = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  décembre: 12, decembre: 12,
};

function parseFrenchDate(raw: string): string | null {
  // DD/MM/YYYY or DD/MM/YY or DD-MM-YYYY
  let m = raw.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m as unknown as [string, string, string, string];
    let yy = y.length === 2 ? `20${y}` : y;
    if (yy.length === 5) yy = yy.slice(0, 4);
    return `${yy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // "15 mars 2026"
  m = raw.match(/(\d{1,2})\s+([a-zéèêû]+)\s+(\d{4})/i);
  if (m) {
    const mo = FRENCH_MONTHS_LC[m[2]!.toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-doc-type extractors
// ────────────────────────────────────────────────────────────────────────────

interface Extracted {
  fields: Partial<MetadataInput>;
  extraMerge?: Record<string, unknown>;
}

function extractInvoice(text: string): Extracted {
  const fields: Partial<MetadataInput> = {};
  const extra: Record<string, unknown> = {};

  // Invoice number — look for "Facture N° X" / "FACTURE n°X" / "N° X" near "FACTURE"
  const refPatterns = [
    /(?:facture|fact\.?)\s*n[°ºo]?\s*[:.]?\s*([A-Z0-9][A-Z0-9_/.-]{2,})/i,
    /^FACTURE\s+([A-Z0-9][A-Z0-9_/.-]{2,})\s*$/im,
    /^F\s*N[°º]\s*([A-Z0-9][A-Z0-9_/.-]{2,})/im,
  ];
  for (const re of refPatterns) {
    const m = text.match(re);
    if (m && m[1]) {
      fields.reference = m[1].replace(/[.,;]+$/, "").trim();
      break;
    }
  }

  // Document date — first DD/MM/YYYY near "Date" word, else first plausible date
  const dateNearLabel = text.match(/date[\s:]*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  const docDate = dateNearLabel ? parseFrenchDate(dateNearLabel[1]!) : null;
  if (docDate) fields.document_date = docDate;

  // Total TTC
  const ttcPatterns = [
    /(?:total\s*t\.?\s*t\.?\s*c\.?|net\s*à\s*payer|montant\s*ttc)[\s\S]{0,80}?(\d[\d\s.,  ]{0,20}\d)\s*€?/i,
    /€\s*ttc[\s\S]{0,80}?(\d[\d\s.,  ]{0,20}\d)/i,
  ];
  for (const re of ttcPatterns) {
    const m = text.match(re);
    if (m) {
      const cents = parseFrenchAmount(m[1]!);
      if (cents !== null && cents > 0) {
        fields.amount_cents = cents;
        break;
      }
    }
  }

  // Total HT
  const htMatch = text.match(/total\s*h\.?\s*t\.?[\s\S]{0,80}?(\d[\d\s.,  ]{0,20}\d)\s*€?/i);
  if (htMatch) {
    const cents = parseFrenchAmount(htMatch[1]!);
    if (cents !== null && cents > 0) fields.amount_ht_cents = cents;
  }

  // VAT
  const vatMatch = text.match(/total\s*t\.?\s*v\.?\s*a\.?[\s\S]{0,80}?(\d[\d\s.,  ]{0,20}\d)\s*€?/i);
  if (vatMatch) {
    const cents = parseFrenchAmount(vatMatch[1]!);
    if (cents !== null && cents >= 0) fields.vat_cents = cents;
  }

  // Currency hint: € everywhere → EUR
  if (/€|EUR/.test(text)) fields.currency = "EUR";

  // Period detection: "période du DD/MM/YYYY au DD/MM/YYYY" or "DD/MM/YYYY au DD/MM/YYYY"
  const periodMatch = text.match(/(?:p[ée]riode\s*(?:du|:)?\s*|du\s+)(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}).{0,10}au\s+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  if (periodMatch) {
    const ps = parseFrenchDate(periodMatch[1]!);
    const pe = parseFrenchDate(periodMatch[2]!);
    if (ps) fields.period_start = ps;
    if (pe) fields.period_end = pe;
  }

  // Échéance / due date → into extra
  const dueMatch = text.match(/[ée]ch[ée]ance[\s:]*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  if (dueMatch) {
    const due = parseFrenchDate(dueMatch[1]!);
    if (due) extra.due_date = due;
  }

  // SIRET / TVA Intracom into extra
  const siret = text.match(/siret\s*[:n°]*\s*([\d\s]{14,17})/i);
  if (siret) extra.siret = siret[1]!.replace(/\s/g, "");
  const tvaIntra = text.match(/(?:tva\s*intracom\.?|n[°o]\s*tva)\s*[:]*\s*((?:FR)?\s*[\dA-Z]{11,14})/i);
  if (tvaIntra) extra.tva_intracom = tvaIntra[1]!.replace(/\s/g, "");

  // IBAN
  const iban = text.match(/IBAN\s*[:]*\s*([A-Z]{2}\d{2}\s?[\d\s]{18,30})/);
  if (iban) extra.iban = iban[1]!.replace(/\s/g, "");

  return { fields, extraMerge: Object.keys(extra).length ? extra : undefined };
}

function extractBankStatement(text: string): Extracted {
  const fields: Partial<MetadataInput> = {};
  const extra: Record<string, unknown> = {};
  fields.currency = "EUR";

  // "Votre relevé de compte n°X au DD/MM/YYYY"
  const headerMatch = text.match(/relev[ée]\s*de\s*compte\s*n[°ºo]\s*(\d+)\s*au\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  if (headerMatch) {
    extra.releve_number = Number(headerMatch[1]!);
    const closing = parseFrenchDate(headerMatch[2]!);
    if (closing) {
      fields.document_date = closing;
      fields.period_end = closing;
      // Compute period_start = first day of that month
      const [y, m] = closing.split("-");
      if (y && m) fields.period_start = `${y}-${m}-01`;
    }
  } else {
    // Fallback: any "AU DD/MM/YYYY"
    const auMatch = text.match(/AU\s+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
    if (auMatch) {
      const closing = parseFrenchDate(auMatch[1]!);
      if (closing) fields.document_date = closing;
    }
  }

  // IBAN
  const iban = text.match(/IBAN\s*[:]*\s*([A-Z]{2}\d{2}\s?[\d\s]{18,30})/);
  if (iban) extra.iban = iban[1]!.replace(/\s/g, "");
  // BIC
  const bic = text.match(/BIC\s*[:]*\s*([A-Z]{8,11})/);
  if (bic) extra.bic = bic[1]!;

  // Account name
  const account = text.match(/COMPTE\s+(?:COURANT|SUR\s+LIVRET)\s+DE\s+COPROPRIETE/i);
  if (account) extra.account_name = account[0]!.trim();

  // Solde initial / final
  const soldeFinal = text.match(/solde\s+(?:d[eé]biteur|cr[ée]diteur)\s+au\s+\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\*?[\s\S]{0,30}?(-?[\d\s.,  ]+)\s*€?/gi);
  if (soldeFinal && soldeFinal.length > 0) {
    const last = soldeFinal[soldeFinal.length - 1]!;
    const valMatch = last.match(/(-?[\d\s.,  ]+)\s*€?$/);
    if (valMatch) {
      const cents = parseFrenchAmount(valMatch[1]!);
      if (cents !== null) extra.solde_final_cents = cents;
    }
  }

  // Bank header
  if (/BANQUE\s+POPULAIRE/i.test(text)) fields.supplier = "BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE";

  return { fields, extraMerge: Object.keys(extra).length ? extra : undefined };
}

function extractMeetingMinutes(text: string): Extracted {
  const fields: Partial<MetadataInput> = {};
  const extra: Record<string, unknown> = {};

  // "Procès-verbal de l'Assemblée Générale [Ordinaire/Extraordinaire] du DD <mois> YYYY"
  const headerMatch = text.match(/proc[èe]s[\s-]*verbal[\s\S]{0,80}?assembl[ée]e\s*g[ée]n[ée]rale\s*([a-zéèê]*)\s*(?:du)?\s*(\d{1,2}\s+[a-zéèû]+\s+\d{4}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  if (headerMatch) {
    const kind = headerMatch[1]?.toLowerCase();
    if (kind && /extra/.test(kind)) extra.kind = "AGE";
    else extra.kind = "AGO";
    const date = parseFrenchDate(headerMatch[2]!);
    if (date) fields.document_date = date;
  }

  // Number of resolutions: "X résolutions"
  const resMatch = text.match(/(\d+)\s+r[ée]solutions/i);
  if (resMatch) extra.resolutions_count = Number(resMatch[1]!);

  // Tantiemes total
  const tantMatch = text.match(/tanti[èe]mes?\s+(?:total|g[ée]n[ée]ral)\s*[:.]?\s*(\d[\d\s.,  ]+)/i);
  if (tantMatch) extra.tantiemes = tantMatch[1]!.replace(/\s/g, "");

  return { fields, extraMerge: Object.keys(extra).length ? extra : undefined };
}

function extractContract(text: string): Extracted {
  const fields: Partial<MetadataInput> = {};
  const extra: Record<string, unknown> = {};
  // "Contrat n° X" / "N° de contrat: X"
  const contractRef = text.match(/contrat\s*n[°ºo]\s*[:.]?\s*([A-Z0-9][A-Z0-9_/.-]{2,})/i);
  if (contractRef) fields.reference = contractRef[1]!.trim();
  // Period
  const periodMatch = text.match(/(?:p[ée]riode|du)\s+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}).{0,5}au\s+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  if (periodMatch) {
    const ps = parseFrenchDate(periodMatch[1]!);
    const pe = parseFrenchDate(periodMatch[2]!);
    if (ps) fields.period_start = ps;
    if (pe) fields.period_end = pe;
  }
  return { fields, extraMerge: Object.keys(extra).length ? extra : undefined };
}

const EXTRACTORS: Record<string, (text: string) => Extracted> = {
  invoice: extractInvoice,
  bank_statement: extractBankStatement,
  meeting_minutes: extractMeetingMinutes,
  meeting_convocation: extractMeetingMinutes,
  contract: extractContract,
};

// ────────────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────────────

const db = new Database(dbPath, { readwrite: true });
const rows = db
  .query<{ document_id: number; doc_type: string | null; ocr_text_path: string | null; extra: string | null }, []>(
    `SELECT document_id, doc_type, ocr_text_path, extra
     FROM document_metadata
     WHERE ocr_text_path IS NOT NULL
     ${ONLY_TYPE ? "AND doc_type = ?" : ""}
     ORDER BY document_id`,
  )
  .all(...(ONLY_TYPE ? [ONLY_TYPE] : []));
db.close();

console.log(`${rows.length} docs with OCR text to re-extract${ONLY_TYPE ? ` (filtering doc_type=${ONLY_TYPE})` : ""}`);

let updated = 0;
let skipped = 0;
let noExtractor = 0;
let noText = 0;
let manuallyCurated = 0;

for (const row of rows) {
  if (!row.doc_type) {
    skipped++;
    continue;
  }
  const extractor = EXTRACTORS[row.doc_type];
  if (!extractor) {
    noExtractor++;
    continue;
  }
  if (!row.ocr_text_path || !existsSync(row.ocr_text_path)) {
    noText++;
    continue;
  }

  // Check manual curation flag
  let parsedExtra: Record<string, unknown> = {};
  if (row.extra) {
    try {
      parsedExtra = JSON.parse(row.extra) as Record<string, unknown>;
      if (parsedExtra.manual_curation === true) {
        manuallyCurated++;
        continue;
      }
    } catch { /* */ }
  }

  const text = readFileSync(row.ocr_text_path, "utf8");
  const result = extractor(text);
  const input: MetadataInput = { document_id: row.document_id, ...result.fields };
  if (result.extraMerge) {
    input.extra = { ...parsedExtra, ...result.extraMerge };
  }

  if (DRY_RUN) {
    console.log(`[dry] ${row.document_id} (${row.doc_type}):`, JSON.stringify(input));
  } else {
    store.upsert(input);
  }
  updated++;
}

store.close();

console.log(`\n=== Done ===`);
console.log(`  rows considered:     ${rows.length}`);
console.log(`  updated:             ${updated}`);
console.log(`  no extractor:        ${noExtractor} (no implementation for that doc_type)`);
console.log(`  ocr text missing:    ${noText}`);
console.log(`  doc_type missing:    ${skipped}`);
console.log(`  manually curated:    ${manuallyCurated}`);
