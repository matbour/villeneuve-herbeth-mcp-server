# villeneuve-herbeth-mcp-server

MCP server + curation pipeline for the **Villeneuve / Herbeth Immobilier**
copropriété extranet (`crypto-extranet.com`). Wraps the syndic's badly-named,
mis-categorized PDF dump into a properly classified, OCR-indexed, full-text
searchable parallel filesystem.

See [`CLAUDE.md`](./CLAUDE.md) for the **document classification reference**
(target tree, doc_type signals, filename convention, canonical suppliers,
known quirks).

## Quick start

```bash
# Install deps
bun install

# Stdio (single-user, local — used by Claude Code / Claude Desktop)
cp .env.example .env  # set HERBETH_USERNAME / HERBETH_PASSWORD
bun run start

# HTTP (multi-user, Docker-friendly)
MCP_TRANSPORT=http PORT=3000 bun run start
# → each request carries `Authorization: Basic base64(login:password)`
#   with the caller's own Herbeth extranet credentials.
```

The server is registered for Claude Code via `.mcp.json`.

## Authentication

| Transport | Where credentials come from |
|-----------|------------------------------|
| `stdio`   | `HERBETH_USERNAME` + `HERBETH_PASSWORD` env vars |
| `http`    | **Per-request HTTP Basic auth** — each caller sends their own Herbeth extranet login. The server holds no shared credentials. |

In HTTP mode the server returns `401 + WWW-Authenticate: Basic realm="herbeth-extranet"`
when the header is missing. If the credentials are rejected by the extranet
(`401`/`403` upstream), the server forwards `401` with a detail message.

The metadata SQLite database is shared across all callers — it represents
the curated VILLENEUVE catalog.

---

## MCP tools

All tools are exposed by the server. Stay in sync with `src/server.ts` —
when adding/removing a tool, update both this section and the trigger note
in `CLAUDE.md`.

### Extranet I/O

#### `get_current_user`
Return the currently logged-in extranet user (id, login, role,
copropriété, conseil membership, last connection date). Useful to verify
the session is healthy.

**Args:** none

#### `list_classeurs`
List the top-level document folders (classeurs) for an extranet space.

**Args:**
- `space`: `"coproprietaire" | "conseil-syndical"` (default `conseil-syndical`)

**Returns:** `[{id, nom, parent, fileCount, dateActualisation}]`

#### `list_documents`
List documents inside a classeur. Each result merges in the user-curated
metadata from the local DB (corrected title, doc_type, supplier, amount,
target_classeur, target_filename, …) when present.

**Args:**
- `space` (default `conseil-syndical`)
- `classeur_id` *or* `classeur_name` (case-insensitive)
- `limit` (max 500)

#### `download_file`
Download a document by id. In stdio mode saves to disk; in HTTP mode (or
`return_base64=true`) returns the contents as base64.

**Args:**
- `document_id` (required)
- `output_path`, `output_dir` (optional, stdio mode only)
- `overwrite` (default `false`)
- `return_base64` (auto-true in HTTP via `MCP_DOWNLOAD_RETURN_BASE64=1`)

### Curated metadata

#### `get_document_metadata`
Read the full user-curated metadata for a document. Returns `null` if no
metadata row exists yet.

**Args:** `document_id`

#### `set_document_metadata`
Upsert curated metadata. Only fields explicitly provided are touched.
Pass `null` to clear a single field. `tags` and `extra` are wholesale
replacements (`[]` / `{}` to clear). Captures a snapshot of the source's
extranet state when `capture_source_snapshot=true` (default) and a
`source_classeur_id` hint is available.

**Args (all optional except `document_id`):**
`doc_type`, `title`, `classeur_id`, `target_classeur`, `target_filename`,
`supplier`, `amount_cents`, `amount_ht_cents`, `vat_cents`, `currency`,
`document_date`, `period_start`, `period_end`, `reference`, `language`,
`tags`, `notes`, `extra`, `capture_source_snapshot`, `source_classeur_id`,
`space`.

#### `delete_document_metadata`
Delete all curated metadata for a document. Source file on the extranet
is not affected.

**Args:** `document_id`

#### `search_documents`
Structured query over the curated metadata DB. Combines filters; only
returns rows that have curated metadata.

**Args (all optional):** `text`, `doc_type`, `supplier`, `tag`,
`classeur_id`, `target_classeur`, `reference`, `document_date_from`,
`document_date_to`, `amount_min_cents`, `amount_max_cents`, `limit`.

### Full-text search

#### `full_text_search`
SQLite FTS5 query over indexed metadata + OCR text. Returns ranked
hits with bm25 scores and snippet markers (`«match»`).

