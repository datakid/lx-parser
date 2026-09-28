/* ==========================================================================
   LX Parser — ui/views.js
   View definitions: data derivation (precalc) + row templates.
   All views share the filter context produced by ui/filters.js.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, D = LX.dom, S = LX.state, st = S.state, db = LX.db;
    const { byId, fmt, badgeClass } = D;
    const esc = T.escapeHTML, hl = T.highlight;

    const ar = (text, tokens) => `<span class="arabic-text">${hl(text, tokens)}</span>`;
    const CHEVRON = '<span class="drill-chevron" aria-hidden="true"></span>';

    const tables = {};
    const dirty = {};
    let current = 'view-overview';
    let anomalySubtab = 'issues';
    let breakdownSlice = 'r', breakdownMode = 'cards';
    let anomalySev = 'all';
    let variantKind = 'all';

    const markAll = () => Object.keys(dirty).forEach(k => { dirty[k] = true; });

    /* ---------------------------------------------------------------- */
    /*  Overview                                                          */
    /* ---------------------------------------------------------------- */
    let filtered = [];

    function firstVisibleGroup() {
        const gc = st.groupConfig;
        return ['t', 'reg', 'branch', 'p'].find(c => gc[c]) || 'i';
    }

    function syncOverviewHeaders() {
        const gc = st.groupConfig, cv = st.colVisible;
        ['t', 'reg', 'branch', 'p'].forEach(c => { const th = byId(`th-ov-${c}`); if (th) th.classList.toggle('hidden', !gc[c]); });
        ['u', 'q', 'price'].forEach(c => { const th = byId(`th-ov-${c}`); if (th) th.classList.toggle('hidden', !cv[c]); });
        const first = firstVisibleGroup();
        D.$$('#view-overview th').forEach(th => th.classList.remove('sticky-col'));
        const th = byId(`th-ov-${first}`) || D.$('#view-overview th[data-sort="i"]');
        if (th) th.classList.add('sticky-col');
    }

    function precalcOverview(f) {
        filtered = LX.db.DB.rows.filter(r => {
            if (f.cat !== 'ALL' && r.t !== f.cat) return false;
            if (f.reg !== 'ALL' && r.region !== f.reg) return false;
            if (f.branch !== 'ALL' && r.branch !== f.branch) return false;
            if (f.pharm !== 'ALL' && r.p !== f.pharm) return false;
            if (f.unit !== 'ALL' && r.u !== f.unit) return false;
            return T.isMatch(f.tokens, r._norm, f.exact, r._words);
        });
        const gc = st.groupConfig, map = new Map();
        filtered.forEach(r => {
            const parts = [r.ik, r.u];
            if (gc.t) parts.push(r.t);
            if (gc.reg) parts.push(r.region);
            if (gc.branch) parts.push(r.branch);
            if (gc.p) parts.push(r.p);
            const k = T.makeKey.apply(null, parts);
            let g = map.get(k);
            if (!g) { g = { t: gc.t ? r.t : '', reg: gc.reg ? r.region : '', branch: gc.branch ? r.branch : '', p: gc.p ? r.p : '', i: r.i, ik: r.ik, u: r.u, q: 0, price: r.price, n: 0 }; map.set(k, g); }
            g.q += r.q; g.n++;
        });
        return Array.from(map.values()).map(g => Object.assign(g, { tot: g.q * g.price }));
    }

    function overviewRow(d, idx, ctx) {
        const gc = st.groupConfig, cv = st.colVisible, first = ctx.first, tk = ctx.tokens;
        const cell = (col, inner) => `<td class="${first === col ? 'sticky-col' : ''}">${first === col ? CHEVRON : ''}${inner}</td>`;
        return `<tr data-idx="${idx}" tabindex="0">`
            + (gc.t ? cell('t', `<span class="badge ${badgeClass(d.t)}">${hl(d.t, tk)}</span>`) : '')
            + (gc.reg ? cell('reg', d.reg === 'Unmapped' ? `<span class="badge badge-muted">Unmapped</span>` : ar(d.reg, tk)) : '')
            + (gc.branch ? cell('branch', d.branch ? ar(d.branch, tk) : '<span class="muted">—</span>') : '')
            + (gc.p ? cell('p', ar(d.p, tk)) : '')
            + cell('i', ar(d.i, tk))
            + (cv.u ? `<td>${d.u ? ar(d.u, tk) : '<span class="muted">—</span>'}</td>` : '')
            + (cv.q ? `<td class="num">${fmt.num(d.q)}</td>` : '')
            + (cv.price ? `<td class="num">${d.price ? fmt.egp(d.price) : '<span class="price-missing" title="No price set — edit it in Pricing Config">—</span>'}</td>` : '')
            + `<td class="highlight">${fmt.egp(d.tot)}</td></tr>`;
    }

    function renderOverviewKpis(data) {
        let tvl = 0, qty = 0;
        data.forEach(d => { tvl += d.tot; qty += d.q; });
        const unique = new Set(filtered.map(r => T.makeKey(r.ik, r.u))).size;
        D.animateKpi(byId('kpi-tvl'), tvl, fmt.egp);
        D.animateKpi(byId('kpi-qty'), qty, v => fmt.num(Math.round(v)));
        D.animateKpi(byId('kpi-assets'), unique, v => fmt.num(Math.round(v)));
        const isFiltered = LX.filters.anyActive();
        ['delta-tvl', 'delta-assets', 'delta-qty', 'spark-tvl', 'spark-assets', 'spark-qty', 'kpi-trend-note'].forEach(id => byId(id).classList.toggle('hidden', isFiltered));
        byId('kpi-filter-note').classList.toggle('hidden', !isFiltered);
        byId('kpi-filter-note').textContent = isFiltered ? `Filtered · ${fmt.num(filtered.length)} of ${fmt.num(LX.db.DB.rows.length)} records` : '';
    }

    /* drill-down */
    function drillDown(tr) {
        const next = tr.nextElementSibling;
        const open = next && next.classList.contains('drill-down-row');
        D.$$('#tb-overview .drill-down-row').forEach(r => r.remove());
        D.$$('#tb-overview tr.drill-open').forEach(r => r.classList.remove('drill-open'));
        if (open) return;
        const d = tables['view-overview'].item(+tr.dataset.idx);
        if (!d) return;
        const gc = st.groupConfig;
        const matches = filtered.filter(r => r.ik === d.ik && r.u === d.u && (!gc.t || r.t === d.t) && (!gc.reg || r.region === d.reg) && (!gc.branch || r.branch === d.branch) && (!gc.p || r.p === d.p))
            .sort((a, b) => b.tot - a.tot || b.q - a.q);
        if (!matches.length) return;
        const shown = matches.slice(0, 8);
        const drill = document.createElement('tr');
        drill.className = 'drill-down-row';
        drill.innerHTML = `<td colspan="${tr.children.length}"><div class="drill-content">
            <div class="drill-head">${fmt.num(matches.length)} source record${matches.length === 1 ? '' : 's'}${matches.length > shown.length ? ` · top ${shown.length}` : ''}</div>
            ${shown.map(m => `<div class="drill-item">
                <span class="drill-name"><span class="arabic-text">${esc(m.p)}</span>
                <span class="drill-context">${esc(m.t)} · ${esc(m.region)}${m.branch ? ' · ' + esc(m.branch) : ''} · <span class="mono">${esc(m.sheet)} #${m.srcRow}</span></span></span>
                <span class="drill-stats"><span class="drill-qty">${fmt.num(m.q)} ${esc(m.u || 'units')}</span><span class="val">${fmt.egp(m.tot)}</span></span>
            </div>`).join('')}</div></td>`;
        tr.after(drill);
        tr.classList.add('drill-open');
    }

    /* ---------------------------------------------------------------- */
    /*  Breakdown                                                         */
    /* ---------------------------------------------------------------- */
    let breakdownData = [];
    const SLICE_LABEL = { r: 'Region', b: 'Branch', e: 'Pharmacy', c: 'Class' };

    function precalcBreakdown() {
        const map = new Map();
        LX.db.DB.rows.forEach(r => {
            const [k1, k2] = breakdownSlice === 'r' ? [r.region, ''] : breakdownSlice === 'b' ? [r.branch || '(No Branch)', ''] : breakdownSlice === 'e' ? [r.p, r.region] : [r.t, ''];
            const key = T.makeKey(k1, k2);
            let g = map.get(key);
            if (!g) { g = { key: k1, sub: k2, items: new Set(), q: 0, tot: 0, unpriced: 0 }; map.set(key, g); }
            g.items.add(T.makeKey(r.ik, r.u)); g.q += r.q; g.tot += r.tot; if (!r.price) g.unpriced++;
        });
        const grand = Array.from(map.values()).reduce((s, g) => s + g.tot, 0) || 1;
        breakdownData = Array.from(map.values()).map(g => ({ key: g.key, sub: g.sub, ui: g.items.size, q: g.q, tot: g.tot, share: g.tot / grand, unpriced: g.unpriced })).sort((a, b) => b.tot - a.tot);
        return breakdownData;
    }

    function renderBreakdown() {
        const cards = byId('bento-container'), card = byId('breakdown-table-card');
        const isTable = breakdownMode === 'table';
        cards.classList.toggle('hidden', isTable);
        card.classList.toggle('hidden', !isTable);
        byId('th-bd-key-label').textContent = SLICE_LABEL[breakdownSlice];
        byId('th-bd-sub').classList.toggle('hidden', breakdownSlice !== 'e');
        if (isTable) {
            tables['view-breakdown'].setData(breakdownData);
            tables['view-breakdown'].render();
            byId('bd-grand-items').textContent = fmt.num(breakdownData.reduce((s, g) => s + g.ui, 0));
            byId('bd-grand-qty').textContent = fmt.num(breakdownData.reduce((s, g) => s + g.q, 0));
            byId('bd-grand-tot').textContent = fmt.egp(breakdownData.reduce((s, g) => s + g.tot, 0));
            byId('bd-grand-colspan').colSpan = breakdownSlice === 'e' ? 2 : 1;
            return;
        }
        cards.innerHTML = breakdownData.length ? breakdownData.map((d, i) => `
            <article class="bento-card" style="--i:${Math.min(i, 12)}">
                <header class="bento-header">
                    <div class="bento-title">${esc(d.key || '(Empty)')}</div>
                    ${d.sub ? `<div class="bento-subtitle">${esc(d.sub)}</div>` : `<div class="bento-rank">#${i + 1}</div>`}
                </header>
                <div class="bento-metric">${fmt.egp(d.tot)}</div>
                <div class="bento-share" title="${(d.share * 100).toFixed(1)}% of total value"><span style="width:${Math.max(1.5, d.share * 100).toFixed(1)}%"></span></div>
                <footer class="bento-submetric">
                    <span>Items <b class="mono-strong">${fmt.num(d.ui)}</b></span>
                    <span>Qty <b class="mono-strong">${fmt.num(d.q)}</b></span>
                    <span>Share <b class="mono-strong">${(d.share * 100).toFixed(1)}%</b></span>
                </footer>
                ${d.unpriced ? `<div class="bento-flag">${fmt.num(d.unpriced)} unpriced record${d.unpriced === 1 ? '' : 's'}</div>` : ''}
            </article>`).join('') : `<div class="empty-state empty-state-full">${D.ICON.search(34)}<span>No data available for this grouping</span></div>`;
    }

    /* ---------------------------------------------------------------- */
    /*  Pricing                                                           */
    /* ---------------------------------------------------------------- */
    function precalcPricing(f) {
        const usage = new Map();
        LX.db.DB.rows.forEach(r => { const u = usage.get(r.pk) || { q: 0, n: 0 }; u.q += r.q; u.n++; usage.set(r.pk, u); });
        const out = [];
        Object.keys(st.prices).forEach(k => {
            const lab = st.priceLabels[k] || { i: k.split('\u0000')[0], u: k.split('\u0000')[1] || '' };
            if (!T.isMatch(f.tokens, T.fold(`${lab.i} ${lab.u}`), f.exact)) return;
            const use = usage.get(k);
            out.push({ id: k, i: lab.i, u: lab.u, p: st.prices[k], stat: st.prices[k] > 0 ? 1 : 0, uses: use ? use.q : 0, active: !!use });
        });
        return out;
    }

    function pricingRow(d, idx, ctx) {
        let anomaly = '';
        const m = ctx.median;
        if (d.p > 0 && m > 0 && (d.p > m * 3 || d.p < m * 0.3)) anomaly = `<span class="status-dot status-anomaly" title="Unusual price — more than 3× away from the median (${fmt.egp(m)})"></span>`;
        return `<tr class="${d.active ? '' : 'row-dim'}">
            <td><span class="status-dot ${d.stat ? 'status-ok' : 'status-missing'}" title="${d.stat ? 'Priced' : 'Missing price'}"></span></td>
            <td>${ar(d.i, ctx.tokens)}${d.active ? '' : ' <span class="badge badge-muted" title="Not present in any current source">orphan</span>'}</td>
            <td>${d.u ? ar(d.u, ctx.tokens) : '<span class="muted">—</span>'}</td>
            <td class="num">${d.uses ? fmt.num(d.uses) : '<span class="muted">0</span>'}</td>
            <td><div class="cell-flex">${anomaly}<input type="text" inputmode="decimal" class="editable ${anomaly ? 'anomaly-warn' : ''}" data-id="${esc(d.id)}" value="${d.p || ''}" placeholder="0.00" aria-label="Price for ${esc(d.i)}"></div></td>
        </tr>`;
    }

    /* ---------------------------------------------------------------- */
    /*  Region map                                                        */
    /* ---------------------------------------------------------------- */
    function precalcPharmacies(f) {
        const out = [];
        Object.keys(st.pharmacies).forEach(k => {
            const reg = st.pharmacies[k];
            if (!T.isMatch(f.tokens, T.fold(`${k} ${reg}`), f.exact)) return;
            const n = LX.db.DB.pharmCounts.get(k) || 0;
            out.push({ k, reg, n, stat: !reg ? 0 : !LX.db.DB.activePharms.has(k) ? 2 : 1 });
        });
        return out;
    }

    function pharmacyRow(d, idx, ctx) {
        const dot = d.stat === 0 ? 'status-missing' : d.stat === 2 ? 'status-inactive' : 'status-ok';
        const lab = d.stat === 0 ? 'Unrouted — no region assigned' : d.stat === 2 ? 'Inactive — no records this period' : 'Active';
        return `<tr>
            <td><span class="status-dot ${dot}" title="${lab}"></span></td>
            <td>${ar(d.k, ctx.tokens)}</td>
            <td class="num">${d.n ? fmt.num(d.n) : '<span class="muted">0</span>'}</td>
            <td><input type="text" class="editable" list="region-suggestions" data-id="${esc(d.k)}" value="${esc(d.reg)}" placeholder="Assign region…" aria-label="Region for ${esc(d.k)}"></td>
        </tr>`;
    }

    /* ---------------------------------------------------------------- */
    /*  Missing                                                           */
    /* ---------------------------------------------------------------- */
    function precalcMissing(f) {
        const out = [];
        Object.keys(st.pharmacies).forEach(k => {
            if (LX.db.DB.activePharms.has(k)) return;
            const reg = LX.db.regionFor(k);
            if (f.reg !== 'ALL' && reg !== f.reg) return;
            if (T.isMatch(f.tokens, T.fold(`${k} ${reg}`), f.exact)) out.push({ k, reg });
        });
        return out;
    }

    /* ---------------------------------------------------------------- */
    /*  Anomalies / duplicates / variants                                 */
    /* ---------------------------------------------------------------- */
    const SEV = {
        error: { label: 'Formula errors', cls: 'sev-error', color: 'var(--danger)' },
        unparseable: { label: 'Unparseable', cls: 'sev-warn', color: 'var(--warning)' },
        corrected: { label: 'Auto-corrected', cls: 'sev-info', color: 'var(--accent-blue)' },
        filled: { label: 'Filled down/up', cls: 'sev-teal', color: 'var(--badge-teal)' }
    };

    function precalcAnomalies(f) {
        return LX.db.DB.anomalies.filter(a => (anomalySev === 'all' || a.sev === anomalySev) && T.isMatch(f.tokens, T.fold(`${a.sheet} ${a.i} ${a.p} ${a.val} ${a.act}`), f.exact));
    }

    function renderSeveritySummary() {
        const counts = { error: 0, unparseable: 0, corrected: 0, filled: 0 };
        LX.db.DB.anomalies.forEach(a => { if (counts[a.sev] != null) counts[a.sev]++; });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        byId('severity-summary').innerHTML =
            `<button type="button" class="severity-chip ${anomalySev === 'all' ? 'active' : ''}" data-sev="all">All <b>${fmt.num(total)}</b></button>` +
            Object.keys(SEV).map(k => `<button type="button" class="severity-chip ${anomalySev === k ? 'active' : ''}" data-sev="${k}"><span class="dot" style="background:${SEV[k].color}"></span>${SEV[k].label} <b>${fmt.num(counts[k])}</b></button>`).join('') +
            (LX.db.DB.anomaliesTruncated ? `<span class="severity-chip static" title="At least one source hit the ${fmt.num(LX.config.ANOMALY_CAP)}-entry anomaly cap. Data rows were still imported in full."><span class="dot" style="background:var(--warning)"></span>List capped at ${fmt.num(LX.config.ANOMALY_CAP)}/source</span>` : '');
    }

    function anomalyRow(d, idx, ctx) {
        const s = SEV[d.sev] || SEV.unparseable;
        return `<tr>
            <td><span class="badge ${badgeClass(d.sheet)}">${esc(d.sheet)}</span></td>
            <td><span class="mono-bold">${esc(d.row)}</span></td>
            <td>${ar(d.i, ctx.tokens)}</td>
            <td>${ar(d.p, ctx.tokens)}</td>
            <td class="highlight value-danger"><span class="cell-raw" dir="auto">${esc(d.val)}</span></td>
            <td><span class="badge ${s.cls}">${esc(d.act)}</span></td>
        </tr>`;
    }

    function precalcDuplicates(f) {
        return LX.db.DB.duplicateGroups.filter(g => T.isMatch(f.tokens, T.fold(`${g.t} ${g.branch} ${g.p} ${g.i} ${g.u}`), f.exact));
    }

    function duplicateRow(d, idx, ctx) {
        return `<tr>
            <td><span class="badge ${badgeClass(d.t)}">${hl(d.t, ctx.tokens)}</span></td>
            <td>${d.branch ? ar(d.branch, ctx.tokens) : '<span class="muted">—</span>'}</td>
            <td>${ar(d.p, ctx.tokens)}</td>
            <td>${ar(d.i, ctx.tokens)}</td>
            <td>${d.u ? ar(d.u, ctx.tokens) : '<span class="muted">—</span>'}</td>
            <td><span class="badge sev-warn" title="${esc(d.rows)}">&times;${fmt.num(d.n)}</span></td>
            <td class="num">${fmt.num(d.q)}</td>
        </tr>`;
    }

    let variantsCache = null;
    const KIND_LABEL = { p: 'Pharmacy', i: 'Item', u: 'Unit' };
    function precalcVariants(f) {
        if (!variantsCache) variantsCache = LX.db.variants();
        return variantsCache
            .filter(v => variantKind === 'all' || v.kind === variantKind)
            .filter(v => T.isMatch(f.tokens, T.fold(`${v.raw} ${v.canon}`), f.exact))
            .map(v => Object.assign({ statusRank: v.status === 'suggested' ? 1 : 0 }, v));
    }

    function variantRow(d, idx, ctx) {
        const method = d.status === 'suggested' ? '<span class="badge sev-warn">Suggested</span>'
            : d.method === 'alias' ? '<span class="badge sev-info">Your rule</span>'
            : d.method === 'fuzzy' ? '<span class="badge badge-p1">Auto · fuzzy</span>'
            : '<span class="badge sev-teal">Auto · spelling</span>';
        const pct = `<span class="mono">${Math.round(d.score * 100)}%</span>`;
        const actions = d.status === 'suggested'
            ? `<button type="button" class="btn btn-sm btn-primary" data-variant-act="accept" data-idx="${idx}">Merge</button><button type="button" class="btn btn-sm" data-variant-act="dismiss" data-idx="${idx}">Different</button>`
            : (d.kind !== 'u' && (d.method === 'alias' || d.method === 'fuzzy'))
                ? `<button type="button" class="btn btn-sm" data-variant-act="split" data-idx="${idx}">${D.ICON.undo(13)} Split</button>` : '<span class="muted small">normalised</span>';
        return `<tr>
            <td><span class="badge badge-muted">${KIND_LABEL[d.kind]}</span></td>
            <td>${ar(d.raw, ctx.tokens)}</td>
            <td class="variant-arrow">${D.ICON.merge(14)}</td>
            <td>${ar(d.canon, ctx.tokens)}</td>
            <td class="num">${fmt.num(d.count)}</td>
            <td>${method} ${pct}</td>
            <td><div class="cell-actions">${actions}</div></td>
        </tr>`;
    }

    /* ---------------------------------------------------------------- */
    /*  Registry + render                                                 */
    /* ---------------------------------------------------------------- */
    function init() {
        const mk = (key, tableSel, tbodyId, capId, defaultSort, row, empty, extra) => {
            tables[key] = LX.table.create(Object.assign({
                key, table: D.$(tableSel), tbody: byId(tbodyId), cap: byId(capId), defaultSort, row, empty,
                ctx: () => ({ tokens: LX.filters.get().tokens, first: firstVisibleGroup(), median: db.getPriceMedian() })
            }, extra || {}));
            dirty[key] = true;
        };
        mk('view-overview', 'table[data-view="view-overview"]', 'tb-overview', 'cap-overview', [{ k: 'tot', d: -1 }], overviewRow,
            () => LX.db.DB.rows.length ? 'No records match your filters' : 'No data loaded yet — sync a remote source or add a local file from the Data panel');
        mk('view-breakdown', 'table[data-view="view-breakdown"]', 'tb-breakdown', 'cap-breakdown', [{ k: 'tot', d: -1 }],
            d => `<tr><td>${ar(d.key || '(Empty)')}</td><td class="${breakdownSlice !== 'e' ? 'hidden' : ''}">${ar(d.sub)}</td><td class="num">${fmt.num(d.ui)}</td><td class="num">${fmt.num(d.q)}</td><td class="num">${(d.share * 100).toFixed(1)}%</td><td class="highlight">${fmt.egp(d.tot)}</td></tr>`,
            () => 'No data available for this grouping');
        mk('view-pricing', 'table[data-view="view-pricing"]', 'tb-pricing', 'cap-pricing', [{ k: 'stat', d: 1 }, { k: 'uses', d: -1 }], pricingRow, () => 'No items match your filters');
        mk('view-pharmacies', 'table[data-view="view-pharmacies"]', 'tb-pharmacies', 'cap-pharmacies', [{ k: 'stat', d: 1 }, { k: 'n', d: -1 }], pharmacyRow, () => 'No pharmacies match your filters');
        mk('view-missing', 'table[data-view="view-missing"]', 'tb-missing', 'cap-missing', [{ k: 'reg', d: 1 }, { k: 'k', d: 1 }],
            (d, i, c) => `<tr><td>${ar(d.k, c.tokens)}</td><td>${d.reg === 'Unmapped' ? '<span class="badge badge-muted">Unmapped</span>' : ar(d.reg, c.tokens)}</td></tr>`,
            () => 'No missing pharmacies — every mapped pharmacy is reporting');
        mk('view-anomalies', 'table[data-view="view-anomalies"]', 'tb-anomalies', 'cap-anomalies', [{ k: 'sheet', d: 1 }, { k: 'row', d: 1 }], anomalyRow, () => 'No anomalies — every cell was read cleanly');
        mk('view-duplicates', 'table[data-view="view-duplicates"]', 'tb-duplicates', 'cap-duplicates', [{ k: 'n', d: -1 }], duplicateRow, () => 'No duplicate rows detected');
        mk('view-variants', 'table[data-view="view-variants"]', 'tb-variants', 'cap-variants', [{ k: 'statusRank', d: -1 }, { k: 'count', d: -1 }], variantRow, () => 'No spelling variants found');

        LX.bus.on('db:built', () => { variantsCache = null; markAll(); updateBadges(); });
        wire();
    }

    function updateBadges() {
        const dup = LX.db.DB.duplicateGroups.length;
        const setBadge = (id, n) => { const b = byId(id); if (!b) return; b.textContent = n > 99 ? '99+' : String(n); b.classList.toggle('hidden', !n); };
        setBadge('nav-badge-dup', dup);
        const sugg = (variantsCache || (variantsCache = LX.db.variants())).filter(v => v.status === 'suggested').length;
        setBadge('nav-badge-var', sugg);
        const issues = LX.db.DB.anomalies.filter(a => a.sev === 'error' || a.sev === 'unparseable').length;
        setBadge('nav-badge-anom', issues + sugg);
    }

    function render(force) {
        const f = LX.filters.get();
        const view = current === 'view-anomalies' ? (anomalySubtab === 'issues' ? 'view-anomalies' : anomalySubtab === 'duplicates' ? 'view-duplicates' : 'view-variants') : current;
        const t = tables[view];
        if (dirty[view] || force) {
            switch (view) {
                case 'view-overview': syncOverviewHeaders(); t.setData(precalcOverview(f)); break;
                case 'view-breakdown': precalcBreakdown(); break;
                case 'view-pricing': t.setData(precalcPricing(f)); break;
                case 'view-pharmacies': t.setData(precalcPharmacies(f)); break;
                case 'view-missing': t.setData(precalcMissing(f)); break;
                case 'view-anomalies': t.setData(precalcAnomalies(f)); break;
                case 'view-duplicates': t.setData(precalcDuplicates(f)); break;
                case 'view-variants': t.setData(precalcVariants(f)); break;
            }
            dirty[view] = false;
        }
        if (view === 'view-breakdown') { renderBreakdown(); return; }
        t.render();
        if (view === 'view-overview') renderOverviewKpis(t.sorted);
        if (view === 'view-pricing') {
            D.animateKpi(byId('kpi-unpriced'), t.sorted.filter(d => d.stat === 0 && d.active).length, v => fmt.num(Math.round(v)));
            D.animateKpi(byId('kpi-priced'), t.sorted.filter(d => d.stat === 1 && d.active).length, v => fmt.num(Math.round(v)));
        }
        if (view === 'view-pharmacies') {
            D.animateKpi(byId('kpi-unmapped'), t.sorted.filter(d => d.stat === 0).length, v => fmt.num(Math.round(v)));
            D.animateKpi(byId('kpi-inactive'), t.sorted.filter(d => d.stat === 2).length, v => fmt.num(Math.round(v)));
        }
        if (view === 'view-anomalies') renderSeveritySummary();
        if (view === 'view-duplicates') {
            D.animateKpi(byId('kpi-dup-groups'), LX.db.DB.duplicateGroups.length, v => fmt.num(Math.round(v)));
            D.animateKpi(byId('kpi-dup-rows'), LX.db.DB.duplicateGroups.reduce((s, g) => s + g.n, 0), v => fmt.num(Math.round(v)));
        }
        if (view === 'view-variants') {
            const all = variantsCache || [];
            byId('kpi-var-merged').textContent = fmt.num(all.filter(v => v.status === 'merged').length);
            byId('kpi-var-suggested').textContent = fmt.num(all.filter(v => v.status === 'suggested').length);
        }
    }

    /* ---------------------------------------------------------------- */
    /*  Wiring                                                            */
    /* ---------------------------------------------------------------- */
    function wire() {
        byId('tb-overview').addEventListener('click', e => {
            const tr = e.target.closest('tr[data-idx]');
            if (tr) drillDown(tr);
        });
        byId('tb-overview').addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tr = e.target.closest('tr[data-idx]');
            if (tr) { e.preventDefault(); drillDown(tr); }
        });

        D.$$('[data-slice]').forEach(btn => btn.addEventListener('click', () => {
            D.$$('[data-slice]').forEach(b => b.classList.toggle('active', b === btn));
            breakdownSlice = btn.dataset.slice; dirty['view-breakdown'] = true; render();
        }));
        D.$$('[data-viewmode]').forEach(btn => btn.addEventListener('click', () => {
            D.$$('[data-viewmode]').forEach(b => b.classList.toggle('active', b === btn));
            breakdownMode = btn.dataset.viewmode; render();
        }));
        D.$$('[data-subtab]').forEach(btn => btn.addEventListener('click', () => setSubtab(btn.dataset.subtab)));

        byId('severity-summary').addEventListener('click', e => {
            const chip = e.target.closest('[data-sev]');
            if (!chip) return;
            anomalySev = chip.dataset.sev; dirty['view-anomalies'] = true; render();
        });

        D.$$('[data-varkind]').forEach(btn => btn.addEventListener('click', () => {
            D.$$('[data-varkind]').forEach(b => b.classList.toggle('active', b === btn));
            variantKind = btn.dataset.varkind; dirty['view-variants'] = true; render();
        }));

        D.$$('[data-dupmode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.dupmode === st.dupMode);
            btn.addEventListener('click', () => {
                D.$$('[data-dupmode]').forEach(b => b.classList.toggle('active', b === btn));
                st.dupMode = btn.dataset.dupmode; S.persist.dupMode();
                LX.app.rebuild();
                D.toast(`Duplicate resolution set to ${btn.textContent.trim()}`);
            });
        });

        D.$$('.toggle-group').forEach(btn => {
            btn.classList.toggle('active', !!st.groupConfig[btn.dataset.col]);
            btn.addEventListener('click', () => {
                const c = btn.dataset.col;
                st.groupConfig[c] = !st.groupConfig[c];
                btn.classList.toggle('active', st.groupConfig[c]);
                btn.setAttribute('aria-pressed', String(st.groupConfig[c]));
                S.persist.groupConfig();
                dirty['view-overview'] = true; render();
            });
        });
        D.$$('.toggle-col').forEach(btn => {
            btn.classList.toggle('active', !!st.colVisible[btn.dataset.col]);
            btn.addEventListener('click', () => {
                const c = btn.dataset.col;
                st.colVisible[c] = !st.colVisible[c];
                btn.classList.toggle('active', st.colVisible[c]);
                btn.setAttribute('aria-pressed', String(st.colVisible[c]));
                S.persist.colVisible();
                dirty['view-overview'] = true; render();
            });
        });

        // editable price / region cells
        const commitEditable = (tbodyId, fn) => {
            const tb = byId(tbodyId);
            tb.addEventListener('change', e => { if (e.target.classList.contains('editable')) fn(e.target); });
            tb.addEventListener('keydown', e => {
                if (!e.target.classList.contains('editable')) return;
                if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
                if (e.key === 'Escape') { e.target.value = e.target.defaultValue; e.target.blur(); }
            });
        };
        commitEditable('tb-pricing', el => LX.actions.updatePrice(el.dataset.id, el.value, el));
        commitEditable('tb-pharmacies', el => LX.actions.updateRegion(el.dataset.id, el.value, el));

        byId('tb-variants').addEventListener('click', e => {
            const b = e.target.closest('[data-variant-act]');
            if (!b) return;
            const v = tables['view-variants'].item(+b.dataset.idx);
            if (v) LX.actions.variantAction(b.dataset.variantAct, v);
        });
    }

    function setSubtab(name) {
        anomalySubtab = name;
        D.$$('[data-subtab]').forEach(b => { b.classList.toggle('active', b.dataset.subtab === name); b.setAttribute('aria-selected', String(b.dataset.subtab === name)); });
        ['issues', 'duplicates', 'variants'].forEach(s => byId(`anomalies-subtab-${s}`).classList.toggle('hidden', s !== name));
        render();
    }

    function setView(id) { current = id; }
    function activeTable() {
        const view = current === 'view-anomalies' ? (anomalySubtab === 'issues' ? 'view-anomalies' : anomalySubtab === 'duplicates' ? 'view-duplicates' : 'view-variants') : current;
        return { key: view, table: tables[view], breakdown: { slice: breakdownSlice, label: SLICE_LABEL[breakdownSlice], data: breakdownData } };
    }

    LX.views = {
        init, render, markAll, setView, setSubtab, activeTable, updateBadges,
        markDirty: k => { if (k) dirty[k] = true; else markAll(); },
        markSearchDirty: () => Object.keys(dirty).forEach(k => { if (k !== 'view-breakdown') dirty[k] = true; }),
        get current() { return current; },
        get subtab() { return anomalySubtab; },
        invalidateVariants: () => { variantsCache = null; dirty['view-variants'] = true; },
        tables
    };
})(window.LX = window.LX || {});
