#!/usr/bin/env bun
/**
 * Bulk-annotate every document in every classeur using title-based heuristics.
 * Idempotent — re-running merges with existing rows (only fields the heuristics
 * set are touched; manual enrichments stay).
 *
 * Usage: bun scripts/bulk-annotate.ts
 */
import { HerbethClient, type DocumentEntry, type Space } from "../src/client.ts";
import {
  MetadataStore,
  type MetadataInput,
} from "../src/metadata.ts";

const username = Bun.env.HERBETH_USERNAME;
const password = Bun.env.HERBETH_PASSWORD;
if (!username || !password) {
  console.error("Missing HERBETH_USERNAME / HERBETH_PASSWORD");
  process.exit(1);
}

const client = new HerbethClient(username, password);
const store = new MetadataStore(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_FILENAME = /[\\/:*?"<>|]/g;

function safeFs(s: string): string {
  return s.replace(FORBIDDEN_FILENAME, "-").replace(/\s+/g, " ").trim();
}

function yearOf(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = d.match(/(\d{4})/);
  return m ? m[1]! : null;
}

function dateCommitToYmd(s: string): string {
  // "2026-04-23T00:00:00+02:00" → "2026-04-23"
  return s.slice(0, 10);
}

function dateCommitYear(s: string): string {
  return s.slice(0, 4);
}

const FRENCH_MONTHS: Record<string, number> = {
  JANVIER: 1, FEVRIER: 2, FÉVRIER: 2, MARS: 3, AVRIL: 4, MAI: 5, JUIN: 6,
  JUILLET: 7, AOUT: 8, AOÛT: 8, SEPTEMBRE: 9, OCTOBRE: 10, NOVEMBRE: 11,
  DECEMBRE: 12, DÉCEMBRE: 12,
};
const FRENCH_MONTHS_LC: Record<string, number> = Object.fromEntries(
  Object.entries(FRENCH_MONTHS).map(([k, v]) => [k.toLowerCase(), v]),
);

function frenchMonthToNum(s: string): number | null {
  const upper = s.trim().toUpperCase();
  if (upper in FRENCH_MONTHS) return FRENCH_MONTHS[upper]!;
  const lower = s.trim().toLowerCase();
  if (lower in FRENCH_MONTHS_LC) return FRENCH_MONTHS_LC[lower]!;
  return null;
}

/** Try to parse a French-style date in any of the formats we see. Returns ISO YYYY-MM-DD. */
function parseFrDate(s: string): string | null {
  // DD/MM/YYYY or DD/MM/YY
  let m = s.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m as unknown as [string, string, string, string];
    let yy = y.length === 2 ? `20${y}` : y;
    if (yy.length === 5) yy = yy.slice(0, 4); // typo "20214" → "2021"
    return `${yy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // "MOIS YYYY" e.g. "Mars 2026"
  m = s.match(/([A-Za-zÉÈéè]+)\s*(\d{4})/);
  if (m) {
    const mo = frenchMonthToNum(m[1]!);
    if (mo) return `${m[2]}-${String(mo).padStart(2, "0")}-01`;
  }
  // "MOISYYYY" e.g. "MARS2026"
  m = s.match(/^([A-Za-zÉÈéè]+?)(\d{4})$/);
  if (m) {
    const mo = frenchMonthToNum(m[1]!);
    if (mo) return `${m[2]}-${String(mo).padStart(2, "0")}-01`;
  }
  return null;
}

/** Parse "Mois YYYY" or "MOISYYYY" → { year, month }. */
function parseFrenchMonth(s: string): { year: number; month: number } | null {
  // "Mars 2026"
  let m = s.match(/^([A-Za-zÉÈéè]+)\s*(\d{4})$/);
  if (m) {
    const mo = frenchMonthToNum(m[1]!);
    if (mo) return { year: Number(m[2]!), month: mo };
  }
  // "MARS2026"
  m = s.match(/^([A-Za-zÉÈéè]+?)(\d{4})$/);
  if (m) {
    const mo = frenchMonthToNum(m[1]!);
    if (mo) return { year: Number(m[2]!), month: mo };
  }
  // "03/2022" or "03/22"
  m = s.match(/^(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const mo = Number(m[1]!);
    let y = m[2]!;
    if (y.length === 2) y = `20${y}`;
    if (mo >= 1 && mo <= 12) return { year: Number(y), month: mo };
  }
  return null;
}

const FRENCH_MONTH_NAMES = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function frenchMonthName(month: number): string {
  return FRENCH_MONTH_NAMES[month - 1] ?? "";
}

// ────────────────────────────────────────────────────────────────────────────
// Supplier normalization — backed by the DB `suppliers` table.
// Run `bun scripts/seed-suppliers.ts` to populate or extend the table.
// ────────────────────────────────────────────────────────────────────────────

const SUPPLIER_PATTERNS = store.listSuppliers().map((s) => ({
  re: (() => {
    try {
      return new RegExp(s.pattern, "i");
    } catch {
      return null;
    }
  })(),
  canonical_name: s.canonical_name,
}));

if (SUPPLIER_PATTERNS.length === 0) {
  console.warn(
    "  ⚠ suppliers table is empty — supplier names will not be canonicalized.\n" +
      "    Run `bun scripts/seed-suppliers.ts` first.",
  );
}

function canonicalSupplier(rawPrefix: string): string | null {
  for (const { re, canonical_name } of SUPPLIER_PATTERNS) {
    if (re && re.test(rawPrefix.trim())) return canonical_name;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Heuristics per classeur
// ────────────────────────────────────────────────────────────────────────────

type HeuristicResult = Omit<MetadataInput, "document_id">;

interface ClasseurConfig {
  classeur_id: number;
  space: Space;
  label: string;
  annotate: (doc: DocumentEntry, sequenceInGroup: number, groupSize: number) => HeuristicResult | null;
}

/** Group docs by (title|date_commit_libelle) so we can suffix duplicates. */
function withDuplicateSequence(
  docs: DocumentEntry[],
): Array<{ doc: DocumentEntry; seq: number; size: number }> {
  const groups = new Map<string, DocumentEntry[]>();
  for (const d of docs) {
    const key = `${d.title.trim().toLowerCase()}|${d.date_commit_libelle}`;
    const arr = groups.get(key);
    if (arr) arr.push(d);
    else groups.set(key, [d]);
  }
  const out: Array<{ doc: DocumentEntry; seq: number; size: number }> = [];
  for (const [, arr] of groups) {
    arr.sort((a, b) => a.id - b.id);
    arr.forEach((doc, i) => out.push({ doc, seq: i + 1, size: arr.length }));
  }
  return out;
}

function suffixIfDup(name: string, seq: number, size: number): string {
  return size > 1 ? `${name} (${seq})` : name;
}

// 91 — Assemblées Générales (PV)
const ag91: ClasseurConfig = {
  classeur_id: 91,
  space: "coproprietaire",
  label: "Assemblées Générales",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const isAGE = /AGE/i.test(t);
    const isPV = /\bPV\b/i.test(t);
    const isConvocation = /convocation/i.test(t);
    const docDate = parseFrDate(t) ?? dateCommitToYmd(doc.date_commit);
    const year = yearOf(docDate) ?? dateCommitYear(doc.date_commit);

    if (isConvocation) {
      const base = `${docDate} - Convocation Assemblée Générale${isAGE ? "E" : ""}`;
      return {
        doc_type: "meeting_convocation",
        title: `Convocation AG${isAGE ? "E" : ""} du ${docDate}`,
        document_date: docDate,
        target_classeur: `Assemblées Générales/${year}/Convocations`,
        target_filename: `${suffixIfDup(safeFs(base), seq, size)}.pdf`,
        language: "fr",
        tags: isAGE ? ["age", "convocation"] : ["ag", "convocation"],
      };
    }

    if (isPV || isAGE) {
      const kind = isAGE ? "AGE" : "AG";
      const base = `${docDate} - PV Assemblée Générale${isAGE ? "E" : ""}`;
      return {
        doc_type: "meeting_minutes",
        title: `PV ${kind} du ${docDate}`,
        document_date: docDate,
        target_classeur: `Assemblées Générales/${year}/PV`,
        target_filename: `${suffixIfDup(safeFs(base), seq, size)}.pdf`,
        language: "fr",
        tags: [kind.toLowerCase(), "pv"],
      };
    }

    return null;
  },
};

// 96 — Contrat de syndic
const contratSyndic96: ClasseurConfig = {
  classeur_id: 96,
  space: "coproprietaire",
  label: "Contrat de syndic",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    if (/fiche synthétique/i.test(t)) {
      return {
        doc_type: "registration_form",
        title: "Fiche synthétique d'immatriculation de la copropriété",
        target_classeur: "Registre copropriété/Fiches synthétiques",
        target_filename: `${dateCommitToYmd(doc.date_commit)} - Fiche synthétique copropriété.pdf`,
        language: "fr",
      };
    }
    // "Contrat de syndic du 24/06/2019 au 23/06/2022"
    const range = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}).{1,4}(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    if (range) {
      periodStart = parseFrDate(range[1]!);
      periodEnd = parseFrDate(range[2]!);
    }
    const single = !range ? t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/) : null;
    const docDate = single ? parseFrDate(single[1]!) : periodStart ?? dateCommitToYmd(doc.date_commit);
    const baseTitle = periodStart && periodEnd
      ? `Contrat de syndic ${periodStart} → ${periodEnd}`
      : `Contrat de syndic ${docDate}`;
    return {
      doc_type: "contract",
      title: baseTitle,
      supplier: "CABINET HERBETH",
      document_date: docDate,
      period_start: periodStart,
      period_end: periodEnd,
      target_classeur: "Contrats/Syndic",
      target_filename: safeFs(`${docDate ?? ""} - ${baseTitle}.pdf`),
      language: "fr",
      tags: ["syndic", "contrat"],
    };
  },
};

// 910 — Règlement de copropriété + plans + clés
const reglement910: ClasseurConfig = {
  classeur_id: 910,
  space: "coproprietaire",
  label: "Règlement de copropriété",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);

    if (/règlement de copropriété/i.test(t)) {
      return {
        doc_type: "regulation",
        title: "Règlement de copropriété",
        target_classeur: "Règlement et plans/Règlement",
        target_filename: `${date} - Règlement de copropriété.pdf`,
      };
    }
    if (/plan/i.test(t) || /esquisse/i.test(t)) {
      const subtitle = t.replace(/^plan\s*/i, "Plan ").replace(/^esquisse$/i, "Esquisse");
      return {
        doc_type: "plan",
        title: subtitle,
        target_classeur: "Règlement et plans/Plans",
        target_filename: safeFs(`${date} - ${subtitle}.pdf`),
      };
    }
    if (/fiche synthétique/i.test(t)) {
      return {
        doc_type: "registration_form",
        title: "Fiche synthétique copropriété",
        target_classeur: "Registre copropriété/Fiches synthétiques",
        target_filename: `${date} - Fiche synthétique copropriété.pdf`,
      };
    }
    if (/clés/i.test(t) || /répartition/i.test(t)) {
      return {
        doc_type: "cost_allocation_keys",
        title: "Clés de répartition",
        target_classeur: "Règlement et plans/Règlement",
        target_filename: `${date} - Clés de répartition.pdf`,
      };
    }
    return null;
  },
};

// 911 — Relevés des charges et produits
const releves911: ClasseurConfig = {
  classeur_id: 911,
  space: "coproprietaire",
  label: "Relevés charges et produits",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);
    if (/^Decompte/i.test(t)) {
      // Personal owner statement: DecompteBOUR_NIZET_<id>
      const m = t.match(/_(\d+)$/);
      const ref = m ? m[1]! : null;
      return {
        doc_type: "report",
        title: `Décompte personnel BOUR/NIZET${ref ? ` n°${ref}` : ""}`,
        supplier: "CABINET HERBETH",
        reference: ref,
        document_date: date,
        target_classeur: `Charges et produits/Décomptes personnels/${dateCommitYear(doc.date_commit)}`,
        target_filename: safeFs(`${date} - Décompte BOUR-NIZET${ref ? ` n°${ref}` : ""}.pdf`),
        language: "fr",
        tags: ["décompte", "personnel"],
      };
    }
    if (/^\d{4}/.test(t)) {
      // "2024" or "2023"
      const exYear = t.match(/(\d{4})/)?.[1] ?? dateCommitYear(doc.date_commit);
      return {
        doc_type: "annual_accounts",
        title: `Relevé général des dépenses ${exYear}`,
        document_date: date,
        period_start: `${exYear}-01-01`,
        period_end: `${exYear}-12-31`,
        target_classeur: `Charges et produits/${exYear}`,
        target_filename: `${exYear} - Relevé général des dépenses.pdf`,
        language: "fr",
      };
    }
    if (/appel de fonds/i.test(t)) {
      return {
        doc_type: "letter",
        title: "Appel de fonds travaux",
        document_date: date,
        target_classeur: `Charges et produits/Appels de fonds/${dateCommitYear(doc.date_commit)}`,
        target_filename: `${date} - Appel de fonds travaux.pdf`,
        language: "fr",
      };
    }
    return null;
  },
};

// 98 — Divers
const divers98: ClasseurConfig = {
  classeur_id: 98,
  space: "coproprietaire",
  label: "Divers",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);
    const dateYear = dateCommitYear(doc.date_commit);

    // "compte 2024" → fiche synthétique (we read it; label is misleading)
    if (/^compte 2024$/i.test(t)) {
      return {
        doc_type: "registration_form",
        title: "Fiche synthétique copropriété (registre national, 2024)",
        document_date: date,
        target_classeur: "Registre copropriété/Fiches synthétiques",
        target_filename: `${date} - Fiche synthétique copropriété 2024.pdf`,
        notes: "Le titre extranet « compte 2024 » est trompeur : il s'agit de la fiche synthétique officielle du registre national des copropriétés (AD7-401-599).",
      };
    }
    if (/^Comptes \d{4}$/i.test(t)) {
      const ex = t.match(/(\d{4})/)?.[1] ?? dateYear;
      return {
        doc_type: "annual_accounts",
        title: `Comptes annuels ${ex}`,
        document_date: date,
        period_start: `${ex}-01-01`,
        period_end: `${ex}-12-31`,
        target_classeur: `Comptes annuels/${ex}`,
        target_filename: `${ex} - Comptes annuels.pdf`,
      };
    }
    if (/devis/i.test(t)) {
      return {
        doc_type: "quote",
        title: t,
        document_date: date,
        target_classeur: `Travaux/${dateYear}/Devis fournisseurs`,
        target_filename: safeFs(`${date} - Devis - ${t.replace(/^Devis\s*/i, "")} (${seq}).pdf`),
        tags: ["devis"],
      };
    }
    if (/convocation/i.test(t)) {
      const dateFromTitle = parseFrDate(t);
      const docDate = dateFromTitle ?? date;
      const year = yearOf(docDate);
      const isAGE = /AGE/i.test(t);
      return {
        doc_type: "meeting_convocation",
        title: `Convocation AG${isAGE ? "E" : "O"} du ${docDate}`,
        document_date: docDate,
        target_classeur: `Assemblées Générales/${year}/Convocations`,
        target_filename: `${docDate} - Convocation AG${isAGE ? "E" : "O"}.pdf`,
        tags: [isAGE ? "age" : "ago", "convocation"],
      };
    }
    if (/immatriculation/i.test(t)) {
      return {
        doc_type: "registration_form",
        title: "Immatriculation copropriété",
        document_date: date,
        target_classeur: "Registre copropriété/Fiches synthétiques",
        target_filename: `${date} - Immatriculation copropriété.pdf`,
      };
    }
    return {
      doc_type: "other",
      title: t,
      document_date: date,
      target_classeur: "Divers",
      target_filename: safeFs(`${date} - ${t}.pdf`),
    };
  },
};

// 93 — Carnet d'entretien
const carnet93: ClasseurConfig = {
  classeur_id: 93,
  space: "coproprietaire",
  label: "Carnet d'entretien",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);
    const year = dateCommitYear(doc.date_commit);

    if (/contrat assurance/i.test(t)) {
      return {
        doc_type: "contract",
        title: t,
        document_date: date,
        target_classeur: "Contrats/Assurance",
        target_filename: safeFs(`${date} - ${t}.pdf`),
        tags: ["assurance", "contrat"],
      };
    }
    if (/contrat gaz/i.test(t)) {
      return {
        doc_type: "contract",
        title: t,
        supplier: "GAZ EUROPEEN",
        document_date: date,
        target_classeur: "Contrats/Énergie",
        target_filename: safeFs(`${date} - Contrat Gaz Européen.pdf`),
        tags: ["gaz", "contrat"],
      };
    }
    if (/validation contrat/i.test(t) || /^contrat validé$/i.test(t)) {
      return {
        doc_type: "quote_acceptance_letter",
        title: t,
        document_date: date,
        target_classeur: `Contrats/Validations/${year}`,
        target_filename: safeFs(`${date} - ${t} (${seq}).pdf`),
        tags: ["validation", "contrat"],
      };
    }
    if (/devis validé/i.test(t)) {
      const cleaned = t.replace(/^Devis validé\s*-?\s*/i, "").trim() || "Devis";
      return {
        doc_type: "quote_acceptance_letter",
        title: t,
        document_date: date,
        target_classeur: `Carnet d'entretien/Devis validés/${year}`,
        target_filename: safeFs(`${date} - Devis validé - ${cleaned} (${seq}).pdf`),
        tags: ["devis", "validé"],
      };
    }
    if (/audit/i.test(t)) {
      return {
        doc_type: "report",
        title: t,
        document_date: date,
        target_classeur: "Carnet d'entretien/Audits",
        target_filename: safeFs(`${date} - ${t} (${seq}).pdf`),
        tags: ["audit"],
      };
    }
    if (/contrôle technique/i.test(t)) {
      const dateFromTitle = parseFrDate(t);
      return {
        doc_type: "report",
        title: t,
        document_date: dateFromTitle ?? date,
        target_classeur: "Carnet d'entretien/Contrôles techniques",
        target_filename: safeFs(`${dateFromTitle ?? date} - ${t} (${seq}).pdf`),
        tags: ["contrôle technique", "ascenseur"],
      };
    }
    if (/amiante/i.test(t)) {
      return {
        doc_type: "report",
        title: "Diagnostic amiante (DTA)",
        document_date: date,
        target_classeur: "Carnet d'entretien/Diagnostics",
        target_filename: safeFs(`${date} - Diagnostic amiante (${seq}).pdf`),
        tags: ["amiante", "dta", "diagnostic"],
      };
    }
    if (/carnet d'entretien/i.test(t)) {
      return {
        doc_type: "other",
        title: t,
        document_date: date,
        target_classeur: "Carnet d'entretien/Carnet officiel",
        target_filename: safeFs(`${date} - Carnet d'entretien (${seq}).pdf`),
      };
    }
    if (/edition du/i.test(t)) {
      const fromTitle = parseFrDate(t);
      return {
        doc_type: "report",
        title: t,
        document_date: fromTitle ?? date,
        target_classeur: "Carnet d'entretien/Éditions",
        target_filename: safeFs(`${fromTitle ?? date} - ${t} (${seq}).pdf`),
      };
    }
    if (/^villeneuve$/i.test(t)) {
      return {
        doc_type: "other",
        title: t,
        document_date: date,
        target_classeur: "Carnet d'entretien/À trier",
        target_filename: safeFs(`${date} - Carnet entretien à trier (${seq}).pdf`),
        notes: "Titre générique « villeneuve » — contenu non analysé.",
      };
    }
    if (/^ravalement/i.test(t)) {
      return {
        doc_type: "report",
        title: t,
        document_date: date,
        target_classeur: "Travaux/2021/Études",
        target_filename: safeFs(`${date} - Ravalement façades teintes coloris.pdf`),
      };
    }
    if (/ista/i.test(t)) {
      return {
        doc_type: "letter",
        title: t,
        supplier: "ISTA",
        document_date: date,
        target_classeur: `Carnet d'entretien/ISTA/${year}`,
        target_filename: safeFs(`${date} - ${t} (${seq}).pdf`),
        tags: ["ista"],
      };
    }
    if (/offres acceptés/i.test(t)) {
      return {
        doc_type: "quote_acceptance_letter",
        title: t,
        document_date: date,
        target_classeur: `Carnet d'entretien/Devis validés/${year}`,
        target_filename: safeFs(`${date} - Offres acceptées (${seq}).pdf`),
      };
    }
    return {
      doc_type: "other",
      title: t,
      document_date: date,
      target_classeur: "Carnet d'entretien/À trier",
      target_filename: safeFs(`${date} - ${t} (${seq}).pdf`),
    };
  },
};

