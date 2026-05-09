# Villeneuve / Herbeth Immobilier — Document classification reference

This file is the canonical reference for classifying scanned French
copropriété documents pulled from the Cabinet Herbeth Immobilier extranet.
Use it both when manually curating individual rows (via the MCP
`set_document_metadata` tool) and when refining the bulk pipeline scripts.

The user's copropriété is **VILLENEUVE**, located at
**126-128 Avenue de Strasbourg + 9 rue Lavéran à METZ (57000)**, registered as
**SDC VILLENEUVE** (immatriculation `AD7-401-599`), syndic
**Cabinet Herbeth Immobilier**. If a document mentions a different copropriété
(LES CHARMILLES, LAMARTINE, NOUILLY, …), flag it via
`extra.misfiled_warning` — it's a syndic upload error.

## Source layout (extranet classeurs)

The extranet groups documents into "classeurs". The numeric ids and contents:

| id   | label                       | space          | typical contents |
|------|-----------------------------|----------------|------------------|
| 91   | Assemblées Générales         | coproprietaire | PV AG / AGE      |
| 93   | Carnet d'entretien           | coproprietaire | mixed: devis validés, contrats, audits, contrôles techniques, ISTA |
| 96   | Contrat de syndic            | coproprietaire | the 3 syndic contracts + 1 fiche synthétique |
| 98   | Divers                       | coproprietaire | catch-all: comptes, devis travaux, convocations |
| 99   | Interventions / Travaux      | coproprietaire | mostly "Devis validé" letters from syndic |
| 910  | Règlement de copropriété     | coproprietaire | règlement, plans, esquisse, clés répartitions |
| 911  | Relevés des charges et produits | coproprietaire | annual statements + personal décomptes (BOUR/NIZET) + appels de fonds |
| 912  | Factures                     | conseil-syndical / coproprietaire | supplier invoices |
| 913  | Conseil syndical             | conseil-syndical | almost entirely BPALC bank statements (compte courant + livret) + the owner list |

Source titles are not trustworthy. Always read the OCR text to confirm.

## Target tree (parallel filesystem under `data/output/`)

```
Assemblées Générales/<année>/PV
Assemblées Générales/<année>/Convocations
Banque/Relevés/<année>
Carnet d'entretien/Audits
Carnet d'entretien/Contrôles techniques
Carnet d'entretien/Diagnostics             (amiante, plomb, DPE, …)
Carnet d'entretien/Devis validés/<année>   (legacy bucket — prefer Travaux/<année>/Devis acceptés)
Carnet d'entretien/À trier                 (cannot determine sub-bucket)
Charges et produits/<exercice>             (relevé général annuel)
Charges et produits/Décomptes personnels/<année>
Charges et produits/Appels de fonds/<année>
Comptes annuels/<exercice>                 (PV-validated annual accounts — NOT the registry fiche)
Contrats/Syndic
Contrats/Assurance
Contrats/Gaz
Contrats/Électricité
Contrats/Eau
Contrats/Entretien parties communes        (FZ Nettoyage, ZANCHI, …)
Contrats/Entretien ascenseurs              (ILEX)
Contrats/Entretien toitures
Contrats/Chaufferie
Contrats/Comptage                          (ISTA, METRONA, télérelevé)
Contrats/Surveillance                      (alarme, télésurveillance)
Contrats/Espaces verts
Contrats/VMC
Contrats/Internet
Contrats/Extincteurs
Contrats/Entretien                         (generic — only when sub-bucket truly unknown)
Factures/<année>                           (all supplier invoices)
Registre copropriété/Fiches synthétiques   (registry-generated synthèse, NOT comptes annuels)
Registre copropriété/Liste copropriétaires
Règlement et plans/Règlement
Règlement et plans/Plans
Travaux/<année>/Devis acceptés             (acceptance letter from syndic to vendor)
Travaux/<année>/Devis fournisseurs         (the actual quote document from the vendor)
Travaux/<année>/Rapports
Travaux/<année>/Études                     (PPPT, DPE collectif, audits préalables…)
Travaux/<année>/Échanges                   (emails, correspondance)
Divers                                     (only as a last resort)
```

Avoid creating new top-level buckets. Within `Contrats/`, prefer specific
sub-buckets over generic catch-alls. Never use a bucket called `Validations`
— a contract acceptance is still a contract; classify by subject (Gaz,
Entretien parties communes, …).

## Filename convention

```
<YYYY-MM-DD> - <Type ou Fournisseur> - <description courte> [- Réf <ref>] [- <montant> €].pdf
```

