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
    let yy = y.length === 2 ? `20${y}` : y.slice(0, 4);
    const dn = Number(d), mon = Number(mo), yn = Number(yy);
    // Sanity: day 1-31, month 1-12, year 1990-2099
    if (dn < 1 || dn > 31 || mon < 1 || mon > 12 || yn < 1990 || yn > 2099) return null;
    return `${yy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // "15 mars 2026"
  m = raw.match(/(\d{1,2})\s+([a-zéèêû]+)\s+(\d{4})/i);
  if (m) {
    const mo = FRENCH_MONTHS_LC[m[2]!.toLowerCase()];
    if (mo) {
      const dn = Number(m[1]!), yn = Number(m[3]!);
      if (dn < 1 || dn > 31 || yn < 1990 || yn > 2099) return null;
      return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    }
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

/** Detect the actual recipient (SDC) of a document. We expect "VILLENEUVE"
 *  somewhere; if a different copro name appears, flag it as misfiled. */
function detectRecipient(text: string): { recipient: string | null; misfiled_warning: string | null } {
  // Single all-caps word (the SDC name itself), optionally preceded by "LES"
  // or "RESIDENCE". We avoid greedy multi-word capture that swallows the
  // following address.
  const patterns = [
    /SDC\s+(?:RESIDENCE\s+)?(LES\s+)?([A-ZÉÈÀ][A-ZÉÈÀ'-]{2,30})/,
    /COPROPRIETE\s+(?:RESIDENCE\s+)?(LES\s+)?([A-ZÉÈÀ][A-ZÉÈÀ'-]{2,30})/i,
    /R[ÉE]SIDENCE\s+(LES\s+)?([A-ZÉÈÀ][A-ZÉÈÀ'-]{2,30})/,
  ];
  let recipient: string | null = null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[2]) {
      recipient = ((m[1] ?? "") + m[2]).trim().replace(/\s+/g, " ");
      break;
    }
  }
  // Heuristic: the user's copropriété is "VILLENEUVE", at "9 rue Lavéran" /
  // "126-128 av. Strasbourg" / "57000 METZ".
  const looksVilleneuve =
    /VILLENEUVE|LAV[ÉE]RAN|LAVERAN|126[-\s]*128.{0,10}STRASBOURG/i.test(text);
  let warning: string | null = null;
  if (recipient && !/VILLENEUVE/i.test(recipient) && !looksVilleneuve) {
    warning = `Document semble destiné à « ${recipient} », pas à VILLENEUVE — vérifier s'il s'agit d'un fichier mal classé.`;
  }
  return { recipient, misfiled_warning: warning };
}