// 913 — Conseil syndical (mostly bank statements)
const conseil913: ClasseurConfig = {
  classeur_id: 913,
  space: "conseil-syndical",
  label: "Conseil syndical (relevés bancaires)",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);

    if (/liste des copropriétaires/i.test(t)) {
      return {
        doc_type: "owner_list",
        title: "Liste des copropriétaires",
        document_date: date,
        target_classeur: "Registre copropriété/Liste copropriétaires",
        target_filename: `${date} - Liste des copropriétaires.pdf`,
      };
    }

    // "MARS 2026", "Mars 2026", "Décembre 2024", "MARS2026"
    const monthOnly = parseFrenchMonth(t);
    if (monthOnly) {
      const periodStart = `${monthOnly.year}-${String(monthOnly.month).padStart(2, "0")}-01`;
      const periodEnd = (() => {
        const last = new Date(monthOnly.year, monthOnly.month, 0).getDate();
        return `${monthOnly.year}-${String(monthOnly.month).padStart(2, "0")}-${last}`;
      })();
      const yearMonth = `${monthOnly.year}-${String(monthOnly.month).padStart(2, "0")}`;
      return {
        doc_type: "bank_statement",
        title: `Relevé bancaire ${frenchMonthName(monthOnly.month)} ${monthOnly.year}`,
        supplier: "BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE",
        document_date: periodEnd,
        period_start: periodStart,
        period_end: periodEnd,
        target_classeur: `Banque/Relevés/${monthOnly.year}`,
        target_filename: safeFs(`${yearMonth} - Relevé bancaire BPALC (${seq}).pdf`),
        tags: ["banque", "relevé"],
      };
    }

    // "DD/MM/YY" e.g. "30/06/2025", "31/03/25"
    const fullDate = parseFrDate(t);
    if (fullDate) {
      const ym = fullDate.slice(0, 7);
      const year = fullDate.slice(0, 4);
      return {
        doc_type: "bank_statement",
        title: `Relevé bancaire ${fullDate}`,
        supplier: "BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE",
        document_date: fullDate,
        target_classeur: `Banque/Relevés/${year}`,
        target_filename: safeFs(`${ym} - Relevé bancaire BPALC (${seq}).pdf`),
        tags: ["banque", "relevé"],
      };
    }

    // "09/2023 à 10/2024" - bundled batch
    if (/à/.test(t) && /\d{4}/.test(t)) {
      const m = t.match(/(\d{1,2})\/(\d{4}).{1,4}(\d{1,2})\/(\d{4})/);
      const ps = m ? `${m[2]}-${m[1]!.padStart(2, "0")}-01` : null;
      const pe = m
        ? (() => {
            const last = new Date(Number(m[4]!), Number(m[3]!), 0).getDate();
            return `${m[4]}-${m[3]!.padStart(2, "0")}-${last}`;
          })()
        : null;
      return {
        doc_type: "bank_statement",
        title: `Lot relevés bancaires ${t}`,
        supplier: "BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE",
        document_date: date,
        period_start: ps,
        period_end: pe,
        target_classeur: `Banque/Relevés/À ventiler`,
        target_filename: safeFs(`${date} - Relevé bancaire BPALC bundle ${t} (${seq}).pdf`),
        tags: ["banque", "relevé", "lot"],
        notes: "Lot de relevés sur la période; à éclater individuellement après inspection PDF.",
      };
    }

    // "Extraits 2ème semestre 2020"
    if (/extraits/i.test(t)) {
      return {
        doc_type: "bank_statement",
        title: t,
        supplier: "BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE",
        document_date: date,
        target_classeur: "Banque/Relevés/2020",
        target_filename: safeFs(`${date} - ${t}.pdf`),
        tags: ["banque", "relevé"],
      };
    }

    // Fallback
    return {
      doc_type: "bank_statement",
      title: t,
      supplier: "BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE",
      document_date: date,
      target_classeur: "Banque/Relevés/À ventiler",
      target_filename: safeFs(`${date} - Relevé bancaire (${seq}).pdf`),
      tags: ["banque", "relevé"],
    };
  },
};