- French, accents preserved, spaces allowed.
- No `(1)` / `(2)` disambiguation — `materialize-fs.ts` appends `- id<N>` only
  on real cross-doc collisions.
- Forbidden chars: `\\ / : * ? " < > |` (Windows-incompatible). Slash and
  colon especially.
- For split children, append `(extrait p.X-Y de #parentID)` for trace-back.
- Trailing `.pdf` extension always.

Examples:
```
2026-04-23 - Facture FZ Nettoyage - Avril 2026 - Réf 26-04-67644 - 1560,00 €.pdf
2025-10-17 - PV Assemblée Générale.pdf
2026-03-31 - Relevé bancaire BPALC n°3 - Mars 2026.pdf
2025-11-13 - Contrat de syndic - 2025 à 2028.pdf
2026-05-04 - Contrat fourniture de gaz.pdf
2025-01-14 - Décompte BOUR-NIZET n°1294650179.pdf
```

## Document types (`doc_type`)

The `doc_type` enum is in `src/metadata.ts` (`DOC_TYPES` constant). Below is
how to recognize each from OCR text and where it goes.

### `invoice` — Facture fournisseur

**Signals:** `FACTURE`, `Facture N°`, `Total HT / TVA / TTC`, supplier
letterhead at the top, "Cdts règlement", invoice number.

**Where:** `Factures/<année>` (year from `document_date`, or `date_commit` if
the invoice date is missing).

**Extract:** `reference`, `document_date`, `amount_cents` (TTC),
`amount_ht_cents`, `vat_cents`, `currency` (default EUR), `period_start` /
`period_end` if covering a service period.

**Filename:** `<date> - Facture <SUPPLIER> - <description> - Réf <ref> - <amount> €.pdf`

**Canonical suppliers** (use these spellings consistently — managed in the
`suppliers` SQLite table; extend via the `add_supplier` MCP tool):
ATHOME, ILEX LORRAINE, FZ NETTOYAGE, GAZ EUROPEEN, CDR MAINTENANCE, UEM,
THEMEL, ISTA, LOMANTO, SOTECO, SAS SERRURERIE AUSESKY, SL SANITAIRE, MDE,
SANISOLAIR, HYDROCLEAN ASSAINISSEMENT, GAN ASSURANCES, FRITZINGER, TALON
SERVICE, SPANNAGEL Gilles, PFF FACADE, EUROFEU, AB SAV, SCHERTZ
AMENAGEMENTS, MALEZIEUX, IN ARBORIS, HYGIENE EST PEST CONTROL, METRONA,
NUMERICABLE, BURGER PEINTURE, CABINET HERBETH, BANQUE POPULAIRE ALSACE
LORRAINE CHAMPAGNE.

**Multi-invoice PDFs** (e.g. ATHOME reprographie batches): split with
`scripts/split-multi-docs.ts`. Each child gets `(extrait p.X-Y de #parentID)`
in its filename for trace-back.

### `quote` — Devis fournisseur

**Signals:** `DEVIS`, `DEVIS N°`, line items with PU HT / Mtt HT, supplier
letterhead, no acceptance signature.

**Where:** `Travaux/<année>/Devis fournisseurs`

### `quote_acceptance_letter` — Lettre d'acceptation de devis

**Signals:** Cabinet Herbeth letterhead, `DEVIS ACCEPTE` / `DEVIS ACCEPTÉ`
banner near the top, addressed to a vendor (`Monsieur X,`), short body.

**Where:** `Travaux/<année>/Devis acceptés`

These often come paired with the actual quote attachment — `merge-pairs.ts`
stitches them into one PDF (substantive document first, acceptance letter as
annex).

### `contract` — Contrat

**Signals:** the syndic's `CONTRAT ACCEPTE` banner at the top, OR a
multi-page contract document with parties / period / signatures, OR title
matches "Contrat de syndic du X au Y".

**Where:** `Contrats/<sub-bucket>` based on subject:

