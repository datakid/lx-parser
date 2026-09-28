/* ==========================================================================
   LX Parser — data/sources.js
   Remote + local source registry.

   Remote CSVs go through the SAME engine as local files (auto header,
   layout, fill-down, number repair). Cached per source for offline use.

   Local files keep the ORIGINAL bytes in IndexedDB together with the
   per-sheet wizard config, so a parser upgrade simply re-parses them on
   the next boot (PARSER_REV) — no re-uploading needed.
   ========================================================================== */
(function (LX) {
    'use strict';
    const C = LX.config, S = LX.state, ls = LX.store.ls, idb = LX.store.idb;
    const PARSER_REV = 2;

    /** id → { kind, label, records, anomalies, status, ts, rows, error, warning, truncated, file?, wizardConfig?, stats? } */
    const sources = {};

    /* ---------- remote ---------- */

    async function fetchText(url) {
        let lastErr;
        for (let attempt = 0; attempt <= C.FETCH_RETRIES; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), C.FETCH_TIMEOUT_MS);
            try {
                const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = await res.arrayBuffer();
                return LX.reader.decodeBytes(buf).text;
            } catch (e) {
                clearTimeout(timer);
                lastErr = e.name === 'AbortError' ? new Error('Timed out') : e;
                if (attempt < C.FETCH_RETRIES) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
            }
        }
        throw lastErr;
    }

    function parseRemote(def, text) {
        const wb = LX.reader.readText(text, def.label);
        const sheet = wb.sheets[0];
        if (!sheet.grid.length) throw new Error('Sheet is completely empty');
        const cfg = LX.engine.profileSheet(sheet, { layout: def.layout, classLabel: def.type });
        cfg.classLabel = def.type;
        if (!cfg.included) {
            const miss = LX.engine.missingFields(cfg);
            throw new Error(`Could not recognise the sheet layout (missing ${miss.join(', ')})`);
        }
        const res = LX.engine.extractSheet(sheet, cfg, { sourceLabel: def.label, srcId: def.id, classLabel: def.type });
        return { records: res.records, anomalies: res.anomalies, truncated: res.truncated, stats: res.stats, cfg };
    }

    const cacheKey = id => `lx_cache_${id}`;

    async function readCache(id) {
        try {
            const v = await idb.get(C.IDB_STORES.kv, cacheKey(id));
            if (v && v.rev === PARSER_REV) return v;
        } catch (e) {}
        return null;
    }
    async function writeCache(id, payload) {
        try { await idb.put(C.IDB_STORES.kv, Object.assign({ rev: PARSER_REV, ts: Date.now() }, payload), cacheKey(id)); }
        catch (e) { LX.bus.emit('storage-warning', 'Remote cache could not be saved — offline fallback unavailable'); }
    }

    function driftWarning(def, prevRows, newRows) {
        if (prevRows > 5 && newRows < prevRows * C.DRIFT_RATIO) {
            return `${def.label}: row count dropped from ${prevRows.toLocaleString()} to ${newRows.toLocaleString()} — check the source sheet.`;
        }
        return null;
    }

    /** Sync every remote source; onSettled fires after each one finishes. */
    async function syncRemote(onSettled) {
        const warnings = [];
        await Promise.all(C.SOURCES.map(async def => {
            const cached = await readCache(def.id);
            let entry;
            try {
                const text = await fetchText(def.url);
                if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Received a web page instead of CSV (is the sheet still published?)');
                const res = parseRemote(def, text);
                const drift = driftWarning(def, cached ? cached.records.length : (S.state.sourceStatus[def.id] || {}).rows || 0, res.records.length);
                if (drift) warnings.push(drift);
                writeCache(def.id, { records: res.records, anomalies: res.anomalies, truncated: res.truncated, text });
                entry = { kind: 'remote', label: def.label, records: res.records, anomalies: res.anomalies, truncated: res.truncated, stats: res.stats, layout: res.cfg.layout, status: 'live', ts: Date.now(), rows: res.records.length, warning: drift, error: null };
            } catch (err) {
                const msg = (err && err.message) || 'Fetch failed';
                entry = cached
                    ? { kind: 'remote', label: def.label, records: cached.records, anomalies: cached.anomalies, truncated: cached.truncated, status: 'cached', ts: cached.ts, rows: cached.records.length, error: msg, warning: null }
                    : { kind: 'remote', label: def.label, records: [], anomalies: [], status: 'error', ts: null, rows: 0, error: msg, warning: null };
            }
            sources[def.id] = entry;
            S.state.sourceStatus[def.id] = { label: def.label, status: entry.status, ts: entry.ts, rows: entry.rows, error: entry.error, warning: entry.warning };
            S.persist.sourceStatus();
            onSettled && onSettled(def.id, entry);
        }));
        const statuses = C.SOURCES.map(d => S.state.sourceStatus[d.id]);
        if (statuses.some(s => s && s.status === 'live')) ls.set(C.KEYS.lastSync, String(Date.now()));
        return { statuses, warnings };
    }

    /** Restore cached remote entries immediately (fast first paint). */
    async function restoreRemoteCache() {
        await Promise.all(C.SOURCES.map(async def => {
            const cached = await readCache(def.id);
            if (cached && !sources[def.id]) {
                sources[def.id] = { kind: 'remote', label: def.label, records: cached.records, anomalies: cached.anomalies, truncated: cached.truncated, status: 'cached', ts: cached.ts, rows: cached.records.length };
            }
        }));
        // v1 localStorage caches are obsolete (different record shape) — clean them up
        ls.keys(C.KEYS.legacyCachePrefix).forEach(k => ls.remove(k));
    }

    /* ---------- local ---------- */

    async function persistLocal(id, entry) {
        try {
            const buffer = entry.buffer || await entry.file.arrayBuffer();
            await idb.put(C.IDB_STORES.sources, {
                id, rev: PARSER_REV, label: entry.label, fileName: entry.file.name, fileType: entry.file.type, fileBuffer: buffer,
                wizardConfig: entry.wizardConfig, ts: entry.ts,
                records: entry.records, anomalies: entry.anomalies, rows: entry.rows, filledCount: entry.filledCount
            });
        } catch (e) {
            LX.bus.emit('storage-warning', 'Local files may not survive a reload in this browser (storage is unavailable)');
        }
    }

    async function restoreLocal() {
        let entries = [];
        try { entries = await idb.getAll(C.IDB_STORES.sources); } catch (e) { return; }
        for (const e of entries) {
            const file = new File([e.fileBuffer], e.fileName, { type: e.fileType || '' });
            let records = e.records, anomalies = e.anomalies, rows = e.rows, filledCount = e.filledCount, truncated = false, reparsed = false;
            if (e.rev !== PARSER_REV) {
                // parser upgraded → re-read the original bytes with the saved (or fresh) config
                try {
                    const wb = LX.reader.readBuffer(e.fileBuffer, e.fileName);
                    const cfgs = upgradeConfigs(wb, e.wizardConfig);
                    const res = LX.engine.parseWorkbook(wb, cfgs, { sourceLabel: e.label, srcId: e.id });
                    records = res.records; anomalies = res.anomalies; truncated = res.truncated;
                    rows = res.records.length;
                    filledCount = Object.values(res.stats).reduce((s, st) => s + st.filled, 0);
                    e.wizardConfig = { lastSheet: (e.wizardConfig && e.wizardConfig.lastSheet) || wb.sheets[0].name, sheetConfigs: res.configs };
                    reparsed = true;
                } catch (err) { console.warn('[LX] re-parse failed', e.fileName, err); records = records || []; anomalies = anomalies || []; }
            }
            sources[e.id] = { kind: 'local', label: e.label, file, records: records || [], anomalies: anomalies || [], rows: rows || 0, filledCount: filledCount || 0, truncated, status: 'local', ts: e.ts, wizardConfig: e.wizardConfig };
            if (reparsed) persistLocal(e.id, Object.assign({ buffer: e.fileBuffer }, sources[e.id]));
        }
    }

    /** v1 wizard configs used {headerRowIdx,columnMap,fillDir}; keep them if still valid. */
    function upgradeConfigs(wb, wizardConfig) {
        const out = {};
        const saved = (wizardConfig && wizardConfig.sheetConfigs) || {};
        wb.sheets.forEach(sheet => {
            const old = saved[sheet.name];
            if (old && old.columnMap) {
                const cfg = Object.assign({ headerDepth: 1, layout: 'long', issues: [], confidence: 0.8 }, old);
                if (!cfg.layout) cfg.layout = 'long';
                cfg.included = old.included !== false && LX.engine.missingFields(cfg).length === 0;
                out[sheet.name] = cfg;
            }
        });
        return out;
    }

    function addLocal(id, entry) {
        sources[id] = entry;
        return persistLocal(id, entry);
    }

    async function removeLocal(id) {
        delete sources[id];
        try { await idb.del(C.IDB_STORES.sources, id); } catch (e) {}
    }

    LX.sources = { sources, syncRemote, restoreRemoteCache, restoreLocal, addLocal, removeLocal, PARSER_REV };
})(window.LX = window.LX || {});
