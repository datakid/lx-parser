/* ==========================================================================
   LX Parser — parser/resolver.js
   Canonicalises free-typed names so that everybody's personal spelling
   lands on the same entity.

     Pharmacies  exact matchKey → user alias → fuzzy vs. known registry
                 (auto-accept only when clearly the best candidate)
     Regions     alias table ("1", "الاولي", "first" … → الاولى)
     Units       dictionary of unit families (علبه/علب/box → علبة …)
     Items       matchKey grouping (spacing / hamza / ta-marbuta / digits)
                 + user aliases; fuzzy pairs are only *suggested*

   Every non-trivial decision is recorded so the UI can show and undo it.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text;
    const C = LX.config;

    /* ---------- units ---------- */
    const UNIT_FAMILIES = [
        ['علبة', ['علبه', 'علب', 'علبا', 'عبوه', 'عبوة', 'box', 'boxes', 'bx', 'pack', 'packs', 'pk', 'pkt', 'باكو', 'باكيت', 'بكت']],
        ['شريط', ['شرايط', 'شرائط', 'شريطه', 'strip', 'strips', 'str', 'blister']],
        ['أمبول', ['امبول', 'امبوله', 'امبولات', 'امبولة', 'امبوﻻت', 'amp', 'amps', 'ampoule', 'ampoules', 'ampule', 'amb']],
        ['فيال', ['فيالات', 'فايل', 'vial', 'vials', 'vl']],
        ['قرص', ['اقراص', 'حبه', 'حبة', 'حبوب', 'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'كبسوله', 'كبسولة', 'كبسولات']],
        ['زجاجة', ['زجاجه', 'ازازه', 'ازازة', 'قزازه', 'قزازة', 'bottle', 'bottles', 'btl', 'bot']],
        ['أنبوبة', ['انبوبه', 'انبوبة', 'انبوب', 'تيوب', 'tube', 'tubes']],
        ['كيس', ['اكياس', 'ساشيه', 'sachet', 'sachets', 'bag', 'bags']],
        ['قطعة', ['قطعه', 'قطع', 'عدد', 'pcs', 'pc', 'piece', 'pieces', 'unit', 'units', 'each', 'ea', 'no']],
        ['كرتونة', ['كرتونه', 'كرتون', 'كراتين', 'carton', 'cartons', 'ctn']],
        ['لتر', ['litre', 'liter', 'l', 'ltr', 'لت']],
        ['جرام', ['جم', 'gm', 'g', 'gram', 'grams', 'جرامات']],
        ['كيلو', ['كجم', 'kg', 'kilo', 'كيلوجرام']],
        ['متر', ['m', 'meter', 'metre', 'م.ط']],
        ['رول', ['roll', 'rolls', 'لفه', 'لفة']],
        ['جالون', ['gallon', 'جركن', 'جركل']],
        ['سرنجة', ['سرنجه', 'syringe', 'syringes']]
    ];
    const unitIndex = new Map();
    UNIT_FAMILIES.forEach(([canon, variants]) => {
        unitIndex.set(T.matchKey(canon), canon);
        variants.forEach(v => unitIndex.set(T.matchKey(v), canon));
    });

    function canonicalUnit(raw) {
        const s = T.clean(raw);
        if (!s) return '';
        const k = T.matchKey(s);
        if (unitIndex.has(k)) return unitIndex.get(k);
        // "علبة 20 قرص" / "box of 10" — keep the text but normalise the first word
        const first = T.matchKey(s.split(' ')[0]);
        if (unitIndex.has(first) && /\d/.test(s)) return unitIndex.get(first) + s.slice(s.indexOf(' '));
        // fuzzy on short unit words
        if (k.length >= 3 && k.length <= 8) {
            let best = '', bestScore = 0;
            unitIndex.forEach((canon, key) => {
                if (key.length < 3) return;
                const sc = T.similarity(k, key);
                if (sc > bestScore) { bestScore = sc; best = canon; }
            });
            if (bestScore >= 0.84) return best;
        }
        return s;
    }

    /* ---------- regions ---------- */
    const regionIndex = new Map();
    C.REGIONS.forEach(r => {
        regionIndex.set(T.matchKey(r.name), r.name);
        r.aliases.forEach(a => regionIndex.set(T.matchKey(a), r.name));
    });

    function canonicalRegion(raw) {
        const s = T.clean(raw);
        if (!s) return '';
        const k = T.matchKey(s);
        if (regionIndex.has(k)) return regionIndex.get(k);
        const stripped = T.matchKey(T.stripArticle(T.fold(s)).replace(/^منطقه\s*/, ''));
        if (regionIndex.has(stripped)) return regionIndex.get(stripped);
        let best = '', bestScore = 0;
        regionIndex.forEach((canon, key) => {
            if (key.length < 3) return;
            const sc = T.similarity(k, key);
            if (sc > bestScore) { bestScore = sc; best = canon; }
        });
        return bestScore >= 0.85 ? best : s;
    }

    /* ---------- resolver instance ---------- */

    /**
     * @param {object} opts
     *   knownPharmacies  string[]  canonical pharmacy names (registry)
     *   aliases          { p:{key:canon}, i:{key:canon}, u:{key:canon}, branch:{key:canon} }
     *   rejected         { p:{key:true} }  — auto-matches the user undid
     */
    function createResolver(opts) {
        const aliases = opts.aliases || {};
        const rejected = opts.rejected || {};
        const decisions = new Map();          // key → { kind, raw, canon, method, score, count }
        const pharmByKey = new Map();
        const pharmList = [];

        function addKnownPharmacy(name) {
            const k = T.matchKey(name);
            if (!k || pharmByKey.has(k)) return;
            pharmByKey.set(k, name);
            pharmList.push({ name, key: k, stripped: T.matchKey(T.stripArticle(T.fold(name))) });
        }
        (opts.knownPharmacies || []).forEach(addKnownPharmacy);

        function note(kind, raw, canon, method, score) {
            if (method === 'exact') return;
            const id = kind + '\u0000' + T.matchKey(raw);
            const d = decisions.get(id);
            if (d) { d.count++; return; }
            decisions.set(id, { kind, raw: T.clean(raw), canon, method, score: score || 1, count: 1, key: T.matchKey(raw) });
        }

        const pharmCache = new Map();
        function pharmacy(raw) {
            const s = T.clean(raw);
            if (!s) return '';
            if (pharmCache.has(s)) { const c = pharmCache.get(s); if (c.method !== 'exact') note('p', s, c.canon, c.method, c.score); return c.canon; }
            const k = T.matchKey(s);
            let out;
            if (aliases.p && aliases.p[k]) out = { canon: aliases.p[k], method: 'alias' };
            else if (pharmByKey.has(k)) out = { canon: pharmByKey.get(k), method: pharmByKey.get(k) === s ? 'exact' : 'normalized' };
            else if (!(rejected.p && rejected.p[k]) && k.length >= C.MATCH.MIN_LEN) {
                let best = null, second = 0;
                for (const cand of pharmList) {
                    if (differsOnlyByQualifier(s, cand.name) || isAffixVariant(s, cand.name)) continue;
                    const sc = T.similarity(s, cand.name);
                    if (!best || sc > best.score) { second = best ? best.score : 0; best = { name: cand.name, score: sc }; }
                    else if (sc > second) second = sc;
                }
                if (best && best.score >= C.MATCH.AUTO && best.score - second >= C.MATCH.AUTO_MARGIN) out = { canon: best.name, method: 'fuzzy', score: best.score };
            }
            if (!out) { out = { canon: s, method: 'exact' }; addKnownPharmacy(s); }
            pharmCache.set(s, out);
            note('p', s, out.canon, out.method, out.score);
            return out.canon;
        }

        /* items: group by matchKey; canonical = most frequent display form */
        const itemForms = new Map(); // key → Map(form → count)
        function registerItem(raw) {
            const s = T.clean(raw);
            if (!s) return '';
            const k = T.matchKey(s);
            const aliased = aliases.i && aliases.i[k];
            const key = aliased ? T.matchKey(aliased) : k;
            if (!itemForms.has(key)) itemForms.set(key, new Map());
            const m = itemForms.get(key);
            const form = aliased || s;
            m.set(form, (m.get(form) || 0) + 1);
            return key;
        }
        let itemCanon = null;
        function finalizeItems() {
            itemCanon = new Map();
            itemForms.forEach((forms, key) => {
                let best = '', bestN = -1;
                forms.forEach((n, f) => { if (n > bestN || (n === bestN && f.length > best.length)) { best = f; bestN = n; } });
                itemCanon.set(key, best);
                if (forms.size > 1) forms.forEach((n, f) => { if (f !== best) decisions.set('i\u0000' + T.matchKey(f) + '\u0000' + f, { kind: 'i', raw: f, canon: best, method: 'normalized', score: 1, count: n, key: T.matchKey(f) }); });
            });
        }
        function item(key) { return itemCanon ? (itemCanon.get(key) || key) : key; }

        function unit(raw) {
            const s = T.clean(raw);
            if (!s) return '';
            const k = T.matchKey(s);
            if (aliases.u && aliases.u[k]) { note('u', s, aliases.u[k], 'alias'); return aliases.u[k]; }
            const c = canonicalUnit(s);
            if (c !== s) note('u', s, c, 'normalized');
            return c;
        }

        const branchForms = new Map();
        function branch(raw) {
            const s = T.clean(raw);
            if (!s) return '';
            const k = T.matchKey(s);
            if (aliases.branch && aliases.branch[k]) return aliases.branch[k];
            if (!branchForms.has(k)) branchForms.set(k, s);
            const c = branchForms.get(k);
            if (c !== s) note('branch', s, c, 'normalized');
            return c;
        }

        function klass(raw) {
            return T.clean(raw);
        }

        return {
            pharmacy, registerItem, finalizeItems, item, unit, branch, klass,
            region: canonicalRegion,
            decisions: () => Array.from(decisions.values()),
            knownPharmacies: () => pharmList.map(p => p.name)
        };
    }

    /* ---------- "different entity" guards ---------- */

    /* Suffixes that denote a DIFFERENT site, not a typo (ق.ع = separate unit, مسائي = evening shift …). */
    const SITE_QUALIFIERS = ['قع', 'مسائي', 'مسايي', 'صباحي', 'الشامله', 'شامله', 'طوارئ', 'طوارى', 'اطفال', 'تامين', 'التامين'].map(s => T.matchKey(s));

    function stripQualifiers(key) {
        let k = key, changed = true;
        while (changed) {
            changed = false;
            for (const q of SITE_QUALIFIERS) {
                if (k.length > q.length + 2 && k.endsWith(q)) { k = k.slice(0, -q.length); changed = true; }
            }
        }
        return k;
    }

    /** Pharmacy pair that only differs by a site qualifier ("كفر الدوار" / "كفر الدوار ق.ع"). */
    function differsOnlyByQualifier(a, b) {
        const ka = T.matchKey(a), kb = T.matchKey(b);
        return ka !== kb && stripQualifiers(ka) === stripQualifiers(kb);
    }

    /**
     * One name is the other plus extra letters at the start/end of a word:
     * "Omeprazole" ⊂ "Esomeprazole", "Panadol" ⊂ "Panadol Extra" → different products.
     * (Typos substitute/drop letters inside a word; they don't prepend a syllable.)
     */
    function isAffixVariant(a, b) {
        const ka = T.matchKey(a), kb = T.matchKey(b);
        const [s, l] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
        if (l.length - s.length < 2) return false;
        return l.startsWith(s) || l.endsWith(s);
    }

    /* Dosage forms — two items with different forms are different products. */
    const FORM_FAMILIES = {
        tab: ['tab', 'tabs', 'tablet', 'tablets', 'قرص', 'اقراص', 'اقرص'],
        cap: ['cap', 'caps', 'capsule', 'capsules', 'كبسول', 'كبسوله', 'كبسولات'],
        susp: ['susp', 'suspension', 'معلق'],
        syr: ['syr', 'syrup', 'شراب'],
        amp: ['amp', 'amps', 'ampoule', 'ampule', 'امبول', 'امبولات', 'inj', 'injection', 'حقن', 'حقنه'],
        vial: ['vial', 'vials', 'فيال'],
        cream: ['cream', 'crm', 'كريم'],
        oint: ['oint', 'ointment', 'مرهم'],
        gel: ['gel', 'جل', 'جيل'],
        drop: ['drop', 'drops', 'gtt', 'نقط', 'قطره', 'قطرة'],
        spray: ['spray', 'بخاخ', 'سبراي'],
        supp: ['supp', 'suppository', 'suppositories', 'لبوس', 'تحاميل'],
        sach: ['sach', 'sachet', 'sachets', 'ساشيه', 'اكياس'],
        inh: ['inhaler', 'inh', 'استنشاق']
    };
    const formIndex = new Map();
    Object.keys(FORM_FAMILIES).forEach(f => FORM_FAMILIES[f].forEach(w => formIndex.set(T.matchKey(w), f)));
    function formsOf(name) {
        const set = new Set();
        T.fold(name).split(/[\s\-_/().,]+/).forEach(w => { const f = formIndex.get(T.matchKey(w)); if (f) set.add(f); });
        return set;
    }
    function differentForms(a, b) {
        const fa = formsOf(a), fb = formsOf(b);
        if (!fa.size || !fb.size) return false;
        for (const f of fa) if (fb.has(f)) return false;
        return true;
    }

    /** Typos almost never change the first two letters of a drug name (Empagliflozin ≠ Dapagliflozin). */
    function differentStem(a, b) {
        const wa = T.fold(a).split(' ')[0] || '', wb = T.fold(b).split(' ')[0] || '';
        if (wa.length < 4 || wb.length < 4) return false;
        return wa.slice(0, 2) !== wb.slice(0, 2);
    }

    /* ---------- fuzzy suggestion finder (for the Name Variants view) ---------- */

    /**
     * names: [{ name, count }]  → [{ a, b, score }]  (a is the more frequent)
     * Uses a bigram inverted index to avoid O(n²).
     */
    function findSimilarPairs(names, threshold, limit, opts) {
        const th = threshold || C.MATCH.SUGGEST;
        const kind = (opts && opts.kind) || 'i';
        const protectedSet = (opts && opts.protected) || null;   // names that are all official & distinct
        const items = names.map(n => ({ name: n.name, count: n.count || 1, key: T.matchKey(n.name) })).filter(n => n.key.length >= C.MATCH.MIN_LEN).slice(0, 4000);
        const index = new Map();
        items.forEach((it, idx) => {
            const seen = new Set();
            for (let i = 0; i < it.key.length - 1; i++) {
                const g = it.key.substr(i, 2);
                if (seen.has(g)) continue;
                seen.add(g);
                if (!index.has(g)) index.set(g, []);
                index.get(g).push(idx);
            }
            it.grams = seen.size;
        });
        const pairs = [];
        items.forEach((it, idx) => {
            const shared = new Map();
            for (let i = 0; i < it.key.length - 1; i++) {
                const lst = index.get(it.key.substr(i, 2));
                if (!lst || lst.length > 600) continue;
                lst.forEach(j => { if (j > idx) shared.set(j, (shared.get(j) || 0) + 1); });
            }
            shared.forEach((n, j) => {
                const other = items[j];
                if (n / Math.max(it.grams, other.grams) < 0.45) return;
                if (kind === 'p' && (differsOnlyByQualifier(it.name, other.name) || (protectedSet && protectedSet.has(it.name) && protectedSet.has(other.name)))) return;
                if (isAffixVariant(it.name, other.name)) return;
                if (kind === 'i' && (differentForms(it.name, other.name) || differentStem(it.name, other.name))) return;
                const sc = T.similarity(it.name, other.name);
                if (sc >= th && sc < 1) {
                    const [a, b] = it.count >= other.count ? [it, other] : [other, it];
                    pairs.push({ a: a.name, b: b.name, aCount: a.count, bCount: b.count, score: sc });
                }
            });
        });
        pairs.sort((x, y) => y.score - x.score);
        return pairs.slice(0, limit || 300);
    }

    LX.resolver = { createResolver, canonicalUnit, canonicalRegion, findSimilarPairs, differsOnlyByQualifier, isAffixVariant };
})(window.LX = window.LX || {});