| Subject in body                                    | Sub-bucket                       |
|----------------------------------------------------|----------------------------------|
| `contrat de syndic`                                | `Contrats/Syndic`                |
| `contrat (multirisque\|d'assurance)`               | `Contrats/Assurance`             |
| `contrat (de \|pour la )?fourniture de gaz`        | `Contrats/Gaz`                   |
| `contrat (de \|pour la )?fourniture d'électricité` | `Contrats/Électricité`           |
| `contrat fourniture d'eau`                         | `Contrats/Eau`                   |
| `contrat d'entretien des parties communes` / `entretien PC` | `Contrats/Entretien parties communes` |
| `contrat d'entretien (d')?ascenseur`               | `Contrats/Entretien ascenseurs`  |
| `contrat d'entretien des toitures terrasses`       | `Contrats/Entretien toitures`    |
| `contrat d'entretien (de la )?chaufferie/chaudière`| `Contrats/Chaufferie`            |
| `contrat (de )?(répartition\|comptage\|ISTA\|METRONA\|télérelevé)` | `Contrats/Comptage` |
| `contrat (de )?(surveillance\|alarme\|télésurveillance)` | `Contrats/Surveillance`     |
| `contrat d'entretien (des )?(espaces verts\|jardin)` | `Contrats/Espaces verts`       |
| `contrat d'entretien (de la )?(VMC\|ventilation)`  | `Contrats/VMC`                   |
| `contrat (d')?internet \| fibre`                   | `Contrats/Internet`              |
| `contrat maintenance (des )?extincteur(s)?`        | `Contrats/Extincteurs`           |
| otherwise                                          | `Contrats/Entretien` (generic — last resort) |

**Extract** when present: `period_start` / `period_end`, `reference`
(contract number), `supplier`.

### `meeting_minutes` — Procès-verbal d'AG

**Signals:** `Procès-verbal de l'Assemblée Générale Ordinaire/Extraordinaire`,
followed by the meeting date and a list of résolutions with vote tallies
(tantièmes pour / contre / abstention).

**Where:** `Assemblées Générales/<année>/PV`

**Extract:** `document_date` (meeting date, NOT upload date),
`extra.kind` = `AGO` | `AGE`, `extra.resolutions_count`.

**Filename:** `<date> - PV Assemblée Générale[E].pdf`

### `meeting_convocation` — Convocation d'AG

**Signals:** "Convocation à l'Assemblée Générale Ordinaire/Extraordinaire",
ordre du jour list, no résolutions / vote tallies (these come in the PV).

**Where:** `Assemblées Générales/<année>/Convocations`

### `annual_accounts` — Comptes annuels validés

**Signals:** "Comptes de l'exercice clos le 31/12/YYYY", balance sheet,
trésorerie, charges courantes / fonds de travaux. ⚠️ NOT to be confused
with the `FICHE SYNTHÉTIQUE` (registration_form) — the syndic sometimes
labels the latter "Comptes 2024" in the extranet.

**Where:** `Comptes annuels/<exercice>`

### `bank_statement` — Relevé bancaire

**Signals:** `Votre relevé de compte n°X au DD/MM/YYYY`, BPALC letterhead
(BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE), IBAN starting `FR76 1470 7000 …`,
columns DATE COMPTA / LIBELLÉ / DATE OPÉRATION / DATE VALEUR / MONTANT.

**Where:** `Banque/Relevés/<année>` (year from `period_end`).

**Pairs:** Each month usually has TWO statements (compte courant +
compte sur livret). They share the same upload title but have distinct
relevé numbers — `split-multi-docs.ts` dedupes via the `(numéro, date)`
signature.

**Multi-statement PDFs** (e.g. "09/2023 à 10/2024" bundles): split per
distinct `(relevé number, date)` signature.

**Extract:** `extra.releve_number`, `extra.iban`, `extra.bic`,
`extra.account_name`, `extra.solde_final_cents`.

**Filename:** `<YYYY-MM> - Relevé bancaire BPALC n°<N>.pdf`

### `regulation` — Règlement de copropriété

Single document. **Where:** `Règlement et plans/Règlement`

### `plan` — Plans, esquisses

**Signals:** floor plans, parking diagrams, "Esquisse", "126-128 av. Strasbourg".

**Where:** `Règlement et plans/Plans`

### `registration_form` — Fiche synthétique copropriété

**Signals:** `FICHE SYNTHÉTIQUE DE LA COPROPRIETE AD7-401-599`,
`(conforme aux dispositions de l'article 8-2 de la loi n° 65-557 du 10 juillet 1965)`,
"générée à partir des données mises à jour le DD/MM/YYYY".

**Where:** `Registre copropriété/Fiches synthétiques`

⚠️ The syndic sometimes labels this "Comptes 2024" / "compte 2024" — NEVER
trust the title for these. Reclassify by content (the `reclassifyFromContent`
function in `scripts/reextract-metadata.ts` handles this automatically).

**Filename:** `<YYYY-MM-DD> - Fiche synthétique copropriété.pdf` (date = the
"générée le" date).

### `owner_list` — Liste des copropriétaires

Single document, refreshed periodically. **Where:** `Registre copropriété/Liste copropriétaires`

### `cost_allocation_keys` — Clés de répartition

**Where:** `Règlement et plans/Règlement` (alongside the règlement itself).

### `letter` — Courrier / email