Diacritics are folded (`lavéran` matches `laveran`). Query syntax:
- bare terms: `FZ NETTOYAGE`
- exact phrase: `"126-128 Strasbourg"`
- boolean: `cuisine AND extincteur`
- prefix: `ascens*`
- per-column: `supplier:ATHOME`

**Args:** `query`, `limit` (default 50, max 500)

#### `rebuild_search_index`
Re-populate the FTS5 index from the current `document_metadata` table +
OCR text files. Run after a bulk metadata change or after `import_database`.

**Args:** none

### Suppliers (canonicalization)

#### `list_suppliers`
List every entry in the suppliers canonicalization table. Each row maps
a regex `pattern` (case-insensitive) to a `canonical_name`. Lower
`priority` = checked first.

**Args:** none

#### `add_supplier`
Add or update a supplier rule. Idempotent on `(canonical_name, pattern)`.

**Args:** `canonical_name`, `pattern` (regex source), `priority` (default 100)

#### `delete_supplier`
Delete a rule by id.

**Args:** `id`

#### `canonicalize_supplier`
Test what canonical name a raw input string would resolve to.

**Args:** `raw`

### Database export / import

#### `export_database`
Dump the metadata DB to a file.

**Args:**
- `output_path` (required)
- `format`: `"sqlite"` (atomic `VACUUM INTO`, default) | `"json"`

Returns absolute path, file size, per-table row counts.

#### `import_database`
Restore or merge into the metadata DB. Auto-detects format from extension
(`.db` / `.sqlite` → binary restore; `.json` → JSON merge).

**Args:**
- `input_path`
- `mode`: `"merge"` (default, INSERT OR REPLACE per row) | `"replace"`
  (truncate then insert). Only applies to JSON imports — binary always
  replaces.

### Stats

#### `metadata_stats`
Aggregate counts: total annotated docs, breakdown by `doc_type`, top
suppliers (capped at 50), breakdown by `target_classeur`.

**Args:** none

---

## CLI scripts

All under `scripts/`. Idempotent, runnable independently. The pipeline
order to go from "raw extranet" → "curated parallel filesystem" is:

```bash
bun run scripts/seed-suppliers.ts            # 1. populate suppliers regex table
bun run scripts/download-sources.ts          # 2. download every doc → data/sources/<md5>__<orig>
bun run scripts/ocr-sources.ts               # 3. ocrmypdf + pdftotext → data/{ocr,text}/
bun run scripts/bulk-annotate.ts             # 4. title-based first-pass classification
bun run scripts/reextract-metadata.ts        # 5. OCR-text-based extraction + content reclassification
bun run scripts/split-multi-docs.ts          # 6. qpdf-split bundled PDFs (bank-statement bundles, multi-invoice files)
bun run scripts/ocr-sources.ts               # 7. OCR the new split children
bun run scripts/reextract-metadata.ts        # 8. extract metadata for split children
bun run scripts/finalize-children.ts         # 9. generate target_filename for split children
bun run scripts/merge-pairs.ts               # 10. qpdf-merge contract+validation letter pairs
bun run scripts/strip-suffix.ts              # 11. drop legacy "(1)/(2)" suffixes
bun run scripts/materialize-fs.ts            # 12. copy data/sources → data/output/<bucket>/<filename>
```

### `seed-suppliers.ts`
Populate the `suppliers` regex table with the canonical-name + pattern
list from `CLAUDE.md`. Idempotent (UNIQUE on `canonical_name, pattern`).

### `download-sources.ts`
Walk every annotated row, download the original PDF from the extranet,
write it to `data/sources/<source_md5>__<safe_original_filename>`,
populate `source_md5` in the DB. Skips files already on disk.

**Flags:** `[sources_dir]` (default `./data/sources`), `--concurrency=N` (default 4)

### `ocr-sources.ts`
For each PDF in `data/sources/`:
- Probe with `pdftotext` first; if the source already has a usable text
  layer (≥150 non-whitespace chars), skip OCR and just cache the text.
- Otherwise run `ocrmypdf --language fra+eng --skip-text --rotate-pages
  --deskew` and then `pdftotext -layout`.

Outputs: `data/ocr/<md5>__<orig>` (searchable PDFs) and
`data/text/<md5>.txt` (plain text). Sets `ocr_status` /
`ocr_text_path` per row.

**Flags:** `[sources_dir] [ocr_dir] [text_dir]`, `--concurrency=N`

### `bulk-annotate.ts`
Per-classeur title-based heuristics. Sets `doc_type`, `target_classeur`,
`target_filename` (and the source-snapshot fields) for each document.
Skips rows whose `target_filename` is already set (so manually-curated
rich entries are preserved). Reads the suppliers table for invoice
canonicalization.