function extractInvoice(text: string): Extracted {
  const fields: Partial<MetadataInput> = {};
  const extra: Record<string, unknown> = {};

  // Invoice number — try several patterns. Many suppliers use varied formats:
  //   "Facture N° 220746"            (inline)
  //   "FACTURE  5701F-26-001147"     (inline)
  //   "FC_0000861525"                (Athome)
  //   column header "N° Facture" with value on next data row
  const refPatterns = [
    // "Facture N° X" inline — same line, X must contain at least one digit
    /(?:facture|fact\.?)\s+n[°ºo]\s*[:.]?\s*([A-Z0-9][A-Z0-9_/.-]*\d[A-Z0-9_/.-]*)/i,
    // "FACTURE  XYZ" or "FACTURE _XYZ" inline (handles ILEX's leading underscore)
    /\bFACTURE\b\s+_?([A-Z0-9][A-Z0-9_/.-]*\d[A-Z0-9_/.-]*)/,
    // Column-style: "N° Facture" header then a French-style ref like 24-04-51042
    /N[°ºo]\s*Facture[\s\S]{0,400}?\b(\d{2,}[-/.]\d{2,}[-/.][\dA-Z]{2,})\b/i,
    // Format like "FC_0000861525" appearing anywhere (Athome)
    /\bFC[_-]?(\d{7,})\b/i,
  ];
  for (const re of refPatterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const ref = m[1].replace(/[.,;]+$/, "").trim();
      // Sanity: must contain at least one digit and not be a French word
      if (/\d/.test(ref) && !/^(?:facture|page|date|client|copro)/i.test(ref)) {
        fields.reference = ref;
        break;
      }
    }
  }

  // Document date — most reliable signal is "Date" header followed by DD/MM/YYYY,
  // or a date sitting next to the invoice number in a column-style row.
  const datePatterns = [
    // "Date: DD/MM/YYYY" or "Date DD/MM/YYYY" inline
    /\bdate\b[\s:]+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    // After a "Date" column header, scan up to 250 chars for first date
    /N[°ºo]\s*Facture[\s\S]{0,400}?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    // "le DD/MM/YYYY"
    /\ble\s+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
  ];
  for (const re of datePatterns) {
    const m = text.match(re);
    const parsed = m ? parseFrenchDate(m[1]!) : null;
    if (parsed) {
      fields.document_date = parsed;
      break;
    }
  }

  // Strict French monetary format: digits, optional thousand-spaces,
  // decimal comma or dot, 2 digits. Captures e.g. "1 560,00", "10 156,97", "67,06".
  const FR_AMOUNT_SRC = String.raw`(\d{1,3}(?:[  ]\d{3})*[,.]\d{2})`;

  // Total TTC. Take the LAST match in the doc (column-style invoices repeat
  // HT/TVA/TTC headers; the final occurrence is the bottom-line total).
  const ttcRe = new RegExp(
    `(?:total\\s*[€\\s]*t\\.?\\s*t\\.?\\s*c\\.?|net\\s*à\\s*payer|montant\\s*ttc|à\\s*payer\\s*€?)[\\s\\S]{0,200}?${FR_AMOUNT_SRC}\\s*€?`,
    "gi",
  );
  let lastTtc: string | null = null;
  for (const m of text.matchAll(ttcRe)) lastTtc = m[1] ?? null;
  if (lastTtc) {
    const cents = parseFrenchAmount(lastTtc);
    if (cents !== null && cents > 0 && cents < 100_000_000) fields.amount_cents = cents;
  }

  // Total HT
  const htRe = new RegExp(
    `total\\s*[€\\s]*h\\.?\\s*t\\.?[\\s\\S]{0,200}?${FR_AMOUNT_SRC}\\s*€?`,
    "gi",
  );
  let lastHt: string | null = null;
  for (const m of text.matchAll(htRe)) lastHt = m[1] ?? null;
  if (lastHt) {
    const cents = parseFrenchAmount(lastHt);
    if (cents !== null && cents > 0 && cents < 100_000_000) fields.amount_ht_cents = cents;
  }

  // VAT
  const vatRe = new RegExp(
    `total\\s*[€\\s]*(?:t\\.?\\s*v\\.?\\s*a\\.?|tva)[\\s\\S]{0,200}?${FR_AMOUNT_SRC}\\s*€?`,
    "gi",
  );
  let lastVat: string | null = null;
  for (const m of text.matchAll(vatRe)) lastVat = m[1] ?? null;
  if (lastVat) {
    const cents = parseFrenchAmount(lastVat);
    if (cents !== null && cents >= 0 && cents < 100_000_000) fields.vat_cents = cents;
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

  // Recipient detection — flag misfiled docs (Villeneuve extranet but recipient elsewhere)
  const recipientCheck = detectRecipient(text);
  if (recipientCheck.recipient) extra.recipient = recipientCheck.recipient;
  if (recipientCheck.misfiled_warning) {
    extra.misfiled_warning = recipientCheck.misfiled_warning;
  }

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
  const soldeFinal = text.match(/solde\s+(?:d[eé]biteur|cr[ée]diteur)\s+au\s+\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\*?[\s\S]{0,30}?(-?[\d\s.,]+)\s*€?/gi);
  if (soldeFinal && soldeFinal.length > 0) {
    const last = soldeFinal[soldeFinal.length - 1]!;
    const valMatch = last.match(/(-?[\d\s.,]+)\s*€?$/);
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
  const tantMatch = text.match(/tanti[èe]mes?\s+(?:total|g[ée]n[ée]ral)\s*[:.]?\s*(\d[\d\s.,]+)/i);
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

const FORBIDDEN_FS = /[\\/:*?"<>|]/g;
function safeFs(s: string): string {
  return s.replace(FORBIDDEN_FS, "-").replace(/\s+/g, " ").trim();
}

/** Content-based reclassification: when the text reveals the doc is actually
 *  a different type than the title-based bulk-annotate guessed, override
 *  doc_type, target_classeur, target_filename. Returns null if no override.
 */
function reclassifyFromContent(text: string): {
  doc_type: string;
  target_classeur: string;
  target_filename: string;
  title?: string;
} | null {
  // FICHE SYNTHÉTIQUE de la copropriété (national registry)
  // Header always begins with "FICHE SYNTHETIQUE DE LA COPROPRIETE <num>"
  const ficheMatch = text.match(/FICHE\s+SYNTH[ÉE]TIQUE\s+DE\s+LA\s+COPROPRIETE/i);
  if (ficheMatch) {
    // Optional generation date: "générée à partir des données mises à jour le DD/MM/YYYY"
    const genMatch = text.match(
      /(?:g[ée]n[ée]r[ée]e?|mises?\s*[àa]\s*jour)[\s\S]{0,80}?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    );
    const genDate = genMatch ? parseFrenchDate(genMatch[1]!) : null;
    const fname = genDate
      ? `${genDate} - Fiche synthétique copropriété.pdf`
      : `Fiche synthétique copropriété.pdf`;
    return {
      doc_type: "registration_form",
      target_classeur: "Registre copropriété/Fiches synthétiques",
      target_filename: safeFs(fname),
      title: genDate
        ? `Fiche synthétique copropriété (registre national, MAJ ${genDate})`
        : "Fiche synthétique copropriété (registre national)",
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────────────

const db = new Database(dbPath, { readwrite: true });
const rows = ONLY_TYPE
  ? db
      .query<{ document_id: number; doc_type: string | null; ocr_text_path: string | null; extra: string | null }, [string]>(
        `SELECT document_id, doc_type, ocr_text_path, extra
         FROM document_metadata
         WHERE ocr_text_path IS NOT NULL AND doc_type = ?
         ORDER BY document_id`,
      )
      .all(ONLY_TYPE)
  : db
      .query<{ document_id: number; doc_type: string | null; ocr_text_path: string | null; extra: string | null }, []>(
        `SELECT document_id, doc_type, ocr_text_path, extra
         FROM document_metadata
         WHERE ocr_text_path IS NOT NULL
         ORDER BY document_id`,
      )
      .all();
db.close();

console.log(`${rows.length} docs with OCR text to re-extract${ONLY_TYPE ? ` (filtering doc_type=${ONLY_TYPE})` : ""}`);

let updated = 0;
let skipped = 0;
let noExtractor = 0;
let noText = 0;
let manuallyCurated = 0;

let reclassified = 0;
for (const row of rows) {
  if (!row.doc_type) {
    skipped++;
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

  // Step 1: content-based reclassification — does the text indicate a
  // doc_type different from what title-based bulk-annotate set?
  const reclass = reclassifyFromContent(text);
  let effectiveType = row.doc_type;
  let typeOverride: { doc_type: string; target_classeur: string; target_filename: string; title?: string } | null = null;
  if (reclass && reclass.doc_type !== row.doc_type) {
    effectiveType = reclass.doc_type;
    typeOverride = reclass;
    reclassified++;
  }

  // Step 2: run the extractor for the effective type (if any)
  const extractor = EXTRACTORS[effectiveType];
  if (!extractor && !typeOverride) {
    noExtractor++;
    continue;
  }
  const result = extractor ? extractor(text) : { fields: {}, extraMerge: undefined } as Extracted;

  // Always overwrite the extractor-managed fields — null when not extracted —
  // so re-runs after fixing a regex actually clear stale values. Fields not in
  // EXTRACTOR_MANAGED are left untouched (preserving manual curations).
  // Supplier is intentionally NOT in this list — it's set by the title-based
  // bulk-annotate via the suppliers table; only manual curation overrides it.
  const EXTRACTOR_MANAGED = [
    "reference", "document_date", "amount_cents", "amount_ht_cents",
    "vat_cents", "currency", "period_start", "period_end",
  ] as const;
  const fields = result.fields as Record<string, unknown>;
  const input: MetadataInput = { document_id: row.document_id };
  for (const k of EXTRACTOR_MANAGED) {
    (input as unknown as Record<string, unknown>)[k] = fields[k] ?? null;
  }
  if (typeOverride) {
    input.doc_type = typeOverride.doc_type;
    input.target_classeur = typeOverride.target_classeur;
    input.target_filename = typeOverride.target_filename;
    if (typeOverride.title) input.title = typeOverride.title;
  }
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
console.log(`  reclassified:        ${reclassified}`);
console.log(`  no extractor:        ${noExtractor} (no implementation for that doc_type)`);
console.log(`  ocr text missing:    ${noText}`);
console.log(`  doc_type missing:    ${skipped}`);
console.log(`  manually curated:    ${manuallyCurated}`);