**Signals:** "Re:", "Tr:", body of an email exchange, "Madame, Monsieur,",
no specific document type signal.

**Where:** `Travaux/<année>/Échanges` if the topic is a travaux exchange,
else `Divers`.

### `report` — Rapport / audit / contrôle

**Signals:** "Rapport d'intervention", "Audit collectif", "Contrôle Technique
Quinquennal Ascenseur", "Diagnostic amiante", "DTA".

**Where:** `Carnet d'entretien/Audits` for audits, `Carnet d'entretien/Contrôles
techniques` for contrôles, `Carnet d'entretien/Diagnostics` for diagnostics
amiante/plomb/DPE.

### `other` — Tout le reste

Use sparingly. Prefer a specific type even if the bucket is generic.

## Provenance & traceability

For every curated document, the DB stores:
- `source_md5` — MD5 of the original PDF bytes
- `source_file_name` — the original extranet filename (`<digits>.PDF`)
- `source_title` — what the syndic typed when uploading
- `source_classeur_id` — extranet folder it was uploaded to
- `source_date_commit` — extranet upload date

Every original PDF is preserved at:
```
data/sources/<source_md5>__<source_file_name>
```

Splits live next to it as `<child_md5>__<source_file_name>.split.<n>.pdf`.
Merges as `<merged_md5>__<source_file_name>.merged.pdf`.

For split children, the curated filename includes
`(extrait p.X-Y de #<parent_doc_id>)` so the human reader can trace any
output file back to its source.

## Misfiling detection

Every invoice's recipient is parsed from the OCR (`SDC <NAME>`,
`Résidence <NAME>`). If the recipient is NOT VILLENEUVE / LAVÉRAN / 126-128
Strasbourg, set `extra.misfiled_warning` with a message. So far we've
caught: **LES CHARMILLES**, **LAMARTINE**, **NOUILLY** invoices wrongly
uploaded into the Villeneuve extranet.

## Manual curation

Set `extra.manual_curation = true` on a row to permanently freeze it from
re-extraction. The `reextract-metadata.ts` and `bulk-annotate.ts` scripts
both honor this flag.

---

## Current corpus snapshot

As of the latest pipeline run (use these as ground-truth examples when
deciding new docs).

### `doc_type` distribution (live, post-merge / post-split)

| doc_type                  | count |
|---------------------------|-------|
| invoice                   | 232   |
| bank_statement            | 91    |
| quote_acceptance_letter   | 62    |
| contract                  | 22    |
| report                    | 16    |
| meeting_minutes           | 8     |
| letter                    | 7     |
| registration_form         | 6     |
| quote                     | 5     |
| other / plan              | 3 ea. |
| annual_accounts / meeting_convocation | 2 ea. |
| cost_allocation_keys / owner_list / regulation | 1 ea. |

### `target_classeur` totals (most populated buckets)

| bucket                                 | count |
|----------------------------------------|-------|
| `Factures/2025`                        | 129   |
| `Factures/2024`                        | 69    |
| `Factures/2026`                        | 34    |
| `Banque/Relevés/À ventiler`            | 26    |
| `Banque/Relevés/2025`                  | 24    |
| `Travaux/2025/Devis acceptés`          | 20    |
| `Travaux/2024/Devis acceptés`          | 12    |
| `Travaux/2023/Devis acceptés`          | 12    |
| `Banque/Relevés/2022`                  | 12    |
| `Banque/Relevés/2021`                  | 10    |
| `Banque/Relevés/2020`                  | 9     |
| `Carnet d'entretien/Devis validés/2026`| 6     |
| `Travaux/2022/Devis acceptés`          | 6     |
| `Travaux/2026/Devis acceptés`          | 5     |
| `Charges et produits/Décomptes personnels/2025` | 5 |
| `Contrats/Syndic`                      | 3     |
| `Contrats/Entretien parties communes`  | 3     |
| `Contrats/Surveillance`                | 3     |
| `Contrats/Gaz`                         | 2     |
| `Contrats/Assurance`                   | 2     |
| `Contrats/Entretien toitures`          | 1     |

`Banque/Relevés/À ventiler` holds the bundled multi-period statements that
`split-multi-docs.ts` couldn't fully break apart yet — manual curation
needed.

### Top suppliers (live count)

