/* ==========================================================================
   LX Parser — app.js
   Orchestrator: boot sequence, sync, rebuild, trends, auto-sync.

   Module map
     core/    config · text                 (pure, no DOM)
     parser/  numbers · headers · reader · resolver · engine
     data/    store · state · sources · database
     ui/      dom · table · views · filters · importer · actions · chrome
   ========================================================================== */
(function (LX) {
    'use strict';
    const D = LX.dom, C = LX.config, S = LX.state, st = S.state;
    const { byId, fmt } = D;

    let renderQueued = false;
    function render() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            try { LX.views.render(); LX.bus.emit('rendered'); }
            catch (e) { console.error('[LX] render failed', e); }
        });
    }

    function rebuild() {
        LX.db.build();
        LX.filters.populate();
        LX.views.markAll();
        render();
        if (byId('data-panel').classList.contains('open')) LX.chrome.renderDataPanel();
    }

    /* ---------- trends ---------- */
    function pushHistory() {
        const rows = LX.db.DB.rows;
        const snap = {
            ts: Date.now(),
            tvl: rows.reduce((s, r) => s + r.tot, 0),
            qty: rows.reduce((s, r) => s + r.q, 0),
            assets: new Set(rows.map(r => r.ik + '\u0000' + r.u)).size
        };
        const last = st.syncHistory[st.syncHistory.length - 1];
        // don't record identical consecutive snapshots within 5 minutes
        if (last && last.tvl === snap.tvl && last.qty === snap.qty && last.assets === snap.assets && snap.ts - last.ts < 5 * 60 * 1000) return;
        st.syncHistory.push(snap);
        if (st.syncHistory.length > 30) st.syncHistory = st.syncHistory.slice(-30);
        S.persist.syncHistory();
        renderTrends();
    }

    function renderTrends() {
        const h = st.syncHistory;
        if (!h.length) return;
        const last12 = h.slice(-12);
        D.sparkline(byId('spark-tvl'), last12.map(x => x.tvl));
        D.sparkline(byId('spark-qty'), last12.map(x => x.qty));
        D.sparkline(byId('spark-assets'), last12.map(x => x.assets));
        const prev = h.length > 1 ? h[h.length - 2] : null, cur = h[h.length - 1];
        const delta = (id, a, b) => {
            const el = byId(id);
            if (b == null || b === 0) { el.textContent = ''; el.className = 'metric-delta flat'; return; }
            const pct = ((a - b) / b) * 100;
            if (Math.abs(pct) < 0.05) { el.textContent = '—'; el.className = 'metric-delta flat'; return; }
            el.className = 'metric-delta ' + (pct > 0 ? 'up' : 'down');
            el.textContent = (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '%';
            el.title = `vs. previous sync (${D.relTime(prev.ts)})`;
        };
        delta('delta-tvl', cur.tvl, prev && prev.tvl);
        delta('delta-qty', cur.qty, prev && prev.qty);
        delta('delta-assets', cur.assets, prev && prev.assets);
    }

    /* ---------- sync ---------- */
    let syncing = false;
    async function sync(silent) {
        if (syncing) return;
        syncing = true;
        const btn = byId('btn-sync');
        btn.classList.remove('sync-success', 'sync-error');
        btn.classList.add('syncing');
        btn.setAttribute('aria-busy', 'true');
        byId('sync-progress').classList.add('active');
        LX.chrome.setSignalPulsing(true);
        try {
            const { statuses, warnings } = await LX.sources.syncRemote(() => { LX.chrome.updateSignalStrip(); rebuild(); });
            pushHistory();
            LX.chrome.updateLastSync();
            const live = statuses.filter(s => s && s.status === 'live').length;
            const cached = statuses.filter(s => s && s.status === 'cached').length;
            const failed = statuses.filter(s => !s || s.status === 'error').length;
            if (failed === statuses.length) { btn.classList.add('sync-error'); if (!silent) D.toast('All remote sources failed to sync', 'error', { label: 'Retry', fn: () => sync(false) }); }
            else if (cached || failed) { btn.classList.add('sync-error'); if (!silent) D.toast(`Synced with fallbacks — ${live} live, ${cached} cached${failed ? ', ' + failed + ' failed' : ''}`, 'warning'); }
            else { btn.classList.add('sync-success'); if (!silent) D.toast(`All ${live} sources synced live`); }
            warnings.forEach(w => D.toast(w, 'warning'));
            return { statuses };
        } catch (e) {
            btn.classList.add('sync-error');
            D.toast(e.message || 'Sync failed', 'error');
            console.error('[LX] sync failed', e);
        } finally {
            syncing = false;
            btn.classList.remove('syncing');
            btn.removeAttribute('aria-busy');
            byId('sync-progress').classList.remove('active');
            LX.chrome.setSignalPulsing(false);
            setTimeout(() => btn.classList.remove('sync-success', 'sync-error'), 1600);
        }
    }

    function initAutoSync() {
        const btn = byId('btn-autosync');
        let timer = null;
        const set = on => {
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', String(on));
            clearInterval(timer); timer = null;
            if (on) timer = setInterval(() => { if (!document.hidden) sync(true); }, C.AUTO_SYNC_MS);
        };
        set(LX.store.ls.getRaw(C.KEYS.autoSync) === '1');
        btn.addEventListener('click', () => {
            const next = !btn.classList.contains('active');
            LX.store.ls.set(C.KEYS.autoSync, next ? '1' : '0');
            set(next);
            D.toast(next ? 'Auto-sync on — every 10 minutes while this tab is visible' : 'Auto-sync off');
        });
        byId('btn-sync').addEventListener('click', () => sync(false));
    }

    /* ---------- boot ---------- */
    async function boot() {
        const overlay = byId('sync-overlay');
        LX.store.ls.onError(kind => { if (kind === 'quota') D.toast('Browser storage is full — some settings may not be saved', 'warning'); });
        let storageWarned = false;
        LX.bus.on('storage-warning', msg => { if (!storageWarned) { storageWarned = true; D.toast(msg, 'warning'); } });

        LX.views.init();
        LX.filters.init();
        LX.actions.init();
        LX.importer.init();
        LX.chrome.init();
        initAutoSync();
        renderTrends();
        LX.bus.on('filters:change', () => { LX.views.markSearchDirty(); render(); LX.filters.syncURL(LX.views.current); });

        const url = LX.filters.readURL();
        const hide = () => { overlay.classList.add('done'); };

        // 1. local files + cached remote → instant first paint
        try {
            byId('sync-text').textContent = 'Restoring your files…';
            await Promise.all([LX.sources.restoreLocal(), LX.sources.restoreRemoteCache()]);
        } catch (e) { console.warn('[LX] restore failed', e); }
        rebuild();
        LX.filters.apply(url.state);
        LX.chrome.switchView(url.view && byId(url.view) ? url.view : 'view-overview');
        if (url.subtab && ['issues', 'variants', 'duplicates'].includes(url.subtab)) LX.views.setSubtab(url.subtab);
        LX.chrome.updateSignalStrip();
        if (LX.db.DB.rows.length) hide();
        else byId('sync-text').textContent = 'Syncing remote sources…';

        // 2. live sync
        const res = await sync(true);
        hide();
        if (res) {
            const s = res.statuses;
            if (s.every(x => !x || x.status === 'error')) D.toast('Could not reach any remote source — add a local file, or retry', 'error', { label: 'Retry', fn: () => sync(false) });
            else if (s.some(x => x && x.status !== 'live')) D.toast('Some sources loaded from cache — open Sync Health for details', 'warning');
        }
    }

    LX.app = { boot, rebuild, render, sync };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})(window.LX = window.LX || {});
