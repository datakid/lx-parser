/* LX Parser — parser test suite. Open tests/parser.test.html in a browser. */
(function () {
    'use strict';
    const T = LX.text, N = LX.numbers, H = LX.headers, E = LX.engine, R = LX.resolver;
    const out = document.getElementById('results');
    let pass = 0, fail = 0;

    function ok(cond, name, detail) {
        const li = document.createElement('li');
        li.className = cond ? 'pass' : 'fail';
        li.textContent = (cond ? '✓ ' : '✗ ') + name + (cond || detail === undefined ? '' : '  →  ' + JSON.stringify(detail));
        out.appendChild(li);
        if (cond) pass++; else { fail++; console.error('FAIL', name, detail); }
    }
    const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

    /* ---------------- text ---------------- */
    eq(T.matchKey('ابو المطامير ق.ع'), T.matchKey('أبو  المطامير ق ع'), 'matchKey: hamza + spacing + punctuation');
    eq(T.matchKey('الشرطة'), T.matchKey('الشرطه'), 'matchKey: ta marbuta');
    eq(T.matchKey('حوش عيسى'), T.matchKey('حوش عيسي'), 'matchKey: alef maqsura');
    eq(T.matchKey('دمنهور الشاملة ١'), T.matchKey('دمنهور الشامله 1'), 'matchKey: Arabic-Indic digits');
    eq(T.clean('\u200Fبنادول\u00A0\u00A0اكسترا\u0640'), 'بنادول اكسترا', 'clean: RLM, NBSP, tatweel');
    ok(T.similarity('دمنهور الشاملة 1', 'دمنهور الشاملة 2') === 0, 'similarity: different numbers never match');
    ok(T.similarity('كفر الدوار', 'كفرالدوار') === 1, 'similarity: missing space = identical');
    ok(T.similarity('شبراخيت', 'شبرا خيت') === 1, 'similarity: split word = identical');
    ok(T.similarity('المحمودية', 'المحموديه') === 1, 'similarity: ه/ة');
    ok(T.similarity('وادي النطرون', 'وادى النطرون') === 1, 'similarity: ى/ي');
    ok(T.similarity('الرحمانية', 'الرحمانيه ق.ع') < 0.86, 'similarity: "ق.ع" suffix is NOT merged automatically');
    ok(T.isMatch(T.tokenize('بندول'), T.fold('بنادول اكسترا'), false), 'search: missing letter');
    ok(!T.isMatch(T.tokenize('بندول'), T.fold('بنادول اكسترا'), true), 'search: exact mode off for typos');

    /* ---------------- numbers ---------------- */
    const n = v => { const r = N.parseNumber(v); return [r.status, r.value]; };
    eq(n(12), ['ok', 12], 'number: plain');
    eq(n('١٢'), ['ok', 12], 'number: Arabic-Indic');
    eq(n('۱۵'), ['ok', 15], 'number: Persian');
    eq(n('1,234'), ['ok', 1234], 'number: thousands comma');
    eq(n('1.234,5'), ['corrected', 1234.5], 'number: EU format');
    eq(n('12,5'), ['corrected', 12.5], 'number: decimal comma');
    eq(n('٣٫٥'), ['corrected', 3.5], 'number: Arabic decimal separator');
    eq(n('5 علب'), ['corrected', 5], 'number: trailing unit word');
    eq(N.parseNumber('5 علب').unitHint.length > 0, true, 'number: unit hint captured');
    eq(n('3+2'), ['corrected', 5], 'number: tally sum');
    eq(n('عشرة'), ['corrected', 10], 'number: Arabic number word');
    eq(n('x3'), ['corrected', 3], 'number: multiplier');
    eq(n('150 ج.م'), ['corrected', 150], 'number: currency');
    eq(n('#REF!'), ['error', null], 'number: #REF!');
    eq(n('#N/A'), ['error', null], 'number: #N/A');
    eq(n('-'), ['empty', null], 'number: dash = empty');
    eq(n('لا يوجد'), ['empty', null], 'number: "لا يوجد" = empty');
    eq(n('ـــ'), ['empty', null], 'number: tatweel run = empty');
    eq(n('abc'), ['unparseable', null], 'number: garbage');
    eq(n('10-12'), ['corrected', 10], 'number: range takes first');

    /* ---------------- headers ---------------- */
    const top = s => (H.classifyHeader(s)[0] || {}).field;
    eq(top('الصنف'), 'i', 'header: الصنف');
    eq(top('اسم الصنف'), 'i', 'header: اسم الصنف');
    eq(top('الصنـــف'), 'i', 'header: tatweel');
    eq(top('الاصناف'), 'i', 'header: plural');
    eq(top('Item Name'), 'i', 'header: English');
    eq(top('الوحدة'), 'u', 'header: الوحدة');
    eq(top('الوحده'), 'u', 'header: الوحده');
    eq(top('الكمية'), 'q', 'header: الكمية');
    eq(top('الصيدلية'), 'p', 'header: الصيدلية');
    eq(top('العيادة'), 'p', 'header: العيادة');
    eq(top('الاجمالي'), 'total', 'header: الاجمالي = total');
    eq(top('إجمالى'), 'total', 'header: إجمالى = total');
    eq(top('م'), 'ignore', 'header: serial م');
    eq(top('دمنهور'), undefined, 'header: pharmacy name is not a field');

    /* ---------------- resolver ---------------- */
    const res = R.createResolver({ knownPharmacies: Object.keys(LX.config.DEFAULT_PHARMACIES), aliases: {}, rejected: {} });
    eq(res.pharmacy('الشرطه'), 'الشرطة', 'resolver: pharmacy ه/ة');
    eq(res.pharmacy('ابو  حمص'), 'ابوحمص', 'resolver: pharmacy extra space');
    eq(res.pharmacy('أدكو'), 'ادكو', 'resolver: pharmacy hamza');
    eq(res.pharmacy('دمنهور الشامله ١'), 'دمنهور الشاملة 1', 'resolver: pharmacy Indic digit');
    eq(res.pharmacy('كوم حماده ق ع'), 'كوم حمادة ق.ع', 'resolver: pharmacy ق ع vs ق.ع');
    eq(res.pharmacy('شبرا خيت'), 'شبراخيت', 'resolver: pharmacy split word');
    eq(res.pharmacy('الدلنجاتت'), 'الدلنجات', 'resolver: fuzzy doubled letter');
    eq(res.pharmacy('صيدلية جديدة'), 'صيدلية جديدة', 'resolver: unknown stays as-is');
    eq(res.pharmacy('كفر الدوار ق ع'), 'كفر الدوار ق.ع', 'resolver: ق ع keeps its own site');
    ok(R.differsOnlyByQualifier('كفر الدوار', 'كفر الدوار ق.ع'), 'guard: ق.ع is a different site');
    ok(R.differsOnlyByQualifier('دمنهور', 'دمنهور مسائي'), 'guard: مسائي is a different site');
    ok(R.isAffixVariant('Omeprazole 40mg', 'Esomeprazole 40mg'), 'guard: Omeprazole ≠ Esomeprazole');
    ok(!R.isAffixVariant('Vitamin B Comb', 'Vitamin B Comp'), 'guard: Comb/Comp is a typo');
    const sugg = R.findSimilarPairs([
        { name: 'Omeprazole 40mg', count: 2 }, { name: 'Esomeprazole 40mg', count: 5 },
        { name: 'Vitamin B Comb', count: 1 }, { name: 'Vitamin B Comp', count: 9 },
        { name: 'Sulphamethoxazole & Trimethoprim Tab', count: 1 }, { name: 'Sulphamethoxazole & Trimethoprim Susp', count: 4 },
        { name: 'Empagliflozin 10mg', count: 1 }, { name: 'Dapagliflozin 10mg', count: 3 },
        { name: 'esomoprazole 20 mg', count: 1 }, { name: 'Esomeprazole 20mg', count: 6 }
    ], 0.84, 10, { kind: 'i' });
    eq(sugg.map(s => s.b).sort(), ['Vitamin B Comb', 'esomoprazole 20 mg'].sort(), 'suggestions: only genuine typos (form/stem/affix guards)');
    eq(R.canonicalRegion('1'), 'الاولى', 'region: "1"');
    eq(R.canonicalRegion('الاولي'), 'الاولى', 'region: ي/ى');
    eq(R.canonicalRegion('التانيه'), 'الثانية', 'region: colloquial');
    eq(R.canonicalRegion('Region 3'), 'الثالثة', 'region: English');
    eq(R.canonicalUnit('علبه'), 'علبة', 'unit: علبه');
    eq(R.canonicalUnit('Box'), 'علبة', 'unit: Box');
    eq(R.canonicalUnit('امبولات'), 'أمبول', 'unit: plural');
    eq(R.canonicalUnit('شريط'), 'شريط', 'unit: canonical unchanged');

    /* ---------------- engine: wide layout (the remote Google sheet shape) ---------------- */
    const wide = {
        name: 'wide', grid: [
            ['تقرير المخزون الشهري', '', '', '', '', ''],
            ['', '', '', '', '', ''],
            ['م', 'الصنـــف', 'الوحده', 'دمنهور', 'أدكو', 'الإجمالي'],
            [1, 'بنادول اكسترا', 'علبه', 10, '٥', 15],
            [2, 'اوجمنتين 1جم', 'علبة', '', '3 علب', 3],
            [3, 'سرنجة 5 سم', 'قطعة', '#REF!', 20, 20],
            [4, '', '', 7, '', 7],
            ['', 'الاجمالي', '', 17, 28, 45],
            [5, 'م', 'الوحده', 'دمنهور', 'أدكو', 'الإجمالي'],
            [6, 'فولتارين امبول', 'امبول', 'لا يوجد', '-', '']
        ]
    };
    const wcfg = E.profileSheet(wide);
    eq(wcfg.headerRowIdx, 2, 'wide: header row skips title + blank');
    eq(wcfg.layout, 'wide', 'wide: layout detected');
    eq(wcfg.columnMap[1], 'i', 'wide: item column');
    eq(wcfg.columnMap[2], 'u', 'wide: unit column');
    eq(wcfg.columnMap[3], 'wq', 'wide: pharmacy column 1');
    eq(wcfg.columnMap[4], 'wq', 'wide: pharmacy column 2');
    ok(wcfg.columnMap[5] !== 'wq', 'wide: totals column ignored', wcfg.columnMap[5]);
    ok(wcfg.columnMap[0] !== 'wq', 'wide: serial column ignored', wcfg.columnMap[0]);
    const wres = E.extractSheet(wide, wcfg, { sourceLabel: 'wide' });
    eq(wres.records.length, 4, 'wide: 4 records (10, ٥, "3 علب", 20 — blanks / #REF! / blank-item skipped)');
    const byKey = {};
    wres.records.forEach(r => { byKey[r.i + '|' + r.p] = r.q; });
    eq(byKey['بنادول اكسترا|أدكو'], 5, 'wide: Arabic digit quantity');
    eq(byKey['اوجمنتين 1جم|أدكو'], 3, 'wide: "3 علب" repaired');
    eq(wres.stats.totals, 1, 'wide: totals row skipped');
    eq(wres.stats.repeatedHeaders, 1, 'wide: repeated header skipped');
    ok(wres.anomalies.some(a => a.sev === 'error'), 'wide: #REF! flagged');
    ok(wres.anomalies.some(a => a.act.startsWith('Blank item')), 'wide: blank item row flagged');

    /* ---------------- engine: long layout with merged/grouped pharmacy ---------------- */
    const long = {
        name: 'long', grid: [
            ['الصيدليه', 'الفرع', 'اسم الصنف', 'الوحدة', 'الكميه', 'السعر'],
            ['دمنهور', 'الاول', 'بنادول', 'علبه', '10', '25'],
            ['', '', 'فيتامين سي', 'Box', '٢٠', '١٥٫٥'],
            ['', '', 'قطن طبي', 'رول', '5+5', ''],
            ['الشرطه', 'الثاني', 'بنادول', 'علب', 'عشرة', '25'],
            ['', '', 'سرنجه', 'pcs', '#N/A', '2'],
            ['', '', '', '', '', ''],
            ['اجمالي', '', '', '', '45', '']
        ]
    };
    const lcfg = E.profileSheet(long);
    eq(lcfg.layout, 'long', 'long: layout detected');
    eq(lcfg.columnMap[0], 'p', 'long: pharmacy col');
    eq(lcfg.columnMap[1], 'branch', 'long: branch col');
    eq(lcfg.columnMap[2], 'i', 'long: item col');
    eq(lcfg.columnMap[4], 'q', 'long: qty col');
    eq(lcfg.columnMap[5], 'price', 'long: price col');
    eq(lcfg.fillDir[0], 'down', 'long: fill-down auto-enabled for pharmacy');
    const lres = E.extractSheet(long, lcfg, { sourceLabel: 'long' });
    eq(lres.records.length, 4, 'long: 4 records (#N/A skipped, total row skipped)');
    eq(lres.records.filter(r => r.p === 'دمنهور').length, 3, 'long: pharmacy filled down to 3 rows');
    eq(lres.records.find(r => r.i === 'فيتامين سي').price, 15.5, 'long: Arabic decimal price');
    eq(lres.records.find(r => r.i === 'قطن طبي').q, 10, 'long: tally 5+5');
    eq(lres.records.find(r => r.p === 'الشرطه').q, 10, 'long: number word عشرة');

    /* ---------------- engine: two-row header ---------------- */
    const two = {
        name: 'two', grid: [
            ['الصنف', 'الوحدة', 'الكميات', '', ''],
            ['', '', 'رشيد', 'ادكو', 'البيضا'],
            ['قفازات', 'علبة', 4, 2, ''],
            ['كمامات', 'علبة', '', 6, 1]
        ]
    };
    const tcfg = E.profileSheet(two);
    eq(tcfg.headerDepth, 2, 'two-row: depth detected');
    eq(tcfg.layout, 'wide', 'two-row: wide');
    const tres = E.extractSheet(two, tcfg, {});
    eq(tres.records.map(r => r.p).sort(T.compare), ['ادكو', 'ادكو', 'البيضا', 'رشيد'].sort(T.compare), 'two-row: pharmacy names from 2nd header row');

    /* two-row header where the group label was a MERGED cell (reader expands merges) */
    const twoMerged = {
        name: 'twoMerged', grid: [
            ['الصنف', 'الوحدة', 'الكميات', 'الكميات', 'الكميات', 'اجمالي'],
            ['الصنف', 'الوحدة', 'رشيد', 'ادكو', 'البيضا', 'اجمالي'],
            ['قفازات', 'علبة', 4, 2, '', 6],
            ['كمامات', 'علبة', '', '٦', 1, 7]
        ]
    };
    const tm = E.profileSheet(twoMerged);
    eq(tm.headerDepth, 2, 'two-row merged: depth detected');
    const tmr = E.extractSheet(twoMerged, tm, {});
    eq(tmr.records.length, 4, 'two-row merged: 4 records, totals col ignored');
    eq(Array.from(new Set(tmr.records.map(r => r.p))).sort(T.compare), ['ادكو', 'البيضا', 'رشيد'].sort(T.compare), 'two-row merged: pharmacy names from sub-header');

    /* a normal long sheet must NOT be mistaken for a two-row header */
    eq(E.profileSheet(long).headerDepth, 1, 'long: single header row kept');

    /* ---------------- engine: no recognisable header ---------------- */
    const bare = {
        name: 'bare', grid: [
            ['بنادول اكسترا 500 مجم', 'علبة', 5, 3],
            ['اوجمنتين 1 جم اقراص', 'علبة', 2, 0],
            ['فولتارين 75 امبول', 'امبول', 1, 4],
            ['سيتال شراب اطفال', 'زجاجة', 8, 2],
            ['قطن طبي 100 جم', 'رول', 3, 3]
        ]
    };
    const bcfg = E.profileSheet(bare);
    eq(bcfg.columnMap[0], 'i', 'headerless: item column guessed from content');

    /* ---------------- reader: CSV variants ---------------- */
    const csvSemicolon = 'الصنف;الوحدة;دمنهور\nبنادول;علبة;5\n';
    const wb1 = LX.reader.readText(csvSemicolon, 'semi');
    eq(wb1.sheets[0].grid[1], ['بنادول', 'علبة', '5'], 'reader: semicolon delimiter sniffed');
    const csvTab = 'الصنف\tالوحدة\tدمنهور\nبنادول\tعلبة\t5\n';
    eq(LX.reader.readText(csvTab, 'tab').sheets[0].grid[1][2], '5', 'reader: TAB delimiter sniffed');
    const bom = '\uFEFFالصنف,الوحدة\nبنادول,علبة\n';
    eq(LX.reader.readText(bom, 'bom').sheets[0].grid[0][0], 'الصنف', 'reader: BOM stripped');

    // Windows-1256 bytes for "الصنف"
    const cp1256 = new Uint8Array([0xC7, 0xE1, 0xD5, 0xE4, 0xDD, 0x2C, 0x31, 0x0A]);
    const dec = LX.reader.decodeBytes(cp1256);
    eq(dec.encoding, 'windows-1256', 'reader: windows-1256 fallback');
    ok(dec.text.startsWith('الصنف'), 'reader: windows-1256 decoded text', dec.text);

    // Real xlsx round-trip with a merged cell
    const ws = XLSX.utils.aoa_to_sheet([['الصيدلية', 'الصنف', 'الكمية'], ['رشيد', 'بنادول', 2], ['', 'سيتال', 3]]);
    ws['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
    const wbx = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wbx, ws, 'Sheet1');
    const buf = XLSX.write(wbx, { type: 'array', bookType: 'xlsx' });
    const rb = LX.reader.readBuffer(buf, 'merged.xlsx');
    eq(rb.sheets[0].grid[2][0], 'رشيد', 'reader: merged cell expanded');
    const mres = E.parseWorkbook(rb, {}, { sourceLabel: 'merged' });
    eq(mres.records.length, 2, 'reader+engine: merged pharmacy applies to both rows');

    /* ---------------- summary ---------------- */
    const s = document.getElementById('summary');
    s.textContent = `${pass} passed, ${fail} failed`;
    s.className = fail ? 'fail' : 'pass';
    console.log(`[LX tests] ${pass} passed, ${fail} failed`);
})();
