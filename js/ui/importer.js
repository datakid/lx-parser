/* ==========================================================================
   LX Parser — ui/importer.js
   Import wizard. Auto-profiles every sheet (header row, 2-row headers,
   layout, column roles, fill-down) and lets the user correct anything,
   with a live preview + row accounting before committing.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, D = LX.dom, E = LX.engine, H = LX.headers;
    const { byId, fmt } = D;
    const esc = T.escapeHTML;

    let state = null;   // { file, buffer, wb, sheetName, configs, srcId }
    let prevFocus = null;
    const modal = () => byId('import-modal');

    const FIELD_OPTIONS = {
        long: [['ignore', 'Ignore'], ['i', 'Item'], ['p', 'Pharmacy'], ['branch', 'Branch'], ['u', 'Unit'], ['q', 'Quantity'], ['price', 'Price'], ['t', 'Class'], ['reg', 'Region']],
        wide: [['ignore', 'Ignore'], ['i', 'Item'], ['wq', 'Pharmacy qty'], ['branch', 'Branch'], ['u', 'Unit'], ['price', 'Price'], ['t', 'Class'], ['reg', 'Region']]
    };
    const FILLABLE = new Set(['i', 'p', 'branch', 'u', 't', 'reg']);

    const sheet = name => state.wb.sheets.find(s => s.name === (name || state.sheetName));
    const cfgOf = name => {
        const n = name || state.sheetName;
        if (!state.configs[n]) state.configs[n] = E.profileSheet(sheet(n));
        return state.configs[n];
    };

    /* ---------- open / close ---------- */
    async function openFromFile(file, srcId, savedConfig) {
        let wb, buffer;
        try {
            buffer = await file.arrayBuffer();
            wb = LX.reader.readBuffer(buffer, file.name);
        } catch (err) {
            D.toast(`Could not read ${file.name}: ${err.message}`, 'error');
            return;
        }
        const nonEmpty = wb.sheets.filter(s => s.grid.length);
        if (!nonEmpty.length) { D.toast(`${file.name} has no data in any sheet`, 'error'); return; }
        const configs = {};
        if (savedConfig && savedConfig.sheetConfigs) {
            wb.sheets.forEach(s => {
                const old = savedConfig.sheetConfigs[s.name];
                if (old && old.columnMap) configs[s.name] = Object.assign({ headerDepth: 1, layout: 'long', issues: [], confidence: 0.8 }, JSON.parse(JSON.stringify(old)));
            });
        }
        wb.sheets.forEach(s => {
            if (!configs[s.name]) configs[s.name] = E.profileSheet(s);
            if (!s.grid.length || s.hidden) configs[s.name].included = configs[s.name].included && !s.hidden && s.grid.length > 0;
        });
        const first = (savedConfig && wb.sheets.some(s => s.name === savedConfig.lastSheet)) ? savedConfig.lastSheet
            : (wb.sheets.find(s => configs[s.name].included) || nonEmpty[0]).name;
        state = { file, buffer, wb, sheetName: first, configs, srcId: srcId || null };
        prevFocus = document.activeElement;
        render();
        modal().classList.add('open');
        document.body.classList.add('modal-open');
        setTimeout(() => byId('btn-import-confirm').focus(), 60);
    }

    function close() {
        modal().classList.remove('open');
        document.body.classList.remove('modal-open');
        state = null;
        if (prevFocus && prevFocus.focus) prevFocus.focus();
    }

    /* ---------- render ---------- */
    function render() {
        byId('import-filename').textContent = state.file.name;
        renderTabs();
        const s = sheet(), cfg = cfgOf();
        const label = byId('import-class-label');
        label.value = cfg.classLabel || '';
        label.placeholder = s.name;
        renderDetection(s, cfg);
        renderHeaderPicker(s, cfg);
        renderColumns(s, cfg);
        renderPreview();
    }

    function renderTabs() {
        const tabs = byId('import-sheet-tabs');
        tabs.innerHTML = state.wb.sheets.map(s => {
            const cfg = cfgOf(s.name);
            const ready = E.missingFields(cfg).length === 0;
            return `<div class="import-tab ${s.name === state.sheetName ? 'active' : ''} ${ready ? 'ready' : ''}" data-sheet="${esc(s.name)}" role="tab" tabindex="0" aria-selected="${s.name === state.sheetName}">
                <input type="checkbox" class="import-sheet-include" data-sheet-cb="${esc(s.name)}" ${cfg.included ? 'checked' : ''} ${ready ? '' : 'disabled'} aria-label="Include ${esc(s.name)}" title="${ready ? 'Include this sheet' : 'Map the required columns to include this sheet'}">
                <span dir="auto">${esc(s.name)}</span>${s.hidden ? '<span class="tab-flag">hidden</span>' : ''}${!s.grid.length ? '<span class="tab-flag">empty</span>' : ''}
                <span class="tab-dot" aria-hidden="true"></span>
            </div>`;
        }).join('');
    }

    function renderDetection(s, cfg) {
        const conf = cfg.confidence || 0;
        const level = conf >= 0.85 ? 'high' : conf >= 0.6 ? 'medium' : 'low';
        const notes = (s.notes || []).concat(cfg.issues || []);
        byId('import-detect').innerHTML = `
            <div class="detect-row">
                <span class="confidence confidence-${level}">${level === 'high' ? 'Auto-detected' : level === 'medium' ? 'Please review' : 'Needs mapping'}</span>
                <span class="detect-meta">${fmt.num(s.grid.length)} rows · header on row <b>${cfg.headerRowIdx + 1}</b>${cfg.headerDepth === 2 ? '–' + (cfg.headerRowIdx + 2) : ''}</span>
            </div>
            <div class="detect-controls">
                <div class="segmented" role="radiogroup" aria-label="Sheet layout">
                    <button type="button" class="${cfg.layout === 'wide' ? 'active' : ''}" data-layout="wide" title="One row per item, one column per pharmacy">Wide · pharmacies as columns</button>
                    <button type="button" class="${cfg.layout === 'long' ? 'active' : ''}" data-layout="long" title="One row per pharmacy + item, with a quantity column">Long · one row per record</button>
                </div>
                <label class="check-inline"><input type="checkbox" id="import-two-row" ${cfg.headerDepth === 2 ? 'checked' : ''}> Two-row header</label>
                <button type="button" class="btn btn-sm btn-ghost" id="import-redetect">${D.ICON.undo(13)} Re-detect</button>
            </div>
            ${notes.length ? `<ul class="detect-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
        D.$$('[data-layout]', byId('import-detect')).forEach(b => b.addEventListener('click', () => {
            const c = cfgOf();
            if (c.layout === b.dataset.layout) return;
            const fresh = E.profileSheet(s, { headerRowIdx: c.headerRowIdx, headerDepth: c.headerDepth, layout: b.dataset.layout, classLabel: c.classLabel });
            state.configs[state.sheetName] = fresh;
            render();
        }));
        byId('import-two-row').addEventListener('change', e => {
            const c = cfgOf();
            state.configs[state.sheetName] = E.profileSheet(s, { headerRowIdx: c.headerRowIdx, headerDepth: e.target.checked ? 2 : 1, layout: c.layout, classLabel: c.classLabel });
            render();
        });
        byId('import-redetect').addEventListener('click', () => {
            state.configs[state.sheetName] = E.profileSheet(s, { classLabel: cfgOf().classLabel });
            render();
            D.toast('Sheet re-detected');
        });
    }

    function renderHeaderPicker(s, cfg) {
        const rows = s.grid.slice(0, 15);
        const colCount = Math.min(10, Math.max(1, ...rows.map(r => r.length)));
        byId('import-header-table').innerHTML = `<tbody>${rows.map((row, idx) => {
            const cls = idx === cfg.headerRowIdx || (cfg.headerDepth === 2 && idx === cfg.headerRowIdx + 1) ? 'is-header' : idx < cfg.headerRowIdx ? 'is-skipped' : '';
            return `<tr class="import-row-picker ${cls}" data-rowidx="${idx}" tabindex="0"><td class="import-row-num">${idx + 1}</td>${Array.from({ length: colCount }, (_, c) => `<td dir="auto">${esc(T.toStr(row[c]).slice(0, 40))}</td>`).join('')}</tr>`;
        }).join('')}</tbody>`;
        D.$$('.import-row-picker', byId('import-header-table')).forEach(tr => {
            const pick = () => {
                const c = cfgOf();
                state.configs[state.sheetName] = E.profileSheet(s, { headerRowIdx: +tr.dataset.rowidx, layout: c.layout, classLabel: c.classLabel });
                render();
            };
            tr.addEventListener('click', pick);
            tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        });
    }

    function renderColumns(s, cfg) {
        const cols = E.describeColumns(s, cfg);
        const opts = FIELD_OPTIONS[cfg.layout];
        byId('import-col-help').textContent = cfg.layout === 'wide'
            ? 'Each "Pharmacy qty" column becomes one pharmacy — its header is the pharmacy name. Totals columns are skipped automatically.'
            : 'Item, Pharmacy and Quantity are required. Use Fill Down for group labels that are only written on the first row of a block.';
        byId('import-column-grid').innerHTML = cols.map(c => {
            const mapped = cfg.columnMap[c.j] || 'ignore';
            const fill = cfg.fillDir[c.j] || 'none';
            const isTotal = H.isTotalLabel(c.label) || H.isTotalLabel(c.group || '');
            const kind = c.stats.filled === 0 ? 'empty' : c.stats.numericRatio > 0.7 ? 'numbers' : c.stats.numericRatio > 0.2 ? 'mixed' : 'text';
            return `<div class="import-col-card ${mapped !== 'ignore' ? 'mapped' : ''} field-${mapped}">
                <div class="import-col-top">
                    <span class="import-col-idx">${String.fromCharCode(65 + (c.j % 26))}${c.j >= 26 ? Math.floor(c.j / 26) : ''}</span>
                    <span class="import-col-kind kind-${kind}">${kind}${isTotal ? ' · total' : ''}</span>
                </div>
                <div class="import-col-header" title="${esc(c.label)}" dir="auto">${c.group ? `<small>${esc(c.group)} ›</small> ` : ''}${esc(c.label || '(blank header)')}</div>
                <div class="import-col-sample" dir="auto">${c.stats.sample.length ? c.stats.sample.map(esc).join(' · ') : '<span class="muted">no values</span>'}</div>
                <select class="import-col-map" data-colidx="${c.j}" aria-label="Map column ${esc(c.label || c.j + 1)}">
                    ${opts.map(([v, l]) => `<option value="${v}" ${v === mapped ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                <div class="import-col-fill ${FILLABLE.has(mapped) ? '' : 'hidden'}" data-colidx="${c.j}">
                    <button type="button" class="fill-mini-btn ${fill === 'none' ? 'active' : ''}" data-filldir="none">No fill</button>
                    <button type="button" class="fill-mini-btn ${fill === 'down' ? 'active' : ''}" data-filldir="down">↓ Down</button>
                    <button type="button" class="fill-mini-btn ${fill === 'up' ? 'active' : ''}" data-filldir="up">↑ Up</button>
                </div>
            </div>`;
        }).join('') || '<div class="muted">No columns detected on this header row.</div>';

        D.$$('.import-col-map', byId('import-column-grid')).forEach(sel => sel.addEventListener('change', () => {
            const c = cfgOf(), j = sel.dataset.colidx, v = sel.value;
            // single-instance fields: un-map the previous owner
            if (v !== 'ignore' && v !== 'wq') Object.keys(c.columnMap).forEach(k => { if (k !== j && c.columnMap[k] === v) c.columnMap[k] = 'ignore'; });
            c.columnMap[j] = v;
            if (!FILLABLE.has(v)) c.fillDir[j] = 'none';
            c.included = E.missingFields(c).length === 0;
            renderTabs(); renderColumns(s, c); renderPreview();
        }));
        D.$$('.fill-mini-btn', byId('import-column-grid')).forEach(btn => btn.addEventListener('click', () => {
            cfgOf().fillDir[btn.closest('.import-col-fill').dataset.colidx] = btn.dataset.filldir;
            renderColumns(s, cfgOf()); renderPreview();
        }));
    }

    function renderPreview() {
        const s = sheet(), cfg = cfgOf();
        const res = E.extractSheet(s, cfg, { sourceLabel: s.name });
        const headers = ['Class', 'Branch', 'Pharmacy', 'Item', 'Unit', 'Qty', 'Price'];
        const sample = res.records.slice(0, 10);
        byId('import-final-preview').innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${sample.length
            ? sample.map(r => `<tr><td>${esc(r.t)}</td><td dir="auto">${esc(r.branch || '—')}</td><td dir="auto">${esc(r.p)}</td><td dir="auto">${esc(r.i)}</td><td dir="auto">${esc(r.u || '—')}</td><td class="num">${fmt.num(r.q)}</td><td class="num">${r.price ? fmt.egp(r.price) : '—'}</td></tr>`).join('')
            : `<tr><td colspan="7" class="import-empty">No valid rows with the current mapping</td></tr>`}</tbody>`;

        const sum = byId('import-preview-summary');
        if (res.missing.length) {
            sum.innerHTML = `<span class="value-danger">Map ${res.missing.join(' and ')} to import this sheet</span>`;
        } else {
            const st = res.stats, chips = [];
            chips.push(`<b>${fmt.num(res.records.length)}</b> records`);
            if (st.filled) chips.push(`${fmt.num(st.filled)} cells filled`);
            if (st.corrected) chips.push(`${fmt.num(st.corrected)} values repaired`);
            if (st.totals) chips.push(`${fmt.num(st.totals)} total rows skipped`);
            if (st.repeatedHeaders) chips.push(`${fmt.num(st.repeatedHeaders)} repeated headers skipped`);
            if (st.sections) chips.push(`${fmt.num(st.sections)} title rows skipped`);
            const bad = res.anomalies.filter(a => a.sev === 'error' || a.sev === 'unparseable').length;
            if (bad) chips.push(`<span class="value-warn">${fmt.num(bad)} flagged</span>`);
            sum.innerHTML = chips.map(c => `<span class="summary-chip">${c}</span>`).join('');
        }

        const all = E.parseWorkbook(state.wb, state.configs, { sourceLabel: state.file.name });
        const btn = byId('btn-import-confirm');
        btn.disabled = !all.records.length;
        const n = state.wb.sheets.length;
        btn.textContent = all.records.length
            ? (n > 1 ? `Import ${fmt.num(all.records.length)} records from ${all.included.length}/${n} sheets` : `Import ${fmt.num(all.records.length)} records`)
            : 'Nothing to import';
    }

    /* ---------- commit ---------- */
    async function confirm() {
        if (!state) return;
        const res = E.parseWorkbook(state.wb, state.configs, { sourceLabel: state.file.name, srcId: state.srcId || '' });
        if (!res.records.length) return;
        const srcId = state.srcId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        res.records.forEach(r => { r.srcId = srcId; });
        const filled = Object.values(res.stats).reduce((s, x) => s + x.filled, 0);
        const entry = {
            kind: 'local', label: state.file.name, file: state.file, buffer: state.buffer,
            records: res.records, anomalies: res.anomalies, truncated: res.truncated,
            rows: res.records.length, filledCount: filled, status: 'local', ts: Date.now(),
            wizardConfig: { lastSheet: state.sheetName, sheetConfigs: JSON.parse(JSON.stringify(state.configs)) }
        };
        const name = state.file.name, skipped = res.skipped.length;
        close();
        await LX.sources.addLocal(srcId, entry);
        delete entry.buffer;
        LX.app.rebuild();
        D.toast(`${name} imported — ${fmt.num(res.records.length)} records${filled ? `, ${fmt.num(filled)} filled` : ''}${skipped ? ` (${skipped} sheet${skipped > 1 ? 's' : ''} skipped)` : ''}`);
    }

    function init() {
        byId('btn-import-close').addEventListener('click', close);
        byId('btn-import-cancel').addEventListener('click', close);
        byId('btn-import-confirm').addEventListener('click', confirm);
        modal().addEventListener('mousedown', e => { if (e.target === modal()) close(); });
        modal().addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            else D.trapTab(e, modal());
        });
        byId('import-class-label').addEventListener('input', e => { cfgOf().classLabel = e.target.value; renderPreview(); });
        byId('import-sheet-tabs').addEventListener('click', e => {
            const cb = e.target.closest('.import-sheet-include');
            if (cb) { cfgOf(cb.dataset.sheetCb).included = cb.checked; renderPreview(); return; }
            const tab = e.target.closest('[data-sheet]');
            if (tab && tab.dataset.sheet !== state.sheetName) { state.sheetName = tab.dataset.sheet; render(); }
        });
        byId('import-sheet-tabs').addEventListener('keydown', e => {
            const tab = e.target.closest('[data-sheet]');
            if (tab && (e.key === 'Enter' || e.key === ' ') && e.target === tab) { e.preventDefault(); state.sheetName = tab.dataset.sheet; render(); }
        });
    }

    LX.importer = { init, openFromFile, close, get isOpen() { return !!state; } };
})(window.LX = window.LX || {});
