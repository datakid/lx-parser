/* ==========================================================================
   LX Parser — ui/chrome.js
   App chrome: navigation, sync-health & data panels, command palette,
   shortcuts modal, theme switch, stale banner, global drag-and-drop.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, D = LX.dom, C = LX.config, S = LX.state, st = S.state, ls = LX.store.ls;
    const { byId, $, $$, fmt } = D;
    const esc = T.escapeHTML;

    const VIEW_LABELS = {
        'view-overview': 'Overview', 'view-breakdown': 'Breakdown', 'view-pricing': 'Pricing Config',
        'view-pharmacies': 'Region Map', 'view-missing': 'Missing Pharms', 'view-anomalies': 'Data Health'
    };

    /* ---------- popover panels ---------- */
    const panels = {};
    function registerPanel(name, trigger, panel, onOpen) { panels[name] = { trigger, panel, onOpen }; }
    function closePanels(except) {
        Object.keys(panels).forEach(k => {
            if (k === except) return;
            panels[k].panel.classList.remove('open');
            panels[k].trigger.setAttribute('aria-expanded', 'false');
            panels[k].trigger.classList.remove('open');
        });
    }
    function togglePanel(name) {
        const p = panels[name];
        closePanels(name);
        const open = p.panel.classList.toggle('open');
        p.trigger.setAttribute('aria-expanded', String(open));
        p.trigger.classList.toggle('open', open);
        if (open && p.onOpen) p.onOpen();
    }

    /* ---------- navigation ---------- */
    function switchView(id) {
        if (!byId(id)) return;
        $$('.nav-btn').forEach(b => { const on = b.dataset.target === id; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
        $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
        byId('nav-compact-label').textContent = VIEW_LABELS[id] || '';
        LX.views.setView(id);
        const wrap = byId('cmd-wrapper'), onBreakdown = id === 'view-breakdown';
        wrap.classList.toggle('palette-disabled', onBreakdown);
        LX.app.render();
        LX.filters.syncURL(id);
    }

    function positionNavDropdown() {
        const trig = byId('nav-compact-trigger'), nav = $('.nav-links'), r = trig.getBoundingClientRect();
        nav.style.top = `${r.bottom + 10}px`;
        nav.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - 16 - Math.max(r.width, 220)))}px`;
        nav.style.width = `${Math.max(r.width, 220)}px`;
    }

    function initNav() {
        $$('.nav-btn').forEach(b => b.addEventListener('click', () => { switchView(b.dataset.target); closePanels(); }));
        const trig = byId('nav-compact-trigger'), nav = $('.nav-links');
        registerPanel('nav', trig, nav, positionNavDropdown);
        trig.addEventListener('click', e => { e.stopPropagation(); togglePanel('nav'); });
        window.addEventListener('resize', () => { if (nav.classList.contains('open')) positionNavDropdown(); });
        const fade = () => { nav.classList.toggle('at-start', nav.scrollLeft <= 2); nav.classList.toggle('at-end', nav.scrollLeft >= nav.scrollWidth - nav.clientWidth - 2); };
        nav.addEventListener('scroll', fade, { passive: true });
        window.addEventListener('resize', fade);
        fade();
    }

    /* ---------- sync health ---------- */
    function initSignalStrip() {
        byId('signal-strip').innerHTML = C.SOURCES.map(s => `<span class="signal-node" data-id="${s.id}" title="${esc(s.label)}"><span class="signal-dot"></span></span>`).join('');
    }
    function updateSignalStrip() {
        $$('.signal-node').forEach(n => {
            const s = st.sourceStatus[n.dataset.id];
            n.classList.remove('sig-live', 'sig-cached', 'sig-error', 'sig-idle');
            n.classList.add(!s ? 'sig-idle' : s.status === 'live' ? 'sig-live' : s.status === 'cached' ? 'sig-cached' : 'sig-error');
        });
        if (byId('sync-health-panel').classList.contains('open')) renderSyncHealth();
    }
    function setSignalPulsing(on) { $$('.signal-node').forEach(n => n.classList.toggle('sig-pulsing', on)); }

    function renderSyncHealth() {
        byId('sync-health-panel').innerHTML = `<div class="panel-title">Remote sources</div>` + C.SOURCES.map(s => {
            const x = st.sourceStatus[s.id] || { status: 'idle' };
            const src = LX.sources.sources[s.id];
            const dot = x.status === 'live' ? 'status-ok' : x.status === 'error' ? 'status-missing' : 'status-inactive';
            const label = { live: 'Live', cached: 'Cached fallback', error: 'Failed', idle: 'Not synced yet' }[x.status] || x.status;
            const layout = src && src.layout ? ` · ${src.layout}` : '';
            return `<div class="panel-row">
                <span class="status-dot ${dot}"></span>
                <div class="panel-info">
                    <div class="panel-label">${esc(s.label)}</div>
                    <div class="panel-meta">${esc(label)} · ${x.ts ? D.relTime(x.ts) : '—'}${x.rows ? ' · ' + fmt.num(x.rows) + ' records' : ''}${esc(layout)}</div>
                    ${x.error ? `<div class="panel-warn">${esc(x.error)}</div>` : ''}${x.warning ? `<div class="panel-warn">${esc(x.warning)}</div>` : ''}
                </div>
            </div>`;
        }).join('') + `<div class="panel-foot">Remote sheets use the same auto-detecting parser as local files.</div>`;
    }

    /* ---------- data panel ---------- */
    function renderDataPanel() {
        const panel = byId('data-panel');
        const locals = Object.entries(LX.sources.sources).filter(([, s]) => s.kind === 'local');
        const { priceOrphans, pharmOrphans } = LX.db.orphans();
        const orphanTotal = priceOrphans.length + pharmOrphans.length;
        const aliasCount = ['p', 'i', 'u', 'branch'].reduce((n, k) => n + Object.keys(st.aliases[k] || {}).length, 0);

        panel.innerHTML = `
            <div class="panel-title">Local files</div>
            ${locals.length ? locals.map(([id, s]) => `
                <div class="panel-row">
                    <span class="file-icon">${D.ICON.file(16)}</span>
                    <div class="panel-info">
                        <div class="panel-label" dir="auto" title="${esc(s.label)}">${esc(s.label)}</div>
                        <div class="panel-meta">${fmt.num(s.rows)} records${s.filledCount ? ' · ' + fmt.num(s.filledCount) + ' filled' : ''} · ${s.ts ? D.relTime(s.ts) : ''}</div>
                    </div>
                    <button type="button" class="icon-btn" data-edit-id="${esc(id)}" title="Edit import settings" aria-label="Edit ${esc(s.label)}">${D.ICON.edit(14)}</button>
                    <button type="button" class="icon-btn danger" data-remove-id="${esc(id)}" title="Remove this file" aria-label="Remove ${esc(s.label)}">${D.ICON.x(14)}</button>
                </div>`).join('') : `<div class="panel-row"><div class="panel-meta">No local files added yet.</div></div>`}
            <label class="upload-box" id="local-drop-zone">
                ${D.ICON.upload(28)}
                <span class="upload-title">Add local file</span>
                <span class="upload-msg">Click or drop · .xlsx .xls .ods .csv</span>
                <input type="file" id="local-file-input" accept="${C.ACCEPT_FILES}">
            </label>
            <div class="panel-title">Maintenance</div>
            <div class="panel-row">
                <div class="panel-info">
                    <div class="panel-label label-hint" title="Prices and region assignments are kept by item/pharmacy so they survive a source going temporarily missing. Prune permanently deletes entries that no longer match anything in your current data.">Orphaned entries</div>
                    <div class="panel-meta">${fmt.num(orphanTotal)} price / pharmacy entr${orphanTotal === 1 ? 'y' : 'ies'} not seen in any source</div>
                </div>
                <button type="button" class="btn btn-sm${orphanTotal ? ' btn-prune-active' : ''}" id="btn-prune-orphans" ${orphanTotal ? '' : 'disabled'}>Prune</button>
            </div>
            <div class="panel-row">
                <div class="panel-info">
                    <div class="panel-label">Name rules</div>
                    <div class="panel-meta">${fmt.num(aliasCount)} manual merge rule${aliasCount === 1 ? '' : 's'}</div>
                </div>
                <button type="button" class="btn btn-sm" id="btn-open-variants">Review</button>
            </div>`;

        $$('[data-remove-id]', panel).forEach(b => b.addEventListener('click', async e => {
            e.stopPropagation();
            const s = LX.sources.sources[b.dataset.removeId];
            if (!s) return;
            await LX.sources.removeLocal(b.dataset.removeId);
            LX.app.rebuild();
            renderDataPanel();
            D.toast(`${s.label} removed`);
        }));
        $$('[data-edit-id]', panel).forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            const s = LX.sources.sources[b.dataset.editId];
            closePanels();
            if (s && s.file) LX.importer.openFromFile(s.file, b.dataset.editId, s.wizardConfig);
            else D.toast('Original file no longer available — remove and re-add it', 'error');
        }));
        byId('btn-prune-orphans').addEventListener('click', async () => {
            if (!(await D.confirmDialog(`Remove ${fmt.num(priceOrphans.length)} orphaned price entr${priceOrphans.length === 1 ? 'y' : 'ies'} and ${fmt.num(pharmOrphans.length)} pharmacy entr${pharmOrphans.length === 1 ? 'y' : 'ies'}? This can't be undone.`))) return;
            const n = LX.db.pruneOrphans();
            LX.actions.refreshRegionSuggestions();
            LX.views.markAll(); LX.app.render();
            renderDataPanel();
            D.toast(`Pruned ${fmt.num(n)} orphaned entr${n === 1 ? 'y' : 'ies'}`);
        });
        byId('btn-open-variants').addEventListener('click', () => { closePanels(); switchView('view-anomalies'); LX.views.setSubtab('variants'); });
        byId('local-file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) { closePanels(); LX.importer.openFromFile(f); } e.target.value = ''; });
        LX.actions.wireDrop(byId('local-drop-zone'), f => { closePanels(); LX.importer.openFromFile(f); });
    }

    /* ---------- labels & banners ---------- */
    function updateLastSync() {
        const el = byId('last-sync-label'), ts = parseInt(ls.getRaw(C.KEYS.lastSync, '0'), 10);
        el.textContent = ts ? 'Synced ' + D.relTime(ts) : '';
        el.classList.toggle('stale', !!ts && Date.now() - ts > C.STALE_LABEL_MS);
        const banner = byId('stale-banner'), stale = !ts || Date.now() - ts > C.STALE_BANNER_MS;
        banner.classList.toggle('visible', stale);
        if (stale) byId('stale-banner-msg').textContent = ts ? 'Remote data hasn\'t synced in over 24 hours.' : 'Remote data hasn\'t synced yet — showing local files only, if any are added.';
    }

    /* ---------- theme ---------- */
    function setTheme(pref) {
        ls.set(C.KEYS.theme, pref);
        const resolved = pref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
        const r = document.documentElement;
        r.dataset.theme = resolved; r.dataset.themePref = pref; r.style.colorScheme = resolved;
        $$('.theme-switch-btn').forEach(b => { const on = b.dataset.themeChoice === pref; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
    }
    function initTheme() {
        setTheme(document.documentElement.dataset.themePref || ls.getRaw(C.KEYS.theme, 'system'));
        $$('.theme-switch-btn').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.themeChoice)));
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (ls.getRaw(C.KEYS.theme, 'system') === 'system') setTheme('system'); });
    }

    /* ---------- modals ---------- */
    function openModal(el, focusEl) {
        el._prev = document.activeElement;
        el.classList.add('open');
        document.body.classList.add('modal-open');
        setTimeout(() => focusEl && focusEl.focus(), 50);
    }
    function closeModal(el) {
        el.classList.remove('open');
        if (!$('.cmd-modal.open')) document.body.classList.remove('modal-open');
        if (el._prev && el._prev.focus) el._prev.focus();
    }

    /* ---------- command palette ---------- */
    let cmdIndex = 0, cmdItems = [];
    function commands() {
        const go = (id, sub) => () => { switchView(id); if (sub) LX.views.setSubtab(sub); };
        return [
            { title: 'Go to Overview', sub: 'View', run: go('view-overview') },
            { title: 'Go to Breakdown', sub: 'View', run: go('view-breakdown') },
            { title: 'Go to Pricing Config', sub: 'View', run: go('view-pricing') },
            { title: 'Go to Region Map', sub: 'View', run: go('view-pharmacies') },
            { title: 'Go to Missing Pharms', sub: 'View', run: go('view-missing') },
            { title: 'Go to Parse Issues', sub: 'Data Health', run: go('view-anomalies', 'issues') },
            { title: 'Go to Duplicates', sub: 'Data Health', run: go('view-anomalies', 'duplicates') },
            { title: 'Go to Name Variants', sub: 'Data Health', run: go('view-anomalies', 'variants') },
            { title: 'Sync remote sources', sub: 'Action', run: () => LX.app.sync(false) },
            { title: 'Add local file…', sub: 'Action', run: () => byId('global-file-input').click() },
            { title: 'Export current view', sub: 'Action · Ctrl+S', run: LX.actions.exportView },
            { title: 'Clear search & filters', sub: 'Action', run: LX.filters.clearAll },
            { title: 'Sync health', sub: 'Panel', run: () => togglePanel('sync') },
            { title: 'Local files & data settings', sub: 'Panel', run: () => togglePanel('data') },
            { title: 'Light theme', sub: 'Theme', run: () => setTheme('light') },
            { title: 'Dark theme', sub: 'Theme', run: () => setTheme('dark') },
            { title: 'Match system theme', sub: 'Theme', run: () => setTheme('system') },
            { title: 'Keyboard shortcuts', sub: 'Help · ?', run: () => openModal(byId('shortcuts-modal'), byId('btn-shortcuts-close')) }
        ];
    }
    function renderCmd(q) {
        const tokens = T.tokenize(q);
        cmdItems = commands().filter(c => T.isMatch(tokens, T.fold(c.title + ' ' + c.sub), false));
        cmdIndex = 0;
        const res = byId('cmd-modal-results');
        res.innerHTML = cmdItems.length ? cmdItems.map((c, i) => `<div class="cmd-item ${i === 0 ? 'active' : ''}" data-idx="${i}" role="option" aria-selected="${i === 0}">
            <span class="cmd-icon">${D.ICON.cmd(15)}</span>
            <div><div class="cmd-item-title">${T.highlight(c.title, tokens)}</div><div class="cmd-item-sub">${esc(c.sub)}</div></div>
            <kbd class="cmd-enter">↵</kbd></div>`).join('') : `<div class="cmd-empty">No commands match "${esc(q)}"</div>`;
    }
    function setCmdActive(i) {
        cmdIndex = i;
        $$('#cmd-modal-results .cmd-item').forEach((el, j) => { el.classList.toggle('active', j === i); el.setAttribute('aria-selected', String(j === i)); if (j === i) el.scrollIntoView({ block: 'nearest' }); });
    }
    function runCmd(i) { const c = cmdItems[i]; if (!c) return; closeModal(byId('cmd-modal')); c.run(); }

    function initPalette() {
        const modal = byId('cmd-modal'), input = byId('cmd-modal-input'), res = byId('cmd-modal-results');
        input.addEventListener('input', () => renderCmd(input.value));
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') { e.preventDefault(); setCmdActive(Math.min(cmdIndex + 1, cmdItems.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdActive(Math.max(cmdIndex - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIndex); }
            else if (e.key === 'Escape') { e.preventDefault(); closeModal(modal); }
            else D.trapTab(e, modal);
        });
        res.addEventListener('click', e => { const it = e.target.closest('.cmd-item'); if (it) runCmd(+it.dataset.idx); });
        res.addEventListener('mousemove', e => { const it = e.target.closest('.cmd-item'); if (it && +it.dataset.idx !== cmdIndex) setCmdActive(+it.dataset.idx); });
        modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(modal); });
        byId('btn-palette').addEventListener('click', openPalette);

        const sc = byId('shortcuts-modal');
        byId('btn-shortcuts').addEventListener('click', () => openModal(sc, byId('btn-shortcuts-close')));
        byId('btn-shortcuts-close').addEventListener('click', () => closeModal(sc));
        sc.addEventListener('mousedown', e => { if (e.target === sc) closeModal(sc); });
        sc.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeModal(sc); } else D.trapTab(e, sc); });
    }
    function openPalette() {
        const input = byId('cmd-modal-input');
        input.value = '';
        renderCmd('');
        openModal(byId('cmd-modal'), input);
    }

    /* ---------- keyboard ---------- */
    let activeRow = -1;
    function initKeys() {
        document.addEventListener('keydown', e => {
            const tag = document.activeElement.tagName, inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
            if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); LX.actions.exportView(); return; }
            if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); byId('global-file-input').click(); return; }
            if ($('.cmd-modal.open')) return;
            if (e.key === 'Escape') {
                if (document.activeElement === LX.filters.omni) { LX.filters.omni.value = ''; LX.filters.syncOmniClear(); LX.bus.emit('filters:change', { search: true }); LX.filters.invalidate(); LX.filters.omni.blur(); return; }
                closePanels();
                return;
            }
            if (inInput) {
                if (document.activeElement.classList.contains('editable') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    const tr = document.activeElement.closest('tr'), rows = $$('tr', tr.parentElement).filter(r => r.querySelector('.editable'));
                    const i = rows.indexOf(tr), next = rows[e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)];
                    if (next) { e.preventDefault(); const inp = next.querySelector('.editable'); inp.focus(); inp.select && inp.select(); }
                }
                return;
            }
            if (e.key === '?') { e.preventDefault(); openModal(byId('shortcuts-modal'), byId('btn-shortcuts-close')); return; }
            if (e.key === '/') { e.preventDefault(); LX.filters.omni.focus(); return; }
            if (e.key >= '1' && e.key <= '6' && !mod && !e.altKey) {
                const btn = $$('.nav-btn')[+e.key - 1];
                if (btn) { e.preventDefault(); switchView(btn.dataset.target); }
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                const tbody = $('.view.active .table-card:not(.hidden) tbody, .view.active .anomalies-subtab:not(.hidden) tbody');
                if (!tbody) return;
                const rows = $$('tr:not(.empty-row):not(.drill-down-row)', tbody);
                if (!rows.length) return;
                e.preventDefault();
                activeRow = e.key === 'ArrowDown' ? Math.min(activeRow + 1, rows.length - 1) : Math.max(activeRow - 1, 0);
                rows.forEach((r, i) => r.classList.toggle('selected-row', i === activeRow));
                rows[activeRow].scrollIntoView({ block: 'nearest' });
                if (rows[activeRow].tabIndex >= 0) rows[activeRow].focus({ preventScroll: true });
            }
        });
        LX.bus.on('rendered', () => { activeRow = -1; });
    }

    /* ---------- global drag & drop ---------- */
    function initGlobalDrop() {
        const overlay = byId('drop-overlay');
        let depth = 0;
        const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
        window.addEventListener('dragenter', e => {
            if (!hasFiles(e) || LX.importer.isOpen) return;
            if (e.target.closest && (e.target.closest('#view-pricing .action-row') || e.target.closest('#view-pharmacies .action-row') || e.target.closest('#local-drop-zone'))) return;
            depth++; overlay.classList.add('visible');
        });
        window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
        window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.classList.remove('visible'); } });
        window.addEventListener('drop', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            const wasOverlay = overlay.classList.contains('visible');
            depth = 0; overlay.classList.remove('visible');
            if (!wasOverlay) return;
            const f = e.dataTransfer.files[0];
            if (f) LX.importer.openFromFile(f);
        });
        byId('global-file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) LX.importer.openFromFile(f); e.target.value = ''; });
    }

    function init() {
        initNav();
        initSignalStrip();
        registerPanel('sync', byId('sync-health-trigger'), byId('sync-health-panel'), renderSyncHealth);
        registerPanel('data', byId('data-panel-trigger'), byId('data-panel'), renderDataPanel);
        byId('sync-health-trigger').addEventListener('click', e => { e.stopPropagation(); togglePanel('sync'); });
        byId('data-panel-trigger').addEventListener('click', e => { e.stopPropagation(); togglePanel('data'); });
        document.addEventListener('click', e => {
            Object.keys(panels).forEach(k => {
                const p = panels[k];
                if (!p.panel.contains(e.target) && !p.trigger.contains(e.target) && p.panel.classList.contains('open')) {
                    p.panel.classList.remove('open'); p.trigger.setAttribute('aria-expanded', 'false'); p.trigger.classList.remove('open');
                }
            });
        });
        initTheme();
        initPalette();
        initKeys();
        initGlobalDrop();
        byId('stale-banner-sync').addEventListener('click', () => LX.app.sync(false));
        updateLastSync();
        setInterval(updateLastSync, 30000);
        const blobs = $$('.aurora-blob');
        document.addEventListener('visibilitychange', () => blobs.forEach(b => { b.style.animationPlayState = document.hidden ? 'paused' : 'running'; }));
    }

    LX.chrome = { init, switchView, updateSignalStrip, setSignalPulsing, updateLastSync, renderDataPanel, renderSyncHealth, closePanels, VIEW_LABELS };
})(window.LX = window.LX || {});
