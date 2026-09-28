/* ==========================================================================
   LX Parser — parser/engine.js
   Sheet profiling + record extraction. One engine for BOTH remote CSVs
   and local workbooks, so every source gets the same robustness.

   Layouts
     wide  one row per item, one numeric column per pharmacy
           (الصنف | الوحدة | دمنهور | ادكو | … | الاجمالي)
     long  one row per (pharmacy, item)
           (الصيدلية | الصنف | الوحدة | الكمية | السعر)

   profileSheet(sheet, hints)  → config (auto-detected, user-editable)
   extractSheet(sheet, config, ctx) → { records, anomalies, stats, missing }

   Records are RAW (only cleaned); canonicalisation happens in data/database
   so alias/registry changes re-apply without re-reading files.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, N = LX.numbers, H = LX.headers, C = LX.config;

    const LABEL_FIELDS = ['i', 'u', 'p', 'branch', 't', 'reg'];
    const REQUIRED = {
        long: [['i', 'Item'], ['p', 'Pharmacy'], ['q', 'Quantity']],
        wide: [['i', 'Item'], ['wq', 'at least one pharmacy column']]
    };

    /* ---------- column statistics ---------- */

    function columnStats(grid, startRow, width) {
        const end = Math.min(grid.length, startRow + C.PROFILE_SAMPLE_ROWS);
        const stats = [];
        for (let j = 0; j < width; j++) {
            let filled = 0, numeric = 0, blank = 0, textLen = 0;
            const distinct = new Set(), sample = [];
            for (let r = startRow; r < end; r++) {
                const v = (grid[r] || [])[j];
                if (H.isBlank(v) || (typeof v === 'string' && N.isIntentionalEmpty(v))) { blank++; continue; }
                filled++;
                if (sample.length < 4) sample.push(T.clean(v).slice(0, 30));
                // A cell is "numeric" if it is a clean number, or a SHORT messy one ("5 علب").
                // Long text that merely contains a number ("بنادول 500 مجم") is text.
                const pr = N.parseNumber(v);
                const len = T.clean(v).length;
                if (pr.status === 'ok' || (pr.status === 'corrected' && len <= 10)) numeric++;
                else { textLen += len; distinct.add(T.matchKey(v)); }
            }
            const total = Math.max(1, end - startRow);
            stats.push({
                filled, blank,
                fillRatio: filled / total,
                numericRatio: filled ? numeric / filled : 0,
                distinctText: distinct.size,
                avgTextLen: (filled - numeric) ? textLen / (filled - numeric) : 0,
                sample
            });
        }
        return stats;
    }

    /* ---------- profiling ---------- */

    function profileSheet(sheet, hints) {
        hints = hints || {};
        const grid = sheet.grid || [];
        const issues = [];
        if (!grid.length) {
            return { headerRowIdx: 0, headerDepth: 1, layout: 'long', columnMap: {}, fillDir: {}, classLabel: hints.classLabel || '', included: false, confidence: 0, issues: ['Sheet is empty'] };
        }

        const headerRowIdx = hints.headerRowIdx != null ? hints.headerRowIdx : H.detectHeaderRow(grid);
        const headerDepth = hints.headerDepth != null ? hints.headerDepth : H.detectHeaderDepth(grid, headerRowIdx);
        const { labels, groups } = H.buildHeaderLabels(grid, headerRowIdx, headerDepth);
        const dataStart = headerRowIdx + headerDepth;
        const stats = columnStats(grid, dataStart, labels.length);

        // Best field guess per column
        const guesses = labels.map((lab, j) => {
            let cls = H.classifyHeader(lab);
            // group label like "الكميه" above pharmacy names should not claim the column
            if ((!cls.length || cls[0].score < 0.75) && groups[j]) cls = [];
            return { j, cls: cls.filter(c => c.score >= 0.72) };
        });

        const columnMap = {};
        labels.forEach((_, j) => { columnMap[j] = 'ignore'; });
        const claimed = new Set();

        // Assign each labelled field to its best-scoring column (one column per field)
        ['i', 'p', 'u', 'q', 'price', 'branch', 't', 'reg'].forEach(field => {
            let best = null;
            guesses.forEach(g => {
                if (claimed.has(g.j)) return;
                const c = g.cls.find(x => x.field === field);
                if (!c || g.cls[0].field === 'total') return;
                // top guess for this column must be this field (or near-tie)
                if (g.cls[0].field !== field && g.cls[0].score - c.score > 0.05) return;
                let s = c.score;
                const st = stats[g.j];
                // data sanity: text fields should be text, numeric fields numeric
                if (field === 'q' || field === 'price') s += (st.numericRatio - 0.5) * 0.3;
                else s += (0.5 - st.numericRatio) * 0.3;
                if (field === 'i') s += Math.min(0.15, st.avgTextLen / 100);
                if (!best || s > best.s) best = { j: g.j, s };
            });
            if (best && best.s > 0.6) { columnMap[best.j] = field; claimed.add(best.j); }
        });

        // Fallback item column: the most "texty" column with long, varied text
        if (!Object.values(columnMap).includes('i')) {
            let best = null;
            stats.forEach((st, j) => {
                if (claimed.has(j)) return;
                const score = st.fillRatio * (1 - st.numericRatio) * Math.min(1, st.distinctText / Math.max(1, Math.min(10, st.filled))) * Math.min(1, st.avgTextLen / 8);
                if (!best || score > best.score) best = { j, score };
            });
            if (best && best.score > 0.25) {
                columnMap[best.j] = 'i'; claimed.add(best.j);
                issues.push(`No "Item" header found — guessed column ${best.j + 1} ("${labels[best.j] || 'blank'}") from its contents`);
            }
        }

        // Layout decision
        const has = f => Object.values(columnMap).includes(f);
        let layout = hints.layout || null;
        const wideCandidates = [];
        labels.forEach((lab, j) => {
            if (claimed.has(j)) return;
            if (!lab || lab.startsWith('_')) return;
            const top = (H.classifyHeader(lab)[0] || {});
            if (top.field === 'total' || (top.field === 'ignore' && top.score >= 0.9)) return;
            if (H.isTotalLabel(groups[j] || '')) return;
            const st = stats[j];
            const numericish = st.filled === 0 || st.numericRatio >= 0.35;
            const texty = st.filled >= 5 && st.numericRatio < 0.2 && st.avgTextLen > 12;
            if (numericish && !texty) wideCandidates.push(j);
        });

        if (!layout) {
            if (has('p') && has('q')) layout = 'long';
            else if (!has('p') && wideCandidates.length >= 1 && (!has('q') || wideCandidates.length >= 2)) layout = 'wide';
            else layout = 'long';
        }

        if (layout === 'wide') {
            // In wide layout a stray "الكميه" header is just one of the value columns
            labels.forEach((_, j) => { if (columnMap[j] === 'q' || columnMap[j] === 'p') { columnMap[j] = 'ignore'; claimed.delete(j); } });
            wideCandidates.forEach(j => { if (columnMap[j] === 'ignore') columnMap[j] = 'wq'; });
        }

        // Auto fill-down for label columns that look like merged/grouped blocks
        const fillDir = {};
        labels.forEach((_, j) => { fillDir[j] = 'none'; });
        Object.keys(columnMap).forEach(j => {
            const f = columnMap[j];
            if (!['p', 'branch', 't', 'reg'].includes(f)) return;
            if (autoFillLooksRight(grid, dataStart, +j, columnMap)) {
                fillDir[j] = 'down';
                issues.push(`${H.FIELD_LABELS[f]} column has grouped blanks — Fill Down enabled`);
            }
        });

        const cfg = {
            headerRowIdx, headerDepth, layout, columnMap, fillDir,
            classLabel: hints.classLabel || '',
            included: true,
            confidence: 0,
            issues
        };
        const missing = missingFields(cfg);
        cfg.included = missing.length === 0;
        cfg.confidence = confidenceOf(cfg, guesses, missing);
        return cfg;
    }

    /** Blank label cells that sit between filled ones while the row still has data. */
    function autoFillLooksRight(grid, start, j, columnMap) {
        const end = Math.min(grid.length, start + C.PROFILE_SAMPLE_ROWS);
        const qtyCols = Object.keys(columnMap).filter(k => columnMap[k] === 'q' || columnMap[k] === 'wq').map(Number);
        const itemCol = Number(Object.keys(columnMap).find(k => columnMap[k] === 'i'));
        let filled = 0, blankWithData = 0, seenValue = false;
        for (let r = start; r < end; r++) {
            const row = grid[r] || [];
            const hasData = !H.isBlank(row[itemCol]) || qtyCols.some(q => !H.isBlank(row[q]));
            if (!hasData) continue;
            if (H.isBlank(row[j])) { if (seenValue) blankWithData++; }
            else { filled++; seenValue = true; }
        }
        return filled >= 2 && blankWithData >= 2 && blankWithData / (filled + blankWithData) >= 0.25;
    }

    function missingFields(cfg) {
        const vals = Object.values(cfg.columnMap);
        return REQUIRED[cfg.layout].filter(([f]) => !vals.includes(f)).map(([, label]) => label);
    }

    function confidenceOf(cfg, guesses, missing) {
        if (missing.length) return 0.2;
        let c = 0.6;
        const itemGuess = guesses.find(g => cfg.columnMap[g.j] === 'i');
        if (itemGuess && itemGuess.cls[0] && itemGuess.cls[0].field === 'i') c += 0.2;
        if (!cfg.issues.some(s => s.startsWith('No "Item"'))) c += 0.1;
        if (cfg.layout === 'long' && Object.values(cfg.columnMap).includes('u')) c += 0.1;
        if (cfg.layout === 'wide' && Object.values(cfg.columnMap).includes('u')) c += 0.1;
        return Math.min(1, c);
    }

    /* ---------- extraction ---------- */

    function colOf(cfg, field) {
        const e = Object.keys(cfg.columnMap).find(k => cfg.columnMap[k] === field);
        return e == null ? -1 : Number(e);
    }

    function applyFill(rows, fieldCols, dir) {
        let count = 0;
        const order = dir === 'up' ? rows.slice().reverse() : rows;
        const last = {};
        order.forEach(row => {
            if (row._section) { fieldCols.forEach(f => { last[f] = null; }); return; }
            fieldCols.forEach(f => {
                const v = row[f];
                if (v === '' || N.isIntentionalEmpty(v)) {
                    if (last[f] != null) { row[f] = last[f]; (row._filled = row._filled || []).push(f); count++; }
                } else last[f] = v;
            });
        });
        return count;
    }

    function extractSheet(sheet, cfg, ctx) {
        ctx = ctx || {};
        const grid = sheet.grid || [];
        const sourceLabel = ctx.sourceLabel || sheet.name;
        const srcId = ctx.srcId || '';
        const cls = T.clean(cfg.classLabel) || ctx.classLabel || sheet.name;
        const anomalies = [];
        let truncated = false;
        const pushA = a => {
            if (anomalies.length < C.ANOMALY_CAP) anomalies.push(Object.assign({ sheet: sourceLabel, sourceId: srcId }, a));
            else truncated = true;
        };
        const stats = { dataRows: 0, records: 0, filled: 0, sections: 0, repeatedHeaders: 0, totals: 0, blankItems: 0, zero: 0, corrected: 0 };

        const missing = missingFields(cfg);
        if (missing.length) return { records: [], anomalies: [], stats, missing, truncated: false };

        const { labels, groups } = H.buildHeaderLabels(grid, cfg.headerRowIdx, cfg.headerDepth || 1);
        const headerKeys = labels.map(l => T.matchKey(l));
        const start = cfg.headerRowIdx + (cfg.headerDepth || 1);

        const idx = {};
        ['i', 'u', 'p', 'branch', 't', 'reg', 'q', 'price'].forEach(f => { idx[f] = colOf(cfg, f); });
        const wideCols = cfg.layout === 'wide'
            ? Object.keys(cfg.columnMap).filter(k => cfg.columnMap[k] === 'wq').map(Number).filter(j => labels[j] && !H.isTotalLabel(labels[j]) && !H.isTotalLabel(groups[j] || ''))
            : [];

        // 1. Collect logical rows with label fields
        const rows = [];
        for (let r = start; r < grid.length; r++) {
            const raw = grid[r] || [];
            const nonBlank = raw.filter(c => !H.isBlank(c));
            if (!nonBlank.length) continue;

            // repeated header (page break in a printed export)
            let headerHits = 0;
            raw.forEach((c, j) => { if (!H.isBlank(c) && headerKeys[j] && T.matchKey(c) === headerKeys[j]) headerHits++; });
            if (headerHits >= Math.max(2, Math.ceil(nonBlank.length * 0.6))) { stats.repeatedHeaders++; continue; }

            const get = j => j === -1 ? '' : T.clean(raw[j]);
            const row = { _r: r + 1, _raw: raw, i: get(idx.i), u: get(idx.u), p: get(idx.p), branch: get(idx.branch), t: get(idx.t), reg: get(idx.reg) };

            // Title / note row: one lone text cell that isn't in any mapped label column.
            // (A lone cell IN a label column — e.g. a pharmacy name above its block — is kept
            //  so Fill Down can carry it to the rows below.)
            if (nonBlank.length === 1) {
                const j = raw.findIndex(c => !H.isBlank(c));
                const mapped = cfg.columnMap[j];
                if ((!mapped || mapped === 'ignore') && N.parseNumber(raw[j]).status !== 'ok') { stats.sections++; continue; }
            }
            rows.push(row);
        }

        // 2. Fill down / up
        ['down', 'up'].forEach(dir => {
            const cols = LABEL_FIELDS.filter(f => idx[f] !== -1 && cfg.fillDir[idx[f]] === dir);
            if (cols.length) stats.filled += applyFill(rows, cols, dir);
        });

        const labelNames = { i: 'Item', u: 'Unit', p: 'Pharmacy', branch: 'Branch', t: 'Class', reg: 'Region' };
        const records = [];

        const emit = (row, pharmacyName, rawQty, colLabel) => {
            const q = N.parseNumber(rawQty);
            if (q.status === 'empty') return;
            const base = { row: row._r, i: row.i || '-', p: pharmacyName || '-' };
            if (q.status === 'error') { pushA(Object.assign(base, { val: T.clean(rawQty), act: `Formula error${colLabel ? ' · ' + colLabel : ''}`, sev: 'error' })); return; }
            if (q.status === 'unparseable') { pushA(Object.assign(base, { val: T.clean(rawQty), act: 'Unparseable quantity', sev: 'unparseable' })); return; }
            if (q.value === 0) { stats.zero++; return; }
            if (q.value < 0) { pushA(Object.assign(base, { val: T.clean(rawQty), act: 'Negative quantity — skipped', sev: 'unparseable' })); return; }
            if (q.status === 'corrected') { stats.corrected++; pushA(Object.assign(base, { val: T.clean(rawQty), act: `Auto-corrected → ${q.value} (${q.note})`, sev: 'corrected' })); }

            let price = 0;
            if (idx.price !== -1) {
                const pr = N.parseNumber(row._raw[idx.price]);
                if (pr.status === 'error') pushA(Object.assign({}, base, { val: T.clean(row._raw[idx.price]), act: 'Formula error (Price)', sev: 'error' }));
                else if ((pr.status === 'ok' || pr.status === 'corrected') && pr.value > 0) price = pr.value;
            }
            records.push({
                i: row.i, u: row.u || q.unitHint || '', p: pharmacyName, branch: row.branch, t: row.t || cls, reg: row.reg,
                q: q.value, price, srcId, sheet: sourceLabel, row: row._r
            });
        };

        rows.forEach(row => {
            if (row._section) return;
            stats.dataRows++;
            if (row.i && H.isTotalLabel(row.i)) { stats.totals++; return; }
            if (row.p && cfg.layout === 'long' && H.isTotalLabel(row.p)) { stats.totals++; return; }
            if (!row.i) {
                const hasQty = cfg.layout === 'wide' ? wideCols.some(j => !N.isIntentionalEmpty(row._raw[j])) : !N.isIntentionalEmpty(row._raw[idx.q]);
                if (hasQty) pushA({ row: row._r, i: '-', p: row.p || '-', val: '(blank)', act: 'Blank item — row skipped', sev: 'unparseable' });
                stats.blankItems++;
                return;
            }
            if (row._filled && row._filled.length) {
                pushA({ row: row._r, i: row.i, p: row.p || '-', val: '(blank)', act: `Filled ${row._filled.map(f => labelNames[f]).join(', ')}`, sev: 'filled' });
            }
            if (cfg.layout === 'wide') {
                wideCols.forEach(j => emit(row, labels[j], row._raw[j], labels[j]));
            } else {
                if (!row.p) { if (!N.isIntentionalEmpty(row._raw[idx.q])) pushA({ row: row._r, i: row.i, p: '-', val: '(blank)', act: 'Blank pharmacy — row skipped', sev: 'unparseable' }); return; }
                emit(row, row.p, row._raw[idx.q], '');
            }
        });
        stats.records = records.length;
        return { records, anomalies, stats, missing: [], truncated };
    }

    /**
     * Parse every included sheet of a workbook.
     * configs: { [sheetName]: cfg } — missing configs are auto-profiled.
     */
    function parseWorkbook(wb, configs, ctx) {
        configs = configs || {};
        const out = { records: [], anomalies: [], included: [], skipped: [], stats: {}, truncated: false, configs: {} };
        wb.sheets.forEach(sheet => {
            const cfg = configs[sheet.name] || profileSheet(sheet, { classLabel: ctx && ctx.classLabel });
            out.configs[sheet.name] = cfg;
            if (!cfg.included) { out.skipped.push(sheet.name); return; }
            const label = ctx && ctx.sourceLabel ? (wb.sheets.length > 1 ? `${ctx.sourceLabel} · ${sheet.name}` : ctx.sourceLabel) : sheet.name;
            const res = extractSheet(sheet, cfg, Object.assign({}, ctx, { sourceLabel: label }));
            if (res.missing.length) { out.skipped.push(sheet.name); return; }
            out.included.push(sheet.name);
            out.records.push(...res.records);
            out.anomalies.push(...res.anomalies);
            out.stats[sheet.name] = res.stats;
            if (res.truncated) out.truncated = true;
        });
        return out;
    }

    /** Summaries used by the import wizard's column cards. */
    function describeColumns(sheet, cfg) {
        const { labels, groups } = H.buildHeaderLabels(sheet.grid, cfg.headerRowIdx, cfg.headerDepth || 1);
        const stats = columnStats(sheet.grid, cfg.headerRowIdx + (cfg.headerDepth || 1), labels.length);
        return labels.map((label, j) => ({ j, label, group: groups[j], stats: stats[j] }));
    }

    LX.engine = { profileSheet, extractSheet, parseWorkbook, describeColumns, missingFields, LABEL_FIELDS };
})(window.LX = window.LX || {});
