# LX Parser v2

This is a static, client-side dashboard for pharmacy inventory data that arrives as messy Arabic/English spreadsheets. Remote Google Sheets and local files both go through the **same** parser, which auto-detects the layout and absorbs everyone's personal typos.

## What makes it robust
| Problem in the source data | How it's handled |
|---|---|
| Title rows, blank rows, header not on row 1 | Header row is scored and detected (`parser/headers.js`) |
| Two-row / merged headers (`الكميات` over pharmacy names) | Detected automatically, merges expanded (`reader.js`) |
| Wide layout (pharmacies as columns) vs long (one row per record) | Detected automatically, with a toggle in the wizard |
| Header typos: `الصنـــف`, `الوحده`, `اسم الصنف`, `Item Name` | Synonym vocabulary + fuzzy matching; falls back to the column contents |
| Merged/grouped label cells | Fill-down is auto-enabled when blanks look grouped |
| Totals rows/columns, repeated headers (page breaks) | Skipped and counted |
| `١٢`, `۱۵`, `12,5`, `1.234,5`, `٣٫٥`, `5 علب`, `3+2`, `عشرة`, `x3`, `150 ج.م` | Repaired and logged as *Auto-corrected* |
| `#REF!`, `#N/A`, `-`, `لا يوجد`, `ـــ` | Formula error (skipped and flagged) or intentional empty |
| Pharmacy spelled differently (`الشرطه`, `ابو  حمص`, `أدكو`, `شبرا خيت`) | Resolver: letter folding, then user alias, then a guarded fuzzy match |
| `كفر الدوار` vs `كفر الدوار ق.ع`, `Omeprazole` vs `Esomeprazole`, Tab vs Susp | Guards keep these **separate** (site qualifiers, affixes, dosage forms, name stems) |
| Region spelled `1`, `الاولي`, `التانيه`, `Region 3` | Canonicalised region |
| Unit `علبه`/`علب`/`Box` · `Amp`/`امبولات` | Unit dictionary |
| CSV in Windows-1256, `;`/TAB/`،` delimiters, BOM, HTML-table ".xls" | Encoding fallback, delimiter sniffing, content sniffing |

Price keys ignore spelling differences, so all the variants of an item share one price.

## Structure
```
index.html            markup only
css/  tokens · base · components · responsive
js/theme-boot.js      sets the theme before first paint
js/core/    config.js (sources, default pharmacies, thresholds) · text.js (normalise / similarity / search)
js/parser/  numbers · headers · reader · resolver · engine   ← pure, no DOM, unit-tested
js/data/    store (localStorage + IndexedDB) · state (+v1 migration) · sources · database
js/ui/      dom · table (one generic paginated/sortable table) · views · filters · importer · actions · chrome
js/app.js   boot / sync / rebuild orchestrator
js/vendor/xlsx.full.min.js   SheetJS (local copy)
tests/      parser.test.html (111 cases) · wizard*.html (import wizard harness with a messy workbook)
```

## Views & URLs
`?view=view-overview | view-breakdown | view-pricing | view-pharmacies | view-missing | view-anomalies`, plus `&q=&cat=&reg=&branch=&pharm=&unit=`. The hash form `#view=view-anomalies&tab=variants|duplicates|issues` also works.

**Data Health** has three tabs:
- **Parse Issues:** filterable by severity.
- **Name Variants:** auto-merges and suggestions, with Merge / Different / Split actions.
- **Duplicates:** duplicate rows, detected after name merging.

## Storage
- **localStorage** (same `uni_*` keys as v1): prices (schema 2, migrated automatically), price labels, pharmacy→region map, alias rules, views, preferences.
- **IndexedDB** `lx_parser_local_sources`:
  - the original bytes of each local file plus its wizard config, re-parsed automatically after parser upgrades;
  - the cache of each remote source.

## Not implemented / next steps
- No server and no multi-user sync: all data lives in this browser. You can export or import the templates to move it.
- Add a unit column for the remote sheets if units start arriving mixed.
- Possibly export and import the alias rules as a file, to share them between machines.
- Add more synonyms to `VOCAB` in `parser/headers.js` and to `UNIT_FAMILIES` in `parser/resolver.js` as new spellings show up.
