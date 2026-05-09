#!/usr/bin/env bun
/**
 * Seed the suppliers table with canonical name + regex pattern entries.
 *
 * Idempotent — UNIQUE(canonical_name, pattern) constraint plus upsert behavior
 * means re-running won't create duplicates.
 *
 * Usage:
 *   bun scripts/seed-suppliers.ts
 */
import { MetadataStore } from "../src/metadata.ts";

const SEED: Array<{ canonical_name: string; pattern: string; priority?: number }> = [
  // Most specific first (lower priority = checked earlier)
  { canonical_name: "SAS SERRURERIE AUSESKY", pattern: "^(SAS )?SERRURERIE AUSESKY( SAS)?$", priority: 50 },
  { canonical_name: "SAS SERRURERIE AUSESKY", pattern: "^AUSESKY$", priority: 51 },
  { canonical_name: "ATHOME", pattern: "^ATHOME$", priority: 100 },
  { canonical_name: "ILEX LORRAINE", pattern: "^ILEX$", priority: 100 },
  { canonical_name: "FZ NETTOYAGE", pattern: "^FZ$", priority: 100 },
  { canonical_name: "GAZ EUROPEEN", pattern: "^GAZ EUROPEEN$", priority: 100 },
  { canonical_name: "CDR MAINTENANCE", pattern: "^CDR MAINTENANCE$", priority: 100 },
  { canonical_name: "UEM", pattern: "^UEM$", priority: 100 },
  { canonical_name: "THEMEL", pattern: "^THEMEL( PREVENTION)?$", priority: 100 },
  { canonical_name: "ISTA", pattern: "^ISTA$", priority: 100 },
  { canonical_name: "LOMANTO", pattern: "^LOMANTO$", priority: 100 },
  { canonical_name: "SOTECO", pattern: "^SOTECO$", priority: 100 },
  { canonical_name: "SL SANITAIRE", pattern: "^SL SANITAIRE$", priority: 100 },
  { canonical_name: "MDE", pattern: "^MDE$", priority: 100 },
  { canonical_name: "SANISOLAIR", pattern: "^SANISOLAIRE?$", priority: 100 },
  { canonical_name: "HYDROCLEAN ASSAINISSEMENT", pattern: "^HYDROCLEAN( ASSAINISSEMENT)?$", priority: 100 },
  { canonical_name: "GAN ASSURANCES", pattern: "^GAN$", priority: 100 },
  { canonical_name: "FRITZINGER", pattern: "^FRITZINGER$", priority: 100 },
  { canonical_name: "TALON SERVICE", pattern: "^TALON SERVICE$", priority: 100 },
  { canonical_name: "SPANNAGEL Gilles", pattern: "^SPANNAGEL Gilles$", priority: 100 },
  { canonical_name: "PFF FACADE", pattern: "^PFF FACADE$", priority: 100 },
  { canonical_name: "EUROFEU", pattern: "^EUROFEU$", priority: 100 },
  { canonical_name: "AB SAV", pattern: "^AB SAV$", priority: 100 },
  { canonical_name: "SCHERTZ AMENAGEMENTS", pattern: "^SCHERTZ( AMENAGEMENTS)?$", priority: 100 },
  { canonical_name: "MALEZIEUX", pattern: "^MALEZIEUX", priority: 100 },
  { canonical_name: "IN ARBORIS", pattern: "^IN ARBORIS$", priority: 100 },
  { canonical_name: "HYGIENE EST PEST CONTROL", pattern: "^HYGIENE EST PEST CONTROL$", priority: 100 },
  { canonical_name: "METRONA", pattern: "^METRONA$", priority: 100 },
  { canonical_name: "NUMERICABLE", pattern: "^NUMERICABLE$", priority: 100 },
  { canonical_name: "LA CAISSE A OUTILS", pattern: "^LA CAISSE A OUTILS$", priority: 100 },
  { canonical_name: "GAM ETANCHE", pattern: "^GAM ETANCHE$", priority: 100 },
  { canonical_name: "AS ETANCHEITE", pattern: "^AS ETANCHEITE$", priority: 100 },
  { canonical_name: "ARDF", pattern: "^ARDF$", priority: 100 },
  { canonical_name: "BURGER PEINTURE", pattern: "^BURGER( PEINTURE)?$", priority: 100 },
];

const store = new MetadataStore(Bun.env.HERBETH_METADATA_DB ?? "./data/metadata.db");

let added = 0;
for (const entry of SEED) {
  store.addSupplier(entry);
  added++;
}

const all = store.listSuppliers();
console.log(`Seeded ${added} entries. Total in DB: ${all.length}.`);
console.log(`\nCurrent canonical names:`);
const byCanon = new Map<string, number>();
for (const s of all) byCanon.set(s.canonical_name, (byCanon.get(s.canonical_name) ?? 0) + 1);
for (const [name, count] of [...byCanon.entries()].sort()) {
  console.log(`  ${name.padEnd(35)} ${count} pattern(s)`);
}

store.close();