// 99 — Interventions / Travaux
const travaux99: ClasseurConfig = {
  classeur_id: 99,
  space: "coproprietaire",
  label: "Interventions / Travaux",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);
    const year = dateCommitYear(doc.date_commit);

    if (/^Re:/i.test(t)) {
      return {
        doc_type: "letter",
        title: t,
        document_date: date,
        target_classeur: `Travaux/${year}/Échanges`,
        target_filename: safeFs(`${date} - Échange - ${t.replace(/^Re:\s*/i, "")} (${seq}).pdf`),
        tags: ["email", "échange"],
      };
    }
    if (/bon pour accord/i.test(t)) {
      return {
        doc_type: "quote_acceptance_letter",
        title: t,
        document_date: date,
        target_classeur: `Travaux/${year}/Devis acceptés`,
        target_filename: safeFs(`${date} - Bon pour accord - ${t.replace(/^VILLENEUVE\s*-\s*/i, "")} (${seq}).pdf`),
      };
    }
    if (/devis (validé|accepté)/i.test(t)) {
      const cleaned = t
        .replace(/^Devis (validé|accepté)s?\s*-?\s*(Résidence VILLENEUVE\s*)?/i, "")
        .replace(/^VILLENEUVE\s*-?\s*/i, "")
        .trim() || "Travaux";
      const refMatch = t.match(/N[°o]\s*(\S+)/i);
      return {
        doc_type: "quote_acceptance_letter",
        title: t,
        document_date: date,
        reference: refMatch?.[1] ?? null,
        target_classeur: `Travaux/${year}/Devis acceptés`,
        target_filename: safeFs(`${date} - Devis accepté - ${cleaned} (${seq}).pdf`),
        tags: ["devis", "validé"],
      };
    }
    if (/intervention/i.test(t) || /demande/i.test(t)) {
      return {
        doc_type: "letter",
        title: t,
        document_date: date,
        target_classeur: `Travaux/${year}/Échanges`,
        target_filename: safeFs(`${date} - ${t} (${seq}).pdf`),
        tags: ["intervention", "échange"],
      };
    }
    // Fallback for descriptive titles like "VILLENEUVE - rplct faux plafond..."
    return {
      doc_type: "quote_acceptance_letter",
      title: t,
      document_date: date,
      target_classeur: `Travaux/${year}/Devis acceptés`,
      target_filename: safeFs(`${date} - ${t.replace(/^VILLENEUVE\s*-\s*/i, "")} (${seq}).pdf`),
    };
  },
};

