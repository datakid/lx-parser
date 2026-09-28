/* ==========================================================================
   LX Parser — parser/numbers.js
   Forgiving numeric cell parser for hand-typed quantities and prices.

   parseQuantity(raw) → { status, value, note, unitHint }
     status: 'ok'          clean number
             'corrected'   number recovered from messy text (kept)
             'empty'       blank / intentional-empty token ("-", "لا يوجد", …)
             'error'       spreadsheet formula error (#REF!, #N/A, …)
             'unparseable' nothing usable

   Handles: Arabic/Persian digits, Arabic decimal/thousands separators,
   1,234.5 / 1.234,5 / 1 234, currency & unit words, (12) negatives,
   "5+3" sums, "x3", number words (عشرة / ten), ranges, dates-in-cells.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text;

    const ERROR_RE = /^#\s*(REF|NAME\??|VALUE|DIV\/0|NUM|NULL|N\/A|ERR|ERROR|SPILL|CALC|GETTING_DATA)\s*[!?]*$/i;

    const EMPTY_TOKENS = new Set([
        'لايوجد', 'لا', 'غيرمتاح', 'غيرمتوفر', 'مفيش', 'ماكو', 'نافذ', 'صفر', 'لاشي', 'لاشيء',
        'nil', 'none', 'na', 'n/a', 'null', 'empty', 'nothing', 'no', 'x', 'xx', '?', '??', '-'
    ].map(s => T.matchKey(s) || s));

    const NUMBER_WORDS = {
        'صفر': 0, 'واحد': 1, 'واحده': 1, 'اثنين': 2, 'اتنين': 2, 'اثنان': 2, 'ثلاثه': 3, 'تلاته': 3, 'ثلاث': 3,
        'اربعه': 4, 'اربع': 4, 'خمسه': 5, 'خمس': 5, 'سته': 6, 'ست': 6, 'سبعه': 7, 'سبع': 7, 'ثمانيه': 8, 'تمانيه': 8,
        'تسعه': 9, 'تسع': 9, 'عشره': 10, 'عشر': 10, 'عشرين': 20, 'ثلاثين': 30, 'خمسين': 50, 'ميه': 100, 'مائه': 100, 'مية': 100,
        'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
        'ten': 10, 'twenty': 20, 'fifty': 50, 'hundred': 100, 'dozen': 12, 'دسته': 12, 'درزن': 12
    };

    /* Words that commonly trail a number. If found we return a unit hint. */
    const UNIT_WORD_RE = /(علب[هة]?|علب|شريط|شرائط|شرايط|امبول[هة]?|امبولات|قرص|اقراص|زجاج[هة]|ازاز[هة]|كيس|اكياس|قطع[هة]|فيال|انبوب[هة]?|عبو[هة]|باكو|كرتون[هة]?|box(?:es)?|strips?|amps?|ampoules?|vials?|tabs?|tablets?|bottles?|btls?|pcs?|pieces?|packs?|sachets?|tubes?|cartons?|units?)/i;
    const CURRENCY_RE = /(ج\.?\s?م\.?|جنيه(?:ا|ات)?|جنية|egp|le|l\.e\.?|\$|usd|ريال|sar)/ig;

    function isIntentionalEmpty(raw) {
        const s = T.clean(raw);
        if (!s) return true;
        const collapsed = s.replace(/\s+/g, '');
        if (/^[-–—_.·•ـ]+$/.test(collapsed)) return true;
        const k = T.matchKey(s);
        return k === '' || EMPTY_TOKENS.has(k);
    }

    /** Resolve thousands/decimal separators in a single numeric token. */
    function normalizeSeparators(tok) {
        let s = tok.replace(/[\s\u00A0']/g, '');
        const hasComma = s.includes(','), hasDot = s.includes('.');
        if (hasComma && hasDot) {
            // whichever comes last is the decimal separator
            if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
            else s = s.replace(/,/g, '');
        } else if (hasComma) {
            s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
        } else if (hasDot) {
            if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, '');
        }
        // collapse stray repeated dots ("12..5")
        s = s.replace(/\.{2,}/g, '.');
        const parts = s.split('.');
        if (parts.length > 2) s = parts.shift() + '.' + parts.join('');
        return s;
    }

    function result(status, value, note, unitHint) {
        return { status, value: value == null ? null : value, note: note || '', unitHint: unitHint || '' };
    }

    function parseNumber(raw) {
        if (raw == null) return result('empty');
        if (typeof raw === 'number') {
            if (!isFinite(raw)) return result('unparseable', null, 'Non-finite');
            return result('ok', raw);
        }
        if (typeof raw === 'boolean') return result('unparseable', null, 'Boolean value');
        if (raw instanceof Date) return result('unparseable', null, 'Date in a number cell');

        const original = T.clean(raw);
        if (!original) return result('empty');
        if (ERROR_RE.test(original)) return result('error', null, 'Formula error');
        if (isIntentionalEmpty(original)) return result('empty');

        let s = T.normalizeDigits(original)
            .replace(/\u066B/g, '.')   // Arabic decimal separator
            .replace(/\u066C/g, ',')   // Arabic thousands separator
            .replace(/[٪%]/g, '');

        // unit hint (e.g. "5 علب")
        const unitMatch = T.fold(s).match(UNIT_WORD_RE);
        const unitHint = unitMatch ? unitMatch[0] : '';

        s = s.replace(CURRENCY_RE, ' ');

        // Plain number fast path.  'ok' = unambiguous standard notation
        // (digits converted from Arabic-Indic still count as ok);
        // anything needing separator guessing is 'corrected'.
        const plain = s.replace(/\s+/g, '');
        if (/^[-+]?(\d[\d,.' ]*)$/.test(plain) || /^[-+]?\.\d+$/.test(plain)) {
            const v = parseFloat(normalizeSeparators(plain));
            if (!isNaN(v)) {
                const standard = /^[-+]?\d+(\.\d+)?$/.test(plain) || /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(plain);
                const hadNoise = T.normalizeDigits(original).replace(/\s+/g, '') !== plain;
                return result(standard && !hadNoise ? 'ok' : 'corrected', v, standard ? 'Unit/currency text removed' : 'Separators normalized', unitHint);
            }
        }

        // Accounting negative "(12)"
        const acct = plain.match(/^\((\d[\d,.]*)\)$/);
        if (acct) return result('corrected', -parseFloat(normalizeSeparators(acct[1])), 'Accounting negative');

        // Scientific notation
        if (/^[-+]?\d+(\.\d+)?e[-+]?\d+$/i.test(plain)) return result('ok', parseFloat(plain));

        // Simple sums "5+3+2" (common when people tally in a cell)
        if (/^\d+(\.\d+)?(\s*\+\s*\d+(\.\d+)?)+$/.test(s.trim())) {
            const v = s.split('+').reduce((a, b) => a + parseFloat(b), 0);
            return result('corrected', v, 'Summed ' + s.trim(), unitHint);
        }

        // Multiplier "x3" / "3x" / "3 ×"
        const mult = s.match(/^[x×*]\s*(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s*[x×*]$/i);
        if (mult) return result('corrected', parseFloat(mult[1] || mult[2]), 'Multiplier sign removed');

        // Number words ("عشرة", "ten")
        const words = T.fold(s).split(/\s+/);
        for (const w of words) {
            const k = w.replace(/^و/, '');
            if (k in NUMBER_WORDS) return result('corrected', NUMBER_WORDS[k], 'Number word "' + w + '"', unitHint);
        }

        // Extract numbers embedded in text
        const nums = s.match(/-?\d[\d,.]*/g);
        if (nums && nums.length) {
            const values = nums.map(n => parseFloat(normalizeSeparators(n))).filter(v => !isNaN(v));
            if (values.length === 1) return result('corrected', values[0], 'Extracted from text', unitHint);
            if (values.length > 1) {
                // "10-12" range → take the first, flag it
                if (/^\s*\d+(\.\d+)?\s*[-–~]\s*\d+(\.\d+)?\s*$/.test(s)) {
                    return result('corrected', values[0], 'Range — took first value', unitHint);
                }
                return result('corrected', values[0], 'Several numbers — took first', unitHint);
            }
        }
        return result('unparseable', null, 'No number found');
    }

    LX.numbers = { parseNumber, isIntentionalEmpty, ERROR_RE };
})(window.LX = window.LX || {});
