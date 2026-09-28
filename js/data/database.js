/* ==========================================================================
   LX Parser — data/database.js
   Builds the in-memory database from all sources:
     raw records → resolver (pharmacy / item / unit / branch / region)
                 → duplicate policy → pricing → region routing → rows

   Also exposes derived datasets (variants, orphans) used by the views.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, S = LX.state, st = S.state;

    const DB = {
        rows: [],
        anomalies: [],
        anomaliesTruncated: false,
        duplicateGroups: [],
        activePharms: new Set(),
        decisions: [],
        facets: { t: new Set(), reg: new Set(), branch: new Set(), p: new Set(), u: new Set() },
        itemIndex: new Map(),     // item key → display name
        pharmCounts: new Map(),   // canonical pharmacy → record count
        rawPharmCounts: new Map(),// raw spelling → count
        itemCounts: new Map(),    // display item → count
        version: 0
    };

    let priceMedian = null;
    function getPriceMedian() {
        if (priceMedian === null) {
            const vals = Object.values(st.prices).filter(p => p > 0).sort((a, b) => a - b);
            priceMedian = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
        }
        return priceMedian;
    }
    function invalidatePriceMedian() { priceMedian = null; }

    function regionFor(pharm) {
        const mapped = st.pharmacies[pharm];
        return mapped ? LX.resolver.canonicalRegion(mapped) : 'Unmapped';
    }

    function searchBlob(r) {
        const norm = T.fold(`${r.i} ${r.u} ${r.p} ${r.region} ${r.branch} ${r.t}`);
        r._norm = norm;
        r._words = norm.split(' ');
    }

    function applyDuplicates(records) {
        const groups = new Map();
        records.forEach((r, idx) => {
            const key = T.makeKey(r.t, r.branch, r.p, r.ik, r.u);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(idx);
        });
        const dupGroups = [];
        groups.forEach(idxs => {
            if (idxs.length < 2) return;
            const rs = idxs.map(i => records[i]);
            dupGroups.push({ t: rs[0].t, branch: rs[0].branch, p: rs[0].p, i: rs[0].i, u: rs[0].u, n: rs.length, q: rs.reduce((s, r) => s + r.q, 0), rows: rs.map(r => `${r.sheet} #${r.row}`).slice(0, 6).join(', ') });
        });
        DB.duplicateGroups = dupGroups;
        if (st.dupMode === 'none') return records;
        const keep = new Set();
        groups.forEach(idxs => keep.add(st.dupMode === 'last' ? idxs[idxs.length - 1] : idxs[0]));
        return records.filter((r, idx) => keep.has(idx));
    }

    function build() {
        const all = [], anomalies = [];
        let truncated = false;
        Object.values(LX.sources.sources).forEach(s => {
            if (s.records) all.push(...s.records);
            if (s.anomalies) anomalies.push(...s.anomalies);
            if (s.truncated) truncated = true;
        });

        const resolver = LX.resolver.createResolver({
            knownPharmacies: Object.keys(st.pharmacies),
            aliases: st.aliases,
            rejected: st.aliases.rejected
        });

        DB.rawPharmCounts = new Map();
        // pass 1 — canonicalise labels
        const staged = all.map(r => {
            DB.rawPharmCounts.set(r.p, (DB.rawPharmCounts.get(r.p) || 0) + 1);
            const p = resolver.pharmacy(r.p);
            const ik = resolver.registerItem(r.i);
            return {
                ik, rawI: r.i, rawP: r.p,
                u: resolver.unit(r.u), p,
                branch: resolver.branch(r.branch),
                t: resolver.klass(r.t) || 'Unclassified',
                reg: r.reg ? resolver.region(r.reg) : '',
                q: r.q, price: r.price || 0, sheet: r.sheet, row: r.row, srcId: r.srcId
            };
        });
        resolver.finalizeItems();
        staged.forEach(r => { r.i = resolver.item(r.ik); });

        const records = applyDuplicates(staged);

        // pass 2 — pricing, routing, facets
        const facets = { t: new Set(), reg: new Set(), branch: new Set(), p: new Set(), u: new Set() };
        const active = new Set();
        const pharmCounts = new Map(), itemCounts = new Map();
        let pricesChanged = false, pharmsChanged = false;

        records.forEach(r => {
            const pk = S.priceKey(r.i, r.u);
            r.pk = pk;
            if (r.price > 0 && (!(pk in st.prices) || st.prices[pk] === 0)) { st.prices[pk] = r.price; pricesChanged = true; }
            else if (!(pk in st.prices)) { st.prices[pk] = 0; pricesChanged = true; }
            if (!st.priceLabels[pk]) { st.priceLabels[pk] = { i: r.i, u: r.u }; pricesChanged = true; }

            if (!(r.p in st.pharmacies)) { st.pharmacies[r.p] = r.reg || ''; pharmsChanged = true; }
            else if (!st.pharmacies[r.p] && r.reg) { st.pharmacies[r.p] = r.reg; pharmsChanged = true; }
        });

        const rows = records.map(r => {
            const price = st.prices[r.pk] || 0;
            const region = regionFor(r.p);
            const row = { i: r.i, u: r.u, q: r.q, t: r.t, p: r.p, branch: r.branch, price, region, tot: r.q * price, pk: r.pk, ik: r.ik, sheet: r.sheet, srcRow: r.row };
            searchBlob(row);
            facets.t.add(row.t); facets.reg.add(row.region); facets.branch.add(row.branch); facets.p.add(row.p); facets.u.add(row.u);
            active.add(row.p);
            pharmCounts.set(row.p, (pharmCounts.get(row.p) || 0) + 1);
            itemCounts.set(row.i, (itemCounts.get(row.i) || 0) + 1);
            return row;
        });

        if (pricesChanged) S.persist.prices();
        if (pharmsChanged) S.persist.pharmacies();
        invalidatePriceMedian();

        DB.rows = rows;
        DB.anomalies = anomalies;
        DB.anomaliesTruncated = truncated;
        DB.activePharms = active;
        DB.facets = facets;
        DB.decisions = resolver.decisions();
        DB.pharmCounts = pharmCounts;
        DB.itemCounts = itemCounts;
        DB.version++;
        LX.bus.emit('db:built', DB);
        return DB;
    }

    /* ---------- in-place updates (no rebuild needed) ---------- */

    function setPrice(pk, value) {
        const prev = st.prices[pk];
        st.prices[pk] = Math.max(0, parseFloat(value) || 0);
        S.persist.prices();
        invalidatePriceMedian();
        DB.rows.forEach(r => { if (r.pk === pk) { r.price = st.prices[pk]; r.tot = r.q * r.price; } });
        return prev;
    }

    function setRegion(pharm, value) {
        const prev = st.pharmacies[pharm];
        st.pharmacies[pharm] = LX.resolver.canonicalRegion(value);
        S.persist.pharmacies();
        DB.rows.forEach(r => { if (r.p === pharm) { r.region = regionFor(pharm); searchBlob(r); } });
        DB.facets.reg = new Set(DB.rows.map(r => r.region));
        return prev || '';
    }

    function reapplyAll() {
        invalidatePriceMedian();
        DB.rows.forEach(r => {
            r.price = st.prices[r.pk] || 0;
            r.tot = r.q * r.price;
            r.region = regionFor(r.p);
            searchBlob(r);
        });
        DB.facets.reg = new Set(DB.rows.map(r => r.region));
    }

    /* ---------- derived: name variants ---------- */

    function variants() {
        const merged = DB.decisions
            .filter(d => d.kind === 'p' || d.kind === 'i' || d.kind === 'u')
            .map(d => ({ kind: d.kind, raw: d.raw, canon: d.canon, method: d.method, score: d.score, count: d.count, status: 'merged' }));

        // suggestions — pharmacies: every active name vs every other known/active name
        const pharmNames = new Map();
        Object.keys(st.pharmacies).forEach(n => pharmNames.set(n, 0));
        DB.pharmCounts.forEach((n, name) => pharmNames.set(name, n));
        const official = new Set(Object.keys(LX.config.DEFAULT_PHARMACIES));
        const pSug = LX.resolver.findSimilarPairs(Array.from(pharmNames, ([name, count]) => ({ name, count })), undefined, 200, { kind: 'p', protected: official })
            .filter(pr => !(st.aliases.rejected.p || {})[T.matchKey(pr.b) + '>' + T.matchKey(pr.a)])
            .map(pr => ({ kind: 'p', raw: pr.b, canon: pr.a, score: pr.score, count: pr.bCount, targetCount: pr.aCount, status: 'suggested' }));

        const iSug = LX.resolver.findSimilarPairs(Array.from(DB.itemCounts, ([name, count]) => ({ name, count })), 0.84, 200, { kind: 'i' })
            .filter(pr => !(st.aliases.rejected.i || {})[T.matchKey(pr.b) + '>' + T.matchKey(pr.a)])
            .map(pr => ({ kind: 'i', raw: pr.b, canon: pr.a, score: pr.score, count: pr.bCount, targetCount: pr.aCount, status: 'suggested' }));

        return merged.concat(pSug, iSug);
    }

    function dismissSuggestion(kind, raw, canon) {
        const rej = st.aliases.rejected;
        if (!rej[kind]) rej[kind] = {};
        rej[kind][T.matchKey(raw) + '>' + T.matchKey(canon)] = true;
        S.persist.aliases();
    }

    /* ---------- derived: orphans ---------- */

    function orphans() {
        const activeKeys = new Set(DB.rows.map(r => r.pk));
        const priceOrphans = Object.keys(st.prices).filter(k => !activeKeys.has(k));
        const pharmOrphans = Object.keys(st.pharmacies).filter(p => !DB.activePharms.has(p) && !(p in LX.config.DEFAULT_PHARMACIES));
        return { priceOrphans, pharmOrphans };
    }

    function pruneOrphans() {
        const { priceOrphans, pharmOrphans } = orphans();
        priceOrphans.forEach(k => { delete st.prices[k]; delete st.priceLabels[k]; });
        pharmOrphans.forEach(p => delete st.pharmacies[p]);
        S.persist.prices(); S.persist.pharmacies();
        invalidatePriceMedian();
        return priceOrphans.length + pharmOrphans.length;
    }

    LX.db = { DB, build, setPrice, setRegion, reapplyAll, getPriceMedian, invalidatePriceMedian, variants, dismissSuggestion, orphans, pruneOrphans, regionFor };
})(window.LX = window.LX || {});