| supplier                                         | count |
|--------------------------------------------------|-------|
| BANQUE POPULAIRE ALSACE LORRAINE CHAMPAGNE       | 78    |
| ATHOME                                           | 42    |
| ILEX LORRAINE                                    | 35    |
| FZ NETTOYAGE                                     | 25    |
| GAZ EUROPEEN                                     | 25    |
| CABINET HERBETH                                  | 9     |
| CDR MAINTENANCE                                  | 9     |
| SAS SERRURERIE AUSESKY                           | 9     |
| THEMEL                                           | 9     |
| UEM                                              | 8     |
| LOMANTO                                          | 6     |
| SOTECO                                           | 5     |
| HYDROCLEAN ASSAINISSEMENT / SANISOLAIR / SL SANITAIRE | 4 ea. |
| FRITZINGER / GAN ASSURANCES                      | 3 ea. |

### Known misfiled invoices (recipient ≠ VILLENEUVE)

| recipient        | count | comment |
|------------------|-------|---------|
| LES CHARMILLES   | 1     | FZ Nettoyage invoice for a different copro |
| LAMARTINE        | 2     | invoices uploaded into the wrong extranet |
| VILLENE          | 2     | OCR truncation false positive — likely Villeneuve, ignore |

### Filename examples per bucket (real)

```
Factures/2025/2025-01-07 - Facture FZ NETTOYAGE - Décembre 2024.pdf
Factures/2025/2025-01-07 - Facture UEM - Décembre 2024.pdf
Factures/2026/2026-04-23 - Facture FZ NETTOYAGE - Avril 2026 - Réf 26-04-67644 - 1560,00 €.pdf

Banque/Relevés/2025/2025-01 - Relevé bancaire BPALC.pdf
Banque/Relevés/2025/2025-03 - Relevé bancaire BPALC - id117396423.pdf

Charges et produits/Décomptes personnels/2025/2025-03-14 - Décompte BOUR-NIZET n°1285512886.pdf

Contrats/Syndic/2019-06-24 - Contrat de syndic 2019-06-24 → 2022-06-23.pdf
Contrats/Syndic/2022-06-23 - Contrat de syndic 2022-06-23 → 2025-10-20.pdf
Contrats/Syndic/2025-10-17 - Contrat de syndic 2025-10-17.pdf

Assemblées Générales/2025/PV/2025-01-14 - PV Assemblée Générale.pdf
Assemblées Générales/2025/PV/2025-10-17 - PV Assemblée Générale.pdf

Carnet d'entretien/Diagnostics/2014-08-22 - Diagnostic amiante.pdf

Règlement et plans/Plans/2018-05-18 - Plan parking souterrain.pdf
Règlement et plans/Plans/2019-05-09 - Esquisse.pdf

Registre copropriété/Fiches synthétiques/2025-03-03 - Fiche synthétique copropriété.pdf

Travaux/2025/Devis acceptés/2025-04-16 - Devis accepté - Travaux - id117396382.pdf
```

The `- id<N>` suffix only appears when two distinct docs would otherwise
collide on the same filename — `materialize-fs.ts` adds it automatically.

### Pipeline scripts (run order)

```bash
bun run scripts/seed-suppliers.ts            # one-time: populate the suppliers regex table
bun run scripts/download-sources.ts          # fetch all PDFs into data/sources/
bun run scripts/ocr-sources.ts               # ocrmypdf + pdftotext into data/{ocr,text}/
bun run scripts/bulk-annotate.ts             # title-based first pass
bun run scripts/reextract-metadata.ts        # OCR-text-based extraction + content reclassification
bun run scripts/split-multi-docs.ts          # qpdf-split bundled PDFs (bank statement bundles, multi-invoice files)
bun run scripts/ocr-sources.ts               # OCR the new split children
bun run scripts/reextract-metadata.ts        # extract metadata for split children
bun run scripts/finalize-children.ts         # generate target_filename for split children
bun run scripts/merge-pairs.ts               # qpdf-merge contract+validation letter pairs
bun run scripts/strip-suffix.ts              # one-shot: drop legacy " (1)/(2)" suffixes
bun run scripts/materialize-fs.ts            # copy data/sources → data/output/<bucket>/<filename>
```

All scripts are idempotent and can be re-run safely.

### Open issues / known wrinkles

- `Banque/Relevés/À ventiler` (26 files) holds bundled multi-period bank
  statements that the splitter couldn't fully demux. Most are old "X/YYYY -
  Y/YYYY" archive batches. Need manual triage.
- 4 invoices have supplier prefix `N°XXXXX` instead of a vendor name —
  source title is just an invoice number with no supplier label. Need PDF
  inspection.
- 1 OCR failure: doc 164970293 — corrupt source PDF.
- Some `Contrats/Surveillance` triplet entries are actually ILEX devis
  acceptance letters miscategorized by an over-broad regex match. Prefer
  manual reclassification or run the LLM-classifier when re-tooling.