### `reextract-metadata.ts`
Reads each row's cached OCR text and runs:
1. `reclassifyFromContent()` — content-based override of `doc_type` /
   `target_classeur` / `target_filename` for unambiguous patterns
   (e.g. `FICHE SYNTHÉTIQUE DE LA COPROPRIETE`, `CONTRAT ACCEPTE` letters
   with a recognizable subject).
2. Per-doc-type extractor — French-format regex for invoice number,
   document date, HT/VAT/TTC, period, IBAN, supplier recipient, etc.

Always overwrites the extractor-managed fields (with `null` when not
extracted) so re-runs after fixing a pattern actually clear stale values.
Skips rows tagged `extra.manual_curation = true`.

**Flags:** `--only-doc-type=invoice`, `--dry-run`

### `split-multi-docs.ts`
Detect multi-document PDFs from OCR text via per-page header pattern
matching, then `qpdf` each detected sub-document into its own file.
Bank statements use a `(relevé number, date)` signature to avoid
over-segmenting multi-page individual statements.

Children get synthetic negative `document_id` (won't collide with real
extranet ids) plus `parent_document_id`, `parent_page_range`, and an
inherited `doc_type` / `target_classeur`.

**Flags:** `--dry-run`

### `finalize-children.ts`
Generate `target_filename` for split children using doc_type-specific
templates. Always appends `(extrait p.X-Y de #parentID)` for traceback.

### `merge-pairs.ts`
Detect (title, date_commit, classeur) groups of size 2 in
contract/quote/letter classeurs, score each member by validation-letter
markers (`DEVIS ACCEPTE`, `BON POUR ACCORD`, Cabinet Herbeth letterhead,
…), and concatenate `main + validation` via `qpdf --pages`. The merged
file lives at `data/sources/<merged_md5>__<orig>.merged.pdf` with a
synthetic positive id ≥ 10_000_000_000. Originals get
`extra.merged_into = <new_id>` so `materialize-fs.ts` skips them.

Bank-statement classeurs are excluded — their pairs are
`compte courant` / `compte sur livret`, not contract+validation.

**Flags:** `--dry-run`

### `strip-suffix.ts`
One-shot: remove ` (1)` / ` (2)` disambiguation suffixes from existing
`target_filename` values. `materialize-fs.ts` then appends `- id<N>`
only when there's a real cross-doc collision.

### `materialize-fs.ts`
Walk every row that has both `target_classeur` + `target_filename` +
`source_md5` (excluding rows tagged with `extra.split` or
`extra.merged_into`) and `cp` from `data/sources/` to
`data/output/<target_classeur>/<target_filename>`. Detects cross-doc
filename collisions and appends `- id<N>` to disambiguate.

**Flags:** `[output_dir] [sources_dir]` (defaults `./data/output`,
`./data/sources`)

### `export-db.ts`
CLI mirror of `export_database`. `--format=sqlite` (default) or
`--format=json`.

### `import-db.ts`
CLI mirror of `import_database`. Auto-detects format. `--mode=merge`
(default) | `--mode=replace` for JSON imports.

---

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `HERBETH_USERNAME`, `HERBETH_PASSWORD` | — | Required for stdio transport. Ignored by HTTP transport. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `3000` | HTTP port |
| `MCP_DOWNLOAD_RETURN_BASE64` | unset (auto `1` in HTTP container) | Force `download_file` to return base64 instead of writing to disk |
| `HERBETH_DOWNLOAD_DIR` | `~/Downloads/herbeth` | Default `download_file` directory in stdio mode |
| `HERBETH_METADATA_DB` | `./data/metadata.db` | SQLite path. In Docker, `/app/data/metadata.db` (volume) |

## Filesystem layout

```
data/
  metadata.db                 # SQLite (gitignored, mounted as volume in Docker)
  sources/                    # one PDF per (md5, original_filename), authoritative
  ocr/                        # OCR'd searchable PDFs (one per source)
  text/                       # plain-text extraction (one .txt per source md5)
  output/                     # curated parallel filesystem (regenerated)
  output_old/                 # backup of a prior curation run (when present)
  exports/                    # database backups (manual)
```

## Docker

The runtime image bundles `ocrmypdf`, `tesseract` (fra+eng), `poppler-utils`,
`qpdf`, `ghostscript`, `unpaper`, so the full pipeline (including OCR) runs
inside the container.

```bash
docker build -t herbeth-mcp .
docker run --rm -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e MCP_TRANSPORT=http \
  herbeth-mcp
```

`/app/data` is declared as a volume (curated metadata + sources persist
across deploys).

## Development

```bash
bun install
bun run dev           # bun --hot
bun run typecheck     # tsc --noEmit
```

The MCP server can be inspected with the `mcp` CLI:

```bash
npx @modelcontextprotocol/inspector bun run src/index.ts
```
