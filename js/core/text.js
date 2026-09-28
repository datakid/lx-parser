/* ==========================================================================
   LX Parser — core/text.js
   Text hygiene + normalization + similarity. Pure functions only.

   Three levels of "sameness":
     clean(s)    → display-safe: invisible chars, NBSP, tatweel, bidi marks,
                   repeated spaces removed. Case & letters preserved.
     fold(s)     → search/compare form: clean + lowercase + Arabic letter
                   folding (أإآٱ→ا, ة→ه, ى→ي, ؤ→و, ئ→ي, ی→ي, ک→ك, …),
                   diacritics removed, digits unified to ASCII.
     matchKey(s) → identity form: fold + punctuation & spaces removed, so
                   "ق.ع", "ق ع" and "ق-ع" collapse to the same key.
   ========================================================================== */
(function (LX) {
    'use strict';

    const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD\u061C]/g;
    const SPACE_RE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;
    const TATWEEL_RE = /\u0640/g;
    const DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
    const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
    const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

    const LETTER_FOLD = {
        'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ٲ': 'ا', 'ٳ': 'ا',
        'ة': 'ه', 'ۃ': 'ه',
        'ى': 'ي', 'ی': 'ي', 'ې': 'ي', 'ۍ': 'ي',
        'ؤ': 'و', 'ئ': 'ي', 'ء': '',
        'ک': 'ك', 'گ': 'ك',
        'ڤ': 'ف', 'پ': 'ب', 'چ': 'ج', 'ژ': 'ز',
        '،': ',', '؛': ';', '؟': '?', '٪': '%', '٫': '.', '٬': ','
    };
    const LETTER_FOLD_RE = new RegExp('[' + Object.keys(LETTER_FOLD).join('') + ']', 'g');

    function toStr(v) {
        if (v == null) return '';
        if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
        return String(v);
    }

    function normalizeDigits(s) {
        return toStr(s)
            .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
            .replace(/[۰-۹]/g, d => String(PERSIAN_DIGITS.indexOf(d)));
    }

    /** Display-safe cleanup — never changes meaning. */
    function clean(v) {
        return toStr(v)
            .replace(INVISIBLE_RE, '')
            .replace(TATWEEL_RE, '')
            .replace(SPACE_RE, ' ')
            .trim();
    }

    /** Aggressive fold for comparing and searching. */
    function fold(v) {
        const s = clean(v);
        if (!s) return '';
        return normalizeDigits(s)
            .toLowerCase()
            .replace(DIACRITICS_RE, '')
            .replace(LETTER_FOLD_RE, ch => LETTER_FOLD[ch])
            .replace(SPACE_RE, ' ')
            .trim();
    }

    /** Identity key: punctuation- and whitespace-insensitive. */
    function matchKey(v) {
        return fold(v).replace(/[\s\-_.,;:'"`~!@#$%^&*()[\]{}<>\\/|+=?]+/g, '');
    }

    /** Remove the Arabic definite article from each word (for looser matching). */
    function stripArticle(folded) {
        return folded.split(' ').map(w => (w.length > 3 && w.startsWith('ال')) ? w.slice(2) : w).join(' ');
    }

    /* ---------- similarity ---------- */

    function lev(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        if (a.length > b.length) { const t = a; a = b; b = t; }
        let prev = new Array(a.length + 1);
        for (let i = 0; i <= a.length; i++) prev[i] = i;
        for (let j = 1; j <= b.length; j++) {
            let diag = prev[0];
            prev[0] = j;
            for (let i = 1; i <= a.length; i++) {
                const tmp = prev[i];
                prev[i] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[i], prev[i - 1]);
                diag = tmp;
            }
        }
        return prev[a.length];
    }

    function bigrams(s) {
        const out = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.substr(i, 2);
            out.set(g, (out.get(g) || 0) + 1);
        }
        return out;
    }

    function dice(a, b) {
        if (a === b) return 1;
        if (a.length < 2 || b.length < 2) return 0;
        const A = bigrams(a), B = bigrams(b);
        let inter = 0;
        A.forEach((n, g) => { if (B.has(g)) inter += Math.min(n, B.get(g)); });
        return (2 * inter) / (a.length - 1 + b.length - 1);
    }

    /** Numbers inside a label ("دمنهور الشاملة 1", "Concor 5") must agree exactly. */
    function numberSignature(s) {
        const m = normalizeDigits(s).match(/\d+(?:\.\d+)?/g);
        return m ? m.join('|') : '';
    }

    /**
     * Combined 0..1 similarity between two raw strings.
     * Blends edit-distance ratio and bigram overlap on the matchKey,
     * also tries article-stripped forms. Mismatched numbers → 0.
     */
    function similarity(a, b) {
        const ka = matchKey(a), kb = matchKey(b);
        if (!ka || !kb) return 0;
        if (ka === kb) return 1;
        if (numberSignature(ka) !== numberSignature(kb)) return 0;
        const score = (x, y) => {
            const maxLen = Math.max(x.length, y.length);
            const levRatio = 1 - lev(x, y) / maxLen;
            return 0.55 * levRatio + 0.45 * dice(x, y);
        };
        const direct = score(ka, kb);
        const sa = matchKey(stripArticle(fold(a))), sb = matchKey(stripArticle(fold(b)));
        const stripped = (sa && sb) ? (sa === sb ? 0.97 : score(sa, sb)) : 0;
        return Math.max(direct, stripped);
    }

    /* ---------- search helpers (typo tolerant) ---------- */

    function subseqMatch(token, str) {
        if (token.length > str.length) return false;
        let i = 0;
        for (let j = 0; j < str.length && i < token.length; j++) if (token[i] === str[j]) i++;
        return i === token.length;
    }

    function fuzzyWordMatch(token, words) {
        if (token.length <= 2) return false;
        const md = Math.min(3, Math.max(1, Math.ceil(token.length / 2.5)));
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (w.length && Math.abs(token.length - w.length) <= md && lev(token, w) <= md) return true;
        }
        return false;
    }

    /** tokens are fold()ed; normStr is fold()ed haystack. */
    function isMatch(tokens, normStr, exact, words) {
        if (!tokens.length) return true;
        return tokens.every(t => {
            if (normStr.includes(t)) return true;
            if (exact || /\d/.test(t)) return false;
            return subseqMatch(t, normStr) || fuzzyWordMatch(t, words || normStr.split(' '));
        });
    }

    function tokenize(q) {
        return fold(q).split(' ').filter(Boolean);
    }

    /* ---------- formatting ---------- */

    const escapeHTML = v => v == null ? '' : String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

    const foldCache = new Map();
    function foldCached(w) {
        let v = foldCache.get(w);
        if (v === undefined) {
            v = fold(w);
            if (foldCache.size > 20000) foldCache.clear();
            foldCache.set(w, v);
        }
        return v;
    }

    function highlight(text, tokens) {
        const s = toStr(text);
        if (!tokens || !tokens.length || !s) return escapeHTML(s);
        return s.split(' ').map(w => {
            const nw = foldCached(w);
            const hit = tokens.some(t => nw.includes(t) || (t.length > 3 && lev(t, nw) <= Math.max(1, Math.floor(t.length / 3))));
            return hit ? `<mark>${escapeHTML(w)}</mark>` : escapeHTML(w);
        }).join(' ');
    }

    const hasArabic = s => /[\u0600-\u06FF]/.test(s);

    function makeKey() {
        return Array.prototype.map.call(arguments, p => (p == null ? '' : String(p))).join('\u0000');
    }

    function hashClass(text, n) {
        const s = toStr(text);
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % n;
    }

    const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });
    const compare = (a, b) => (typeof a === 'number' && typeof b === 'number')
        ? a - b
        : collator.compare(a == null ? '' : String(a), b == null ? '' : String(b));

    LX.text = {
        toStr, clean, fold, matchKey, stripArticle, normalizeDigits,
        lev, dice, similarity, numberSignature,
        isMatch, tokenize, highlight, escapeHTML, hasArabic,
        makeKey, hashClass, compare, collator
    };
})(window.LX = window.LX || {});