// 912 — Factures
const factures912: ClasseurConfig = {
  classeur_id: 912,
  space: "conseil-syndical",
  label: "Factures",
  annotate(doc, seq, size) {
    const t = doc.title.trim();
    const date = dateCommitToYmd(doc.date_commit);
    const year = dateCommitYear(doc.date_commit);

    // Special: the ATHOME batch
    if (/^Frais de reprographie/i.test(t)) {
      return {
        doc_type: "invoice",
        supplier: "ATHOME",
        document_date: date,
        target_classeur: `Factures/${year}`,
        target_filename: safeFs(`${date} - Facture ATHOME - Lot reprographie.pdf`),
        tags: ["facture", "reprographie", "lot", "athome"],
      };
    }

    // Most factures: "<SUPPLIER> - <description>"
    const split = t.split(/\s+-\s+/);
    const prefix = (split[0] ?? "").trim();
    const description = split.slice(1).join(" - ").trim() || "À identifier";
    const supplier = canonicalSupplier(prefix) ?? prefix;

    return {
      doc_type: "invoice",
      supplier,
      document_date: date,
      target_classeur: `Factures/${year}`,
      target_filename: safeFs(
        `${date} - Facture ${supplier} - ${description} (${seq}).pdf`,
      ),
      language: "fr",
      tags: ["facture"],
    };
  },
};

