/* ==========================================================================
   LX Parser — ui/actions.js
   User actions that mutate state: price / region edits (with undo),
   pricing & routing template import (header-matched, typo-tolerant),
   variant merge / split, export.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, D = LX.dom, S = LX.state, st = S.state, N = LX.numbers, H = LX.headers;
    const { byId, fmt } = D;

    let lastEdit = null;

    function flashSaved(id) {
        const el = D.$(`.editable[data-id="${CSS.escape(id)}"]`);
        if (el) { el.classList.add('input-saved'); setTimeout(() => el.classList.remove('input-saved'), 700); }
    }

    function refresh() {
        LX.views.markAll();
        LX.app.render();
    }

    /* ---------- price & region edits ---------- */
    function updatePrice(pk, raw) {
        const parsed = N.parseNumber(raw);
        if (parsed.status === 'error' || parsed.status === 'unparseable') { D.toast(`"${raw}" isn't a valid price`, 'error'); refresh(); return; }
        const value = parsed.status === 'empty' ? 0 : Math.max(0, parsed.value);
        const prev = LX.db.setPrice(pk, value);
        if (prev === value) return;
        lastEdit = { type: 'price', key: pk, prev };
        refresh();
        flashSaved(pk);
        D.toast(`Price set to ${fmt.egp(value)}`, 'success', { label: 'Undo', fn: undo });
    }

    function updateRegion(pharm, raw) {
        const canon = LX.resolver.canonicalRegion(raw);
        const prev = LX.db.setRegion(pharm, canon);
        if (prev === canon) { refresh(); return; }
        lastEdit = { type: 'region', key: pharm, prev };
        LX.filters.populate();
        refresh();
        flashSaved(pharm);
        refreshRegionSuggestions();
        D.toast(canon && canon !== T.clean(raw) ? `Region set to ${canon} (from "${T.clean(raw)}")` : 'Region updated', 'success', { label: 'Undo', fn: undo });
    }

    function undo() {
        if (!lastEdit) return;
        if (lastEdit.type === 'price') LX.db.setPrice(lastEdit.key, lastEdit.prev || 0);
        else if (lastEdit.type === 'region') { LX.db.setRegion(lastEdit.key, lastEdit.prev || ''); LX.filters.populate(); }
        else if (lastEdit.type === 'alias') { lastEdit.revert(); LX.app.rebuild(); lastEdit = null; return; }
        lastEdit = null;
        refresh();
        D.toast('Change undone');
    }

    function refreshRegionSuggestions() {
        const dl = byId('region-suggestions');
        const regions = new Set(LX.config.REGIONS.map(r => r.name).concat(Object.values(st.pharmacies).filter(Boolean)));
        dl.innerHTML = Array.from(regions).sort(T.compare).map(r => `<option value="${T.escapeHTML(r)}"></option>`).join('');
    }

    /* ---------- variant merge / split ---------- */
    function variantAction(act, v) {
        if (act === 'accept') {
            const prevAlias = st.aliases[v.kind][T.matchKey(v.raw)];
            S.setAlias(v.kind, v.raw, v.canon);
            // a merged pharmacy inherits the region of its target
            if (v.kind === 'p' && !st.pharmacies[v.canon] && st.pharmacies[v.raw]) st.pharmacies[v.canon] = st.pharmacies[v.raw];
            lastEdit = { type: 'alias', revert: () => { if (prevAlias) S.setAlias(v.kind, v.raw, prevAlias); else S.clearAlias(v.kind, v.raw); } };
            LX.app.rebuild();
            D.toast(`Merged "${v.raw}" into "${v.canon}"`, 'success', { label: 'Undo', fn: undo });
        } else if (act === 'dismiss') {
            LX.db.dismissSuggestion(v.kind, v.raw, v.canon);
            LX.views.invalidateVariants();
            LX.views.updateBadges();
            LX.app.render();
            D.toast('Marked as different — won\'t be suggested again');
        } else if (act === 'split') {
            if (v.method === 'fuzzy') S.rejectMatch(v.kind, v.raw);
            else S.clearAlias(v.kind, v.raw);
            lastEdit = { type: 'alias', revert: () => S.setAlias(v.kind, v.raw, v.canon) };
            LX.app.rebuild();
            D.toast(`"${v.raw}" is now kept separate`, 'success', { label: 'Undo', fn: undo });
        }
    }

    /* ---------- template import (prices / routing) ---------- */

    /** Find header row + field columns in any tabular sheet via the header vocabulary. */
    function locateColumns(grid, wanted) {
        const hdr = H.detectHeaderRow(grid, 20);
        const row = grid[hdr] || [];
        const found = {};
        wanted.forEach(f => {
            let best = -1, bestScore = 0;
            row.forEach((cell, j) => {
                if (Object.values(found).includes(j)) return;
                const c = H.classifyHeader(cell).find(x => x.field === f);
                if (c && c.score > bestScore) { bestScore = c.score; best = j; }
            });
            if (best >= 0 && bestScore >= 0.72) found[f] = best;
        });
        return { headerIdx: hdr, cols: found };
    }

    async function importTemplate(file, kind) {
        if (!file) return;
        let wb;
        try { wb = await LX.reader.readFile(file); }
        catch (err) { D.toast(err.message, 'error'); return; }
        const grid = (wb.sheets.find(s => s.grid.length) || { grid: [] }).grid;
        if (!grid.length) { D.toast(`${file.name} has no rows`, 'error'); return; }

        let applied = 0, skipped = 0;
        const wanted = kind === 'prices' ? ['i', 'u', 'price'] : ['p', 'reg'];
        const { headerIdx, cols } = locateColumns(grid, wanted);
        // positional fallback (template order) when headers aren't recognisable
        if (kind === 'prices') { if (cols.i == null) cols.i = 0; if (cols.price == null) cols.price = cols.u == null ? 1 : 2; if (cols.u == null && cols.price !== 1) cols.u = 1; }
        else { if (cols.p == null) cols.p = 0; if (cols.reg == null) cols.reg = 1; }

        const knownPharms = LX.resolver.createResolver({ knownPharmacies: Object.keys(st.pharmacies), aliases: st.aliases, rejected: st.aliases.rejected });
        for (let r = headerIdx + 1; r < grid.length; r++) {
            const row = grid[r] || [];
            if (kind === 'prices') {
                const i = T.clean(row[cols.i]);
                if (!i || H.isTotalLabel(i)) continue;
                const u = cols.u != null ? T.clean(row[cols.u]) : '';
                const pr = N.parseNumber(row[cols.price]);
                if (pr.status !== 'ok' && pr.status !== 'corrected') { if (pr.status !== 'empty') skipped++; continue; }
                const pk = S.priceKey(i, u);
                st.prices[pk] = Math.max(0, pr.value);
                if (!st.priceLabels[pk]) st.priceLabels[pk] = { i, u: LX.resolver.canonicalUnit(u) };
                applied++;
            } else {
                const raw = T.clean(row[cols.p]);
                if (!raw || H.isTotalLabel(raw)) continue;
                const p = knownPharms.pharmacy(raw);
                st.pharmacies[p] = LX.resolver.canonicalRegion(row[cols.reg]);
                applied++;
            }
        }
        if (kind === 'prices') S.persist.prices(); else { S.persist.pharmacies(); refreshRegionSuggestions(); }
        LX.db.reapplyAll();
        LX.filters.populate();
        refresh();
        D.toast(applied ? `${kind === 'prices' ? 'Prices' : 'Routing map'} updated — ${fmt.num(applied)} rows applied${skipped ? `, ${fmt.num(skipped)} unreadable` : ''}` : 'No usable rows found in that file', applied ? 'success' : 'error');
    }

    /* ---------- export ---------- */
    function writeSheet(rows, name, sheetName) {
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(48, Math.max(k.length + 4, ...rows.slice(0, 200).map(r => T.toStr(r[k]).length + 2))) }));
        ws['!views'] = [{ RTL: true }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Export');
        XLSX.writeFile(wb, name);
    }

    function stamp() {
        const d = new Date(), p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    }

    function exportView() {
        const { key, table, breakdown } = LX.views.activeTable();
        const gc = st.groupConfig;
        const map = {
            'view-overview': () => table.sorted.map(g => {
                const r = {};
                if (gc.t) r.Class = g.t; if (gc.reg) r.Region = g.reg; if (gc.branch) r.Branch = g.branch; if (gc.p) r.Pharmacy = g.p;
                return Object.assign(r, { Item: g.i, Unit: g.u, Qty: g.q, Price: g.price, Value: g.tot });
            }),
            'view-breakdown': () => breakdown.data.map(g => ({ [breakdown.label]: g.key, Context: g.sub, 'Unique Items': g.ui, Qty: g.q, 'Share %': +(g.share * 100).toFixed(2), Value: g.tot })),
            'view-pricing': () => table.sorted.map(d => ({ Item: d.i, Unit: d.u, 'Qty in data': d.uses, Price: d.p })),
            'view-pharmacies': () => table.sorted.map(d => ({ Pharmacy: d.k, Region: d.reg, Records: d.n, Status: d.stat === 0 ? 'Unmapped' : d.stat === 2 ? 'Inactive' : 'Active' })),
            'view-missing': () => table.sorted.map(d => ({ Pharmacy: d.k, 'Expected Region': d.reg })),
            'view-anomalies': () => table.sorted.map(d => ({ Source: d.sheet, Row: d.row, Item: d.i, Pharmacy: d.p, 'Raw Value': d.val, Action: d.act, Severity: d.sev })),
            'view-duplicates': () => table.sorted.map(d => ({ Class: d.t, Branch: d.branch, Pharmacy: d.p, Item: d.i, Unit: d.u, Occurrences: d.n, 'Combined Qty': d.q, Rows: d.rows })),
            'view-variants': () => table.sorted.map(d => ({ Type: d.kind, 'As typed': d.raw, 'Resolved to': d.canon, Records: d.count, Status: d.status, Method: d.method || '', Similarity: Math.round(d.score * 100) + '%' }))
        };
        const label = { 'view-overview': 'Overview', 'view-breakdown': 'Breakdown', 'view-pricing': 'Pricing_Config', 'view-pharmacies': 'Region_Map', 'view-missing': 'Missing_Pharms', 'view-anomalies': 'Anomalies', 'view-duplicates': 'Duplicates', 'view-variants': 'Name_Variants' };
        const rows = map[key] ? map[key]() : [];
        if (!rows.length) { D.toast('Nothing to export in this view', 'error'); return; }
        writeSheet(rows, `${label[key]}_${stamp()}.xlsx`);
        D.toast(`Exported ${fmt.num(rows.length)} rows`);
    }

    function downloadPriceTemplate() {
        const rows = Object.keys(st.prices).map(k => ({ Item: (st.priceLabels[k] || {}).i || k.split('\u0000')[0], Unit: (st.priceLabels[k] || {}).u || '', Price: st.prices[k] }));
        if (!rows.length) { D.toast('No items yet — load data first', 'error'); return; }
        writeSheet(rows, 'Pricing_Template.xlsx', 'Pricing_Template');
        D.toast('Pricing template downloaded');
    }
    function downloadRegionTemplate() {
        const rows = Object.keys(st.pharmacies).sort(T.compare).map(p => ({ Pharmacy: p, Region: st.pharmacies[p] }));
        writeSheet(rows, 'Routing_Template.xlsx', 'Routing_Template');
        D.toast('Routing template downloaded');
    }

    function wireDrop(zone, onFile) {
        if (!zone) return;
        let depth = 0;
        zone.addEventListener('dragenter', e => { e.preventDefault(); depth++; zone.classList.add('drag-active'); });
        zone.addEventListener('dragover', e => e.preventDefault());
        zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('drag-active'); } });
        zone.addEventListener('drop', e => { e.preventDefault(); depth = 0; zone.classList.remove('drag-active'); const f = e.dataTransfer.files[0]; if (f) onFile(f); });
    }

    function init() {
        byId('btn-export').addEventListener('click', exportView);
        byId('btn-template-prices').addEventListener('click', downloadPriceTemplate);
        byId('btn-template-regions').addEventListener('click', downloadRegionTemplate);
        byId('file-prices').addEventListener('change', e => { importTemplate(e.target.files[0], 'prices'); e.target.value = ''; });
        byId('file-regions').addEventListener('change', e => { importTemplate(e.target.files[0], 'regions'); e.target.value = ''; });
        wireDrop(D.$('#view-pricing .action-row'), f => importTemplate(f, 'prices'));
        wireDrop(D.$('#view-pharmacies .action-row'), f => importTemplate(f, 'regions'));
        refreshRegionSuggestions();
    }

    LX.actions = { init, updatePrice, updateRegion, undo, variantAction, importTemplate, exportView, wireDrop, refreshRegionSuggestions };
})(window.LX = window.LX || {});
