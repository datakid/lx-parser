/* ==========================================================================
   LX Parser — parser/reader.js
   Turns anything (xlsx/xls/xlsb/ods/csv/tsv/txt file, or remote CSV text)
   into a uniform workbook:  { sheets: [{ name, grid, hidden, notes[] }] }

   grid is a dense 2-D array of raw cell values (number | string | Date),
   blank rows are PRESERVED so reported row numbers match the spreadsheet.
   Merged ranges are expanded (the top-left value is copied to every cell)
   which fixes the classic "item name merged over 3 rows" problem.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text;

    /* ---------- text decoding (UTF-8 → UTF-16 → Windows-1256 fallback) ---------- */

    function decodeBytes(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8), encoding: 'utf-16le' };
        if (u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8), encoding: 'utf-16be' };
        try {
            return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^\uFEFF/, ''), encoding: 'utf-8' };
        } catch (e) { /* not valid UTF-8 → legacy Arabic Excel export */ }
        try {
            return { text: new TextDecoder('windows-1256').decode(u8), encoding: 'windows-1256' };
        } catch (e) {
            return { text: new TextDecoder('utf-8').decode(u8), encoding: 'utf-8 (lossy)' };
        }
    }

    /* ---------- CSV / delimited text ---------- */

    function sniffDelimiter(text) {
        const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
        const cands = [',', ';', '\t', '|', '،'];
        let best = ',', bestScore = -1;
        cands.forEach(d => {
            const counts = sample.split('\n').filter(Boolean).map(l => l.split(d).length - 1);
            if (!counts.length) return;
            const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
            const consistent = counts.filter(c => c === counts[0]).length / counts.length;
            const score = avg * (0.5 + consistent);
            if (score > bestScore) { bestScore = score; best = d; }
        });
        return best;
    }

    function parseDelimited(text) {
        const delimiter = sniffDelimiter(text);
        let rows;
        if (window.Papa) {
            rows = window.Papa.parse(text, { delimiter, skipEmptyLines: false }).data;
        } else {
            const wb = XLSX.read(text, { type: 'string', FS: delimiter, raw: true });
            rows = sheetToGrid(wb.Sheets[wb.SheetNames[0]]).grid;
        }
        // trim trailing blank rows produced by the final newline
        while (rows.length && rows[rows.length - 1].every(c => T.clean(c) === '')) rows.pop();
        return { grid: rows.map(r => r.map(c => c == null ? '' : c)), delimiter };
    }

    /* ---------- worksheet → grid ---------- */

    function sheetToGrid(ws) {
        if (!ws || !ws['!ref']) return { grid: [], merges: 0 };
        const range = XLSX.utils.decode_range(ws['!ref']);
        const rows = range.e.r - range.s.r + 1, cols = range.e.c - range.s.c + 1;
        // guard against sheets with a bogus huge used-range
        const maxRows = Math.min(rows, 200000), maxCols = Math.min(cols, 400);
        const grid = new Array(maxRows);
        for (let r = 0; r < maxRows; r++) {
            const row = new Array(maxCols);
            for (let c = 0; c < maxCols; c++) {
                const cell = ws[XLSX.utils.encode_cell({ r: r + range.s.r, c: c + range.s.c })];
                row[c] = cellValue(cell);
            }
            grid[r] = row;
        }
        let merges = 0;
        (ws['!merges'] || []).forEach(m => {
            const r0 = m.s.r - range.s.r, c0 = m.s.c - range.s.c;
            if (r0 < 0 || c0 < 0 || r0 >= maxRows || c0 >= maxCols) return;
            const v = grid[r0][c0];
            for (let r = r0; r <= Math.min(m.e.r - range.s.r, maxRows - 1); r++) {
                for (let c = c0; c <= Math.min(m.e.c - range.s.c, maxCols - 1); c++) {
                    if (r === r0 && c === c0) continue;
                    if (grid[r][c] === '' || grid[r][c] == null) grid[r][c] = v;
                }
            }
            merges++;
        });
        // trim trailing fully-blank rows / cols
        let lastRow = grid.length - 1;
        while (lastRow >= 0 && grid[lastRow].every(v => T.clean(v) === '')) lastRow--;
        grid.length = lastRow + 1;
        let lastCol = -1;
        grid.forEach(row => { for (let c = row.length - 1; c > lastCol; c--) if (T.clean(row[c]) !== '') { lastCol = c; break; } });
        grid.forEach((row, i) => { grid[i] = row.slice(0, lastCol + 1); });
        const hiddenRows = new Set();
        (ws['!rows'] || []).forEach((ri, i) => { if (ri && ri.hidden) hiddenRows.add(i - range.s.r); });
        return { grid, merges, hiddenRows };
    }

    function cellValue(cell) {
        if (!cell) return '';
        switch (cell.t) {
            case 'n': return typeof cell.v === 'number' && isFinite(cell.v) ? cell.v : (cell.w || '');
            case 'b': return cell.v ? 'TRUE' : 'FALSE';
            case 'e': return cell.w || '#ERROR!';
            case 'd': return cell.v instanceof Date ? cell.v : (cell.w || '');
            case 'z': return '';
            default: return cell.v == null ? '' : cell.v;
        }
    }

    /* ---------- public API ---------- */

    const EXT_RE = /\.(xlsx|xlsm|xlsb|xls|ods|fods|csv|tsv|txt)$/i;

    function kindOf(file) {
        const m = (file.name || '').match(EXT_RE);
        if (!m) return null;
        const ext = m[1].toLowerCase();
        return (ext === 'csv' || ext === 'tsv' || ext === 'txt') ? 'text' : 'workbook';
    }

    function looksLikeZipOrOle(u8) {
        return (u8[0] === 0x50 && u8[1] === 0x4B) || (u8[0] === 0xD0 && u8[1] === 0xCF);
    }

    async function readFile(file) {
        const kind = kindOf(file);
        if (!kind) throw new Error(`${file.name || 'File'} isn't a supported type — use .xlsx, .xls, .ods or .csv`);
        const buf = await file.arrayBuffer();
        return readBuffer(buf, file.name);
    }

    function workbookFrom(wb, name, extraNote) {
        const hiddenFlags = (wb.Workbook && wb.Workbook.Sheets) || [];
        const sheets = wb.SheetNames.map((sn, i) => {
            const { grid, merges, hiddenRows } = sheetToGrid(wb.Sheets[sn]);
            const notes = extraNote ? [extraNote] : [];
            if (merges) notes.push(`${merges} merged range${merges > 1 ? 's' : ''} expanded`);
            return { name: T.clean(sn) || `Sheet ${i + 1}`, grid, hidden: !!(hiddenFlags[i] && hiddenFlags[i].Hidden), hiddenRows: hiddenRows || new Set(), notes };
        });
        return { name, sheets, format: 'workbook' };
    }

    function readBuffer(buf, name) {
        const u8 = new Uint8Array(buf);
        if (!u8.length) throw new Error(`${name} is empty`);
        const opts = { cellDates: true, cellNF: false, cellText: true, codepage: 1256 };

        // 1. Real binary workbook (xlsx/xlsm/xlsb/ods = ZIP, xls = OLE) — trust content, not extension.
        if (looksLikeZipOrOle(u8)) return workbookFrom(XLSX.read(u8, Object.assign({ type: 'array' }, opts)), name);

        // 2. Text-based: decode with encoding fallback.
        const { text, encoding } = decodeBytes(u8);

        // 2a. "Fake .xls" from web systems: an HTML table or SpreadsheetML XML.
        if (/^\s*</.test(text)) {
            try {
                const wb = XLSX.read(text, Object.assign({ type: 'string' }, opts));
                if (wb.SheetNames.length && wb.Sheets[wb.SheetNames[0]]['!ref']) return workbookFrom(wb, name, 'HTML/XML table export');
            } catch (e) { /* fall through */ }
            throw new Error(`${name} looks like a web page, not a spreadsheet`);
        }

        // 2b. Delimited text (CSV / TSV / semicolon / Arabic comma).
        const { grid, delimiter } = parseDelimited(text);
        const notes = [`Encoding ${encoding}`, `Delimiter "${delimiter === '\t' ? 'TAB' : delimiter}"`];
        return { name, sheets: [{ name: name.replace(EXT_RE, '') || 'Sheet 1', grid, hidden: false, hiddenRows: new Set(), notes }], format: 'text' };
    }

    function readText(text, name) {
        if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Received an HTML page instead of CSV data (is the sheet published?)');
        const { grid } = parseDelimited(text.replace(/^\uFEFF/, ''));
        return { name, sheets: [{ name, grid, hidden: false, hiddenRows: new Set(), notes: [] }], format: 'text' };
    }

    LX.reader = { readFile, readBuffer, readText, decodeBytes, kindOf };
})(window.LX = window.LX || {});
