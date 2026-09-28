/* ==========================================================================
   LX Parser — core/config.js
   Static configuration. Nothing in here has side effects.
   ========================================================================== */
(function (LX) {
    'use strict';

    const DEFAULT_PHARMACIES = {
        "ابو المطامير ق.ع": "الاولى", "ادكو ق.ع": "الاولى", "البيضا ق.ع": "الاولى", "النوبارية": "الاولى", "رشيد ق.ع": "الاولى", "سكر (كفر الدوار)": "الاولى", "كفر الدوار ق.ع": "الاولى",
        "ابو المطامير": "الاولى", "ادكو": "الاولى", "البيضا": "الاولى", "رشيد": "الاولى", "كفر الدوار": "الاولى",
        "ابوحمص ق.ع": "الثانية", "الأورام": "الثانية", "الرحمانية ق.ع": "الثانية", "الشرطة": "الثانية", "المحمودية ق.ع": "الثانية", "حوش عيسى ق.ع": "الثانية", "دمنهور الشاملة 1": "الثانية", "دمنهور الشاملة 2": "الثانية", "دمنهور مسائي": "الثانية", "سكر (دمنهور)": "الثانية",
        "ابوحمص": "الثانية", "الاورام": "الثانية", "الرحمانية": "الثانية", "المحمودية": "الثانية", "حوش عيسى": "الثانية", "دمنهور": "الثانية",
        "الدلنجات ق.ع": "الثالثة", "ايتاي ق.ع": "الثالثة", "بدر ق.ع": "الثالثة", "سكر (ايتاي)": "الثالثة", "شبراخيت ق.ع": "الثالثة", "قليشان": "الثالثة", "كوم حمادة ق.ع": "الثالثة", "وادي النطرون": "الثالثة",
        "ايتاي": "الثالثة", "بدر": "الثالثة", "شبراخيت": "الثالثة", "كوم حمادة": "الثالثة", "الدلنجات": "الثالثة"
    };

    /* Canonical region names + every spelling we have seen people type. */
    const REGIONS = [
        { name: 'الاولى',  aliases: ['1', 'اولى', 'الاولي', 'اول', 'الاول', 'first', 'one', 'r1', 'region 1', 'المنطقه الاولى'] },
        { name: 'الثانية', aliases: ['2', 'ثانيه', 'الثانيه', 'تانيه', 'التانيه', 'ثاني', 'الثاني', 'second', 'two', 'r2', 'region 2', 'المنطقه الثانيه'] },
        { name: 'الثالثة', aliases: ['3', 'ثالثه', 'الثالثه', 'تالته', 'التالته', 'ثالث', 'الثالث', 'third', 'three', 'r3', 'region 3', 'المنطقه الثالثه'] }
    ];

    /* Remote sources. `layout` is only a hint — the parser still auto-detects. */
    const SOURCES = [
        { id: 'wf1', label: 'Workforce · Sheet 1', type: 'Workforce', layout: 'wide',
          url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQN8aXSpq9C0tCALXXoEbvJPaclARPbZYOK_HfsUvEt2LHfI3POMH-nCtrxlo88Ggv5suGlWyMQZ9F1/pub?output=csv' },
        { id: 'wf2', label: 'Workforce · Sheet 2', type: 'Workforce', layout: 'wide',
          url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQN8aXSpq9C0tCALXXoEbvJPaclARPbZYOK_HfsUvEt2LHfI3POMH-nCtrxlo88Ggv5suGlWyMQZ9F1/pub?output=csv&gid=634020883' },
        { id: 'st1', label: 'Student · Sheet 1', type: 'Student', layout: 'wide',
          url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSUGSMP51ErMxVdw6PZ6yH1l2zo1VwPyyOqOgl-VeBg_C2MulI7ZPwTGTmzjEI9HkGO6VYUinYSenXz/pub?output=csv' }
    ];

    /* localStorage keys — kept identical to v1 so existing users keep their data. */
    const KEYS = {
        theme: 'uni_theme',
        prices: 'uni_prices',
        priceLabels: 'uni_price_labels',
        priceSchema: 'uni_price_schema',
        pharmacies: 'uni_pharmacies',
        aliases: 'uni_aliases',
        dupMode: 'uni_dup_mode',
        sourceStatus: 'uni_source_status',
        syncHistory: 'uni_sync_history',
        savedViews: 'uni_saved_views',
        groupConfig: 'uni_group_config',
        colVisible: 'uni_col_visible',
        lastSync: 'uni_last_sync',
        autoSync: 'uni_autosync',
        legacyCachePrefix: 'uni_cache_'
    };

    LX.config = Object.freeze({
        APP_NAME: 'LX Parser',
        VERSION: '2.0.0',
        DEFAULT_PHARMACIES,
        REGIONS,
        SOURCES,
        KEYS,
        ANOMALY_CAP: 5000,
        PAGE_SIZE: 100,
        PAGE_STEP: 200,
        HEADER_SCAN_ROWS: 40,
        PROFILE_SAMPLE_ROWS: 250,
        AUTO_SYNC_MS: 10 * 60 * 1000,
        STALE_LABEL_MS: 60 * 60 * 1000,
        STALE_BANNER_MS: 24 * 60 * 60 * 1000,
        FETCH_TIMEOUT_MS: 15000,
        FETCH_RETRIES: 2,
        DRIFT_RATIO: 0.6,
        /* Similarity thresholds for the entity resolver (0..1). */
        MATCH: {
            AUTO: 0.86,        // auto-resolve a pharmacy name to a known one
            AUTO_MARGIN: 0.06, // …only if it beats the runner-up by this much
            SUGGEST: 0.78,     // show as a "name variant" suggestion
            MIN_LEN: 4
        },
        IDB_NAME: 'lx_parser_local_sources',
        IDB_VERSION: 2,
        IDB_STORES: { sources: 'sources', kv: 'kv' },
        ACCEPT_FILES: '.xlsx,.xlsm,.xls,.xlsb,.ods,.csv,.tsv,.txt'
    });
})(window.LX = window.LX || {});