const CONFIGS: ClasseurConfig[] = [
  ag91,
  contratSyndic96,
  reglement910,
  releves911,
  divers98,
  carnet93,
  conseil913,
  travaux99,
  factures912,
];

// ────────────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────────────

const summary: Array<{ classeur: string; total: number; annotated: number; skipped: number }> = [];

for (const cfg of CONFIGS) {
  const listing = await client.listDocumentsInClasseur(cfg.classeur_id, cfg.space);
  const docs = listing.data.Documents;
  const grouped = withDuplicateSequence(docs);
  let annotated = 0;
  let skipped = 0;

  for (const { doc, seq, size } of grouped) {
    // Skip docs already manually curated (target_filename is the heuristic's marker)
    const existing = store.get(doc.id);
    if (existing?.target_filename) {
      skipped++;
      continue;
    }
    const meta = cfg.annotate(doc, seq, size);
    if (!meta) {
      skipped++;
      continue;
    }
    store.upsert({
      document_id: doc.id,
      ...meta,
      // Always capture / refresh source snapshot
      source_file_name: doc.file_name,
      source_title: doc.title,
      source_classeur_id: doc.documents_classeurs_id,
      source_date_commit: doc.date_commit,
    });
    annotated++;
  }

  summary.push({
    classeur: `${cfg.classeur_id} ${cfg.label}`,
    total: docs.length,
    annotated,
    skipped,
  });
  console.log(
    `[${cfg.classeur_id}] ${cfg.label}: ${annotated}/${docs.length} annotated (${skipped} skipped)`,
  );
}

console.log("\n=== Summary ===");
for (const s of summary) {
  console.log(`  ${s.classeur.padEnd(40)} ${s.annotated}/${s.total}`);
}
console.log("\n=== Stats ===");
console.log(JSON.stringify(store.stats(), null, 2));

store.close();
