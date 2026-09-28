/* ==========================================================================
   LX Parser — parser/headers.js
   Header vocabulary, fuzzy header → field classification, header-row
   detection and multi-row header merging.

   Fields
     i       Item / product name
     u       Unit
     p       Pharmacy / clinic (long layout: one column holds the name)
     branch  Branch
     q       Quantity (long layout)
     price   Unit price
     t       Class / category
     reg     Region
     wq      "Quantity for pharmacy <header>"  (wide layout)
     ignore  Serial numbers, codes, notes, totals …
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text;

    const FIELD_LABELS = {
        ignore: 'Ignore', i: 'Item', u: 'Unit', p: 'Pharmacy', branch: 'Branch',
        q: 'Quantity', price: 'Price', t: 'Class', reg: 'Region', wq: 'Pharmacy qty column'
    };

    /* Vocabulary — raw spellings; folded + keyed at load. Add freely. */
    const VOCAB = {
        i: ['الصنف', 'صنف', 'الاصناف', 'اصناف', 'اسم الصنف', 'الصنف/البيان', 'البيان', 'بيان', 'اسم الدواء', 'الدواء', 'دواء', 'الادوية', 'المستلزم', 'المستلزمات', 'اسم المستلزم', 'المنتج', 'اسم المنتج', 'الماده', 'item', 'items', 'item name', 'product', 'product name', 'drug', 'medicine', 'description', 'name', 'material'],
        u: ['الوحده', 'وحده', 'الوحدات', 'وحدة القياس', 'وحده الصرف', 'العبوه', 'unit', 'units', 'uom', 'pack', 'package', 'form'],
        p: ['الصيدليه', 'صيدليه', 'الصيدليات', 'اسم الصيدليه', 'العياده', 'عياده', 'العيادات', 'الجهه', 'جهه', 'الجهات', 'اسم الجهه', 'الموقع', 'المكان', 'الوحده الصحيه', 'المستشفى', 'المركز', 'pharmacy', 'pharmacies', 'clinic', 'site', 'location', 'facility', 'endpoint', 'endpoint name'],
        branch: ['الفرع', 'فرع', 'الفروع', 'القطاع', 'الادارة', 'الاداره', 'المديرية', 'branch', 'sector', 'district'],
        q: ['الكميه', 'كميه', 'الكميات', 'العدد', 'عدد', 'الرصيد', 'رصيد', 'المطلوب', 'الكميه المطلوبه', 'المنصرف', 'الوارد', 'الاستهلاك', 'الاحتياج', 'qty', 'quantity', 'quantities', 'amount', 'count', 'balance', 'stock', 'required', 'needed', 'total qty'],
        price: ['السعر', 'سعر', 'سعر الوحده', 'الثمن', 'ثمن', 'التكلفه', 'سعر البيع', 'سعر الشراء', 'price', 'unit price', 'unit price (egp)', 'cost', 'rate', 'egp'],
        t: ['الفئه', 'فئه', 'النوع', 'نوع', 'التصنيف', 'تصنيف', 'الفئات', 'class', 'category', 'type', 'group'],
        reg: ['المنطقه', 'منطقه', 'المناطق', 'region', 'region route', 'area', 'zone', 'route'],
        ignore: ['م', 'مسلسل', 'رقم', 'الرقم', 'ر.م', 'رم', 'ن', '#', 'no', 'no.', 'sn', 's/n', 'serial', 'id', 'code', 'الكود', 'كود', 'باركود', 'barcode', 'ملاحظات', 'ملاحظه', 'notes', 'note', 'remarks', 'comment', 'تاريخ', 'التاريخ', 'date', 'الصلاحيه', 'expiry', 'التوقيع', 'signature']
    };

    const TOTAL_WORDS = ['اجمالي', 'الاجمالي', 'اجمالى', 'الاجمالى', 'المجموع', 'مجموع', 'الجمله', 'جمله', 'الكل', 'total', 'totals', 'sum', 'grand total', 'grandtotal', 'subtotal', 'sub total'];

    const vocabIndex = [];
    Object.keys(VOCAB).forEach(field => {
        VOCAB[field].forEach(w => {
            const key = T.matchKey(w);
            if (key) vocabIndex.push({ field, key, stripped: T.matchKey(T.stripArticle(T.fold(w))) });
        });
    });
    const totalKeys = new Set(TOTAL_WORDS.map(w => T.matchKey(w)));

    function isTotalLabel(raw) {
        const k = T.matchKey(raw);
        if (!k) return false;
        if (totalKeys.has(k)) return true;
        // "اجمالي الكميه", "Total (EGP)" …
        for (const t of totalKeys) if (t.length >= 4 && k.startsWith(t)) return true;
        return false;
    }

    /**
     * Score how strongly a header cell names each field.
     * Returns [{field, score}] sorted desc (score 0..1).
     */
    function classifyHeader(raw) {
        const cleaned = T.clean(raw);
        if (!cleaned) return [];
        if (isTotalLabel(cleaned)) return [{ field: 'total', score: 1 }];
        const key = T.matchKey(cleaned);
        const stripped = T.matchKey(T.stripArticle(T.fold(cleaned)));
        if (!key) return [];
        const best = {};
        for (const v of vocabIndex) {
            let s = 0;
            if (key === v.key || stripped === v.stripped) s = 1;
            else if (v.key.length >= 3 && key.length <= v.key.length + 14 && (key.includes(v.key) || stripped.includes(v.stripped))) {
                // header contains the word ("اسم الصنف التجاري") — shorter extra text scores higher
                s = 0.9 - Math.min(0.25, (key.length - v.key.length) * 0.015);
            } else if (key.length >= 3 && v.key.length >= 3 && Math.abs(key.length - v.key.length) <= 3) {
                const sim = T.similarity(key, v.key);
                if (sim >= 0.78) s = sim * 0.92;
            }
            // one-letter vocab ("م", "ن", "#") must be exact
            if (v.key.length < 2 && key !== v.key) s = 0;
            if (s > (best[v.field] || 0)) best[v.field] = s;
        }
        return Object.keys(best).map(field => ({ field, score: best[field] })).sort((a, b) => b.score - a.score);
    }

    const isNumericCell = v => {
        if (typeof v === 'number') return true;
        const r = LX.numbers.parseNumber(v);
        return r.status === 'ok';
    };
    const isBlank = v => T.clean(v) === '';

    /**
     * Pick the header row among the first N rows.
     * Heuristic score = recognised field headers (weighted, item counts most)
     *                 + text cells − numeric cells, with a bonus when the rows
     *                 below look like data.
     */
    function detectHeaderRow(grid, maxScan) {
        const limit = Math.min(grid.length, maxScan || LX.config.HEADER_SCAN_ROWS);
        let bestIdx = 0, bestScore = -Infinity;
        for (let r = 0; r < limit; r++) {
            const row = grid[r] || [];
            const filled = row.filter(c => !isBlank(c));
            if (filled.length < 1) continue;
            let score = 0, hasItem = false;
            const seen = new Set();
            row.forEach(cell => {
                if (isBlank(cell)) return;
                const cls = classifyHeader(cell)[0];
                if (cls && cls.score >= 0.75 && cls.field !== 'total') {
                    if (!seen.has(cls.field)) score += (cls.field === 'i' ? 4 : cls.field === 'ignore' ? 0.5 : 2) * cls.score;
                    seen.add(cls.field);
                    if (cls.field === 'i') hasItem = true;
                }
                if (isNumericCell(cell)) score -= 0.8; else score += 0.25;
            });
            if (filled.length === 1) score -= 2; // a title row, most likely
            // does data follow?
            const next = grid.slice(r + 1, r + 6);
            const dataLike = next.filter(nr => nr && nr.some(c => isNumericCell(c)) && nr.some(c => !isBlank(c) && !isNumericCell(c))).length;
            score += dataLike * 0.6;
            if (hasItem) score += 2;
            if (score > bestScore) { bestScore = score; bestIdx = r; }
        }
        return bestIdx;
    }

    /**
     * Should the row after the header be merged into it (2-row header)?
     * Only when it has no numbers at all, ≥2 filled cells and fills gaps that
     * the first header row leaves (typical of merged "الكميه" group cells).
     */
    function detectHeaderDepth(grid, headerIdx) {
        const h = grid[headerIdx] || [], n = grid[headerIdx + 1];
        if (!n) return 1;
        const filled = n.filter(c => !isBlank(c));
        if (filled.length < 2) return 1;
        if (n.some(c => !isBlank(c) && isNumericCell(c))) return 1;
        // A sub-header cell sits under: a blank top cell, a merged/repeated group label
        // (merges are expanded by the reader, so "الكميات" repeats across its span),
        // or a top cell that is itself a generic group word (الكميات / quantity / total).
        const topKey = j => T.matchKey(h[j]);
        let underGroup = 0;
        n.forEach((c, j) => {
            if (isBlank(c)) return;
            if (isBlank(h[j])) { underGroup++; return; }
            const k = topKey(j);
            if (k && (k === topKey(j - 1) || k === topKey(j + 1))) { underGroup++; return; }
            const cls = classifyHeader(h[j])[0];
            if (cls && (cls.field === 'q' || cls.field === 'total') && T.matchKey(c) !== k) underGroup++;
        });
        const recognised = filled.filter(c => { const k = classifyHeader(c)[0]; return k && k.score >= 0.8; }).length;
        // the row after the sub-header should look like data
        const after = grid[headerIdx + 2];
        const dataFollows = !after || after.some(c => !isBlank(c) && isNumericCell(c));
        return ((underGroup >= 2 || (underGroup >= 1 && recognised >= 1) || recognised >= 2) && dataFollows) ? 2 : 1;
    }

    /**
     * Build effective header labels.
     * labels[j] → most specific text for the column (bottom row wins in a
     *             2-row header, e.g. the pharmacy name under "الكميات")
     * groups[j] → the (carried-right) group label above it, if any
     */
    function buildHeaderLabels(grid, headerIdx, depth) {
        const top = grid[headerIdx] || [];
        const bottom = depth === 2 ? (grid[headerIdx + 1] || []) : [];
        const width = Math.max(top.length, bottom.length, ...grid.slice(headerIdx, headerIdx + 30).map(r => (r || []).length), 0);
        const labels = [], groups = [];
        let carry = '';
        for (let j = 0; j < width; j++) {
            const a = T.clean(top[j]);
            const b = depth === 2 ? T.clean(bottom[j]) : '';
            if (a) carry = a;
            else if (!b) carry = '';
            labels.push(b || a);
            groups.push(b ? (a || carry) : '');
        }
        return { labels, groups };
    }

    LX.headers = { FIELD_LABELS, classifyHeader, isTotalLabel, detectHeaderRow, detectHeaderDepth, buildHeaderLabels, isNumericCell, isBlank };
})(window.LX = window.LX || {});
