/* ==========================================================================
   LX Parser — data/state.js
   Single source of truth for persisted user state + a tiny event bus.

   Price keys (schema 2) are typo-insensitive:
       priceKey(item, unit) = matchKey(item) ␀ matchKey(canonicalUnit(unit))
   so "بانادول  اكسترا" / "بنادول اكسترا" + "علبه" / "علب" share one price.
   v1 keys (raw display strings) are migrated on first load.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, C = LX.config, K = C.KEYS, ls = LX.store.ls;

    /* ---------- event bus ---------- */
    const handlers = {};
    const bus = {
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return () => bus.off(evt, fn); },
        off(evt, fn) { handlers[evt] = (handlers[evt] || []).filter(f => f !== fn); },
        emit(evt, payload) { (handlers[evt] || []).slice().forEach(fn => { try { fn(payload); } catch (e) { console.error(`[LX] ${evt} handler failed`, e); } }); }
    };

    function priceKey(item, unit) {
        return T.matchKey(item) + '\u0000' + T.matchKey(LX.resolver.canonicalUnit(unit));
    }

    /* ---------- migrations ---------- */
    function migratePrices() {
        const raw = ls.get(K.prices, {});
        let labels = ls.get(K.priceLabels, {});
        if (ls.getRaw(K.priceSchema) === '2') return { prices: raw, labels };
        const prices = {};
        labels = {};
        Object.keys(raw).forEach(k => {
            let parts;
            if (k.includes('\u0000')) parts = k.split('\u0000');
            else if (k.charAt(0) === '[') { try { parts = JSON.parse(k); } catch (e) { parts = [k]; } }
            else parts = k.split('|');
            const i = parts[0] || '', u = parts[1] || '';
            const nk = priceKey(i, u);
            const v = parseFloat(raw[k]) || 0;
            if (!(nk in prices) || (prices[nk] === 0 && v > 0)) { prices[nk] = v; labels[nk] = { i: T.clean(i), u: LX.resolver.canonicalUnit(u) }; }
        });
        ls.set(K.prices, prices);
        ls.set(K.priceLabels, labels);
        ls.set(K.priceSchema, '2');
        return { prices, labels };
    }

    function loadPharmacies() {
        const stored = ls.get(K.pharmacies, null);
        const src = stored && typeof stored === 'object' ? stored : C.DEFAULT_PHARMACIES;
        const out = {};
        Object.keys(src).forEach(name => {
            const clean = T.clean(name);
            if (!clean) return;
            const reg = LX.resolver.canonicalRegion(src[name] || '');
            if (!(clean in out) || (!out[clean] && reg)) out[clean] = reg;
        });
        return out;
    }

    const { prices, labels } = migratePrices();
    const aliasDefaults = { p: {}, i: {}, u: {}, branch: {}, rejected: { p: {} } };
    const storedAliases = ls.get(K.aliases, {});

    const state = {
        prices,
        priceLabels: labels,
        pharmacies: loadPharmacies(),
        aliases: Object.assign({}, aliasDefaults, storedAliases, { rejected: Object.assign({ p: {} }, storedAliases.rejected || {}) }),
        dupMode: ls.getRaw(K.dupMode, 'none'),
        sourceStatus: ls.get(K.sourceStatus, {}),
        syncHistory: ls.get(K.syncHistory, []),
        savedViews: ls.get(K.savedViews, []),
        groupConfig: Object.assign({ t: true, reg: true, branch: true, p: true }, ls.get(K.groupConfig, {})),
        colVisible: Object.assign({ u: true, q: true, price: true }, ls.get(K.colVisible, {}))
    };
    ['p', 'i', 'u', 'branch'].forEach(k => { if (!state.aliases[k]) state.aliases[k] = {}; });

    const persist = {
        prices() { ls.set(K.prices, state.prices); ls.set(K.priceLabels, state.priceLabels); },
        pharmacies() { ls.set(K.pharmacies, state.pharmacies); },
        aliases() { ls.set(K.aliases, state.aliases); },
        dupMode() { ls.set(K.dupMode, state.dupMode); },
        sourceStatus() { ls.set(K.sourceStatus, state.sourceStatus); },
        syncHistory() { ls.set(K.syncHistory, state.syncHistory); },
        savedViews() { ls.set(K.savedViews, state.savedViews); },
        groupConfig() { ls.set(K.groupConfig, state.groupConfig); },
        colVisible() { ls.set(K.colVisible, state.colVisible); }
    };

    /* ---------- alias helpers ---------- */
    function setAlias(kind, fromRaw, toCanon) {
        const k = T.matchKey(fromRaw);
        if (!k) return;
        if (T.matchKey(toCanon) === k) delete state.aliases[kind][k];
        else state.aliases[kind][k] = T.clean(toCanon);
        if (kind === 'p' && state.aliases.rejected.p) delete state.aliases.rejected.p[k];
        persist.aliases();
    }
    function rejectMatch(kind, fromRaw) {
        const k = T.matchKey(fromRaw);
        if (!state.aliases.rejected[kind]) state.aliases.rejected[kind] = {};
        state.aliases.rejected[kind][k] = true;
        delete state.aliases[kind][k];
        persist.aliases();
    }
    function clearAlias(kind, fromRaw) {
        delete state.aliases[kind][T.matchKey(fromRaw)];
        persist.aliases();
    }

    LX.bus = bus;
    LX.state = { state, persist, priceKey, setAlias, rejectMatch, clearAlias };
})(window.LX = window.LX || {});
