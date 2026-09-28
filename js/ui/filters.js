/* ==========================================================================
   LX Parser — ui/filters.js
   Omnibox + faceted dropdowns (custom, keyboard-accessible, searchable)
   + saved views + URL state.  Emits  'filters:change'.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, D = LX.dom, S = LX.state, st = S.state;
    const { byId } = D;
    const SELECTS = { cat: 'sel-cat', reg: 'sel-reg', branch: 'sel-branch', pharm: 'sel-pharm', unit: 'sel-unit' };
    const EMPTY_LABEL = { cat: '(No Class)', reg: '(No Region)', branch: '(No Branch)', pharm: '(Empty)', unit: '(No Unit)' };
    let omni, snapshot = null;

    const val = k => byId(SELECTS[k]).value;

    function get() {
        if (snapshot) return snapshot;
        snapshot = {
            q: omni.value,
            tokens: T.tokenize(omni.value),
            exact: byId('toggle-exact').checked,
            cat: val('cat'), reg: val('reg'), branch: val('branch'), pharm: val('pharm'), unit: val('unit')
        };
        return snapshot;
    }
    const invalidate = () => { snapshot = null; };

    function anyActive() {
        const f = get();
        return !!f.q.trim() || Object.keys(SELECTS).some(k => f[k] !== 'ALL');
    }

    function changed(opts) {
        invalidate();
        updateActiveCount();
        LX.bus.emit('filters:change', opts || {});
    }

    /* ---------- populate from DB facets ---------- */
    function fillSelect(key, values) {
        const sel = byId(SELECTS[key]);
        const cur = sel.value;
        sel.innerHTML = '<option value="ALL">All</option>';
        Array.from(values).sort(T.compare).forEach(v => sel.add(new Option(v || EMPTY_LABEL[key], v)));
        sel.value = values.has(cur) ? cur : 'ALL';
        sel._refresh && sel._refresh();
    }

    function populate() {
        const f = LX.db.DB.facets;
        fillSelect('cat', f.t); fillSelect('reg', f.reg); fillSelect('branch', f.branch); fillSelect('unit', f.u);
        updatePharmacyOptions();
        invalidate();
        updateActiveCount();
    }

    function updatePharmacyOptions() {
        const r = val('reg'), b = val('branch');
        const set = new Set();
        LX.db.DB.rows.forEach(row => { if ((r === 'ALL' || row.region === r) && (b === 'ALL' || row.branch === b)) set.add(row.p); });
        fillSelect('pharm', set);
    }

    function updateActiveCount() {
        const n = Object.keys(SELECTS).filter(k => byId(SELECTS[k]).value !== 'ALL').length;
        const el = byId('filters-active');
        el.textContent = n ? `${n} filter${n > 1 ? 's' : ''} active` : '';
        el.classList.toggle('hidden', !n);
        byId('btn-clear-filters').classList.toggle('hidden', !n && !omni.value);
        Object.keys(SELECTS).forEach(k => byId(SELECTS[k]).closest('.dropdown-group').classList.toggle('has-value', byId(SELECTS[k]).value !== 'ALL'));
    }

    /* ---------- custom dropdowns ---------- */
    function initDropdowns() {
        let activePanel = null, activeGroup = null;
        const close = () => {
            if (!activePanel) return;
            activePanel.classList.remove('open');
            activeGroup.classList.remove('open');
            activeGroup.setAttribute('aria-expanded', 'false');
            activeGroup.removeAttribute('aria-activedescendant');
            activePanel = activeGroup = null;
        };

        const position = (panel, group) => {
            const r = group.getBoundingClientRect();
            const w = Math.max(r.width, 240);
            let left = Math.min(Math.max(10, r.left), window.innerWidth - w - 10);
            const below = window.innerHeight - r.bottom - 12;
            const h = Math.min(340, Math.max(below, r.top - 12));
            const up = below < 200 && r.top > below;
            panel.style.left = left + 'px';
            panel.style.minWidth = w + 'px';
            panel.style.maxHeight = h + 'px';
            panel.style.top = up ? `${r.top - Math.min(340, r.top - 12) - 8}px` : `${r.bottom + 8}px`;
            panel.style.transformOrigin = up ? 'bottom left' : 'top left';
        };

        Object.keys(SELECTS).forEach(key => {
            const id = SELECTS[key];
            const sel = byId(id), group = sel.closest('.dropdown-group');
            let kbd = -1, query = '';
            group.tabIndex = 0;
            group.setAttribute('role', 'combobox');
            group.setAttribute('aria-haspopup', 'listbox');
            group.setAttribute('aria-expanded', 'false');
            group.setAttribute('aria-label', group.querySelector('.dropdown-label').textContent + ' filter');

            const valEl = document.createElement('span');
            valEl.className = 'custom-select-val';
            sel.before(valEl);

            const panel = document.createElement('div');
            panel.className = 'custom-dropdown-panel';
            panel.setAttribute('role', 'listbox');
            panel.id = `${id}-panel`;
            group.setAttribute('aria-controls', panel.id);
            panel.innerHTML = `<div class="dropdown-search"><input type="text" placeholder="Filter…" aria-label="Filter options" autocomplete="off"></div><div class="dropdown-options"></div>`;
            document.body.appendChild(panel);
            const search = panel.querySelector('input'), list = panel.querySelector('.dropdown-options');

            const syncVal = () => {
                const o = sel.options[sel.selectedIndex];
                valEl.innerHTML = `<span dir="auto">${T.escapeHTML(o ? o.textContent : 'All')}</span>${D.ICON.arrow(14).replace('<svg', '<svg class="custom-select-arrow"')}`;
            };

            const build = () => {
                const cur = sel.value, tokens = T.tokenize(query);
                const opts = Array.from(sel.options).filter((o, i) => i === 0 || !tokens.length || T.isMatch(tokens, T.fold(o.textContent), false));
                list.innerHTML = opts.map((o, i) => `${i === 1 ? '<div class="custom-dropdown-divider"></div>' : ''}<div class="custom-dropdown-option ${o.value === cur ? 'active' : ''}" role="option" id="${id}-opt-${i}" data-value="${T.escapeHTML(o.value)}" aria-selected="${o.value === cur}"><span dir="auto">${T.highlight(o.textContent, tokens)}</span>${D.ICON.check(15).replace('<svg', '<svg class="check-icon"')}</div>`).join('')
                    + (opts.length <= 1 && tokens.length ? '<div class="dropdown-noresult">No matches</div>' : '');
                panel.querySelector('.dropdown-search').classList.toggle('hidden', sel.options.length < 9);
            };
            const highlight = () => {
                const opts = list.querySelectorAll('.custom-dropdown-option');
                opts.forEach((o, i) => o.classList.toggle('kbd-focus', i === kbd));
                if (opts[kbd]) { opts[kbd].scrollIntoView({ block: 'nearest' }); group.setAttribute('aria-activedescendant', opts[kbd].id); }
            };
            const choose = value => {
                sel.value = value;
                close(); syncVal();
                sel.dispatchEvent(new Event('change'));
                group.focus();
            };
            const open = viaKbd => {
                close();
                query = ''; search.value = '';
                build(); position(panel, group);
                panel.classList.add('open'); group.classList.add('open'); group.setAttribute('aria-expanded', 'true');
                activePanel = panel; activeGroup = group;
                kbd = viaKbd ? Math.max(0, Array.from(list.querySelectorAll('.custom-dropdown-option')).findIndex(o => o.classList.contains('active'))) : -1;
                highlight();
                if (sel.options.length >= 9 && !viaKbd) setTimeout(() => search.focus(), 30);
            };

            sel._refresh = () => { syncVal(); if (activePanel === panel) build(); };
            syncVal();

            group.addEventListener('mousedown', e => {
                if (e.target.closest('.clear-btn')) return;
                e.preventDefault();
                activePanel === panel ? close() : open(false);
            });
            list.addEventListener('mousedown', e => {
                const o = e.target.closest('.custom-dropdown-option');
                if (!o) return;
                e.preventDefault();
                choose(o.dataset.value);
            });
            search.addEventListener('input', () => { query = search.value; build(); kbd = 0; highlight(); });
            const onKey = e => {
                const isOpen = activePanel === panel;
                const opts = list.querySelectorAll('.custom-dropdown-option');
                if (e.key === 'Enter' || (e.key === ' ' && e.target !== search)) {
                    e.preventDefault();
                    if (!isOpen) open(true); else if (opts[kbd]) choose(opts[kbd].dataset.value);
                } else if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen) open(true); else { kbd = Math.min(kbd + 1, opts.length - 1); highlight(); } }
                else if (e.key === 'ArrowUp') { e.preventDefault(); if (isOpen) { kbd = Math.max(kbd - 1, 0); highlight(); } }
                else if (e.key === 'Escape') { if (isOpen) { e.preventDefault(); e.stopPropagation(); close(); group.focus(); } }
                else if (e.key === 'Tab') { if (isOpen) close(); }
                else if (isOpen && e.target !== search && e.key.length === 1 && sel.options.length >= 9) { search.focus(); }
            };
            group.addEventListener('keydown', onKey);
            search.addEventListener('keydown', onKey);

            group.querySelector('.clear-btn').addEventListener('click', e => {
                e.stopPropagation();
                if (sel.value === 'ALL') return;
                sel.value = 'ALL'; syncVal();
                sel.dispatchEvent(new Event('change'));
            });
        });

        document.addEventListener('mousedown', e => {
            if (activePanel && !e.target.closest('.dropdown-group') && !e.target.closest('.custom-dropdown-panel')) close();
        });
        document.addEventListener('scroll', e => { if (activePanel && !activePanel.contains(e.target)) close(); }, true);
        window.addEventListener('resize', close);
    }

    /* ---------- saved views ---------- */
    function capture() {
        const f = get();
        return { q: f.q, cat: f.cat, reg: f.reg, branch: f.branch, pharm: f.pharm, unit: f.unit, exact: f.exact };
    }

    function apply(s) {
        omni.value = s.q || '';
        const setSel = (k, v) => { const sel = byId(SELECTS[k]); sel.value = Array.from(sel.options).some(o => o.value === v) ? v : 'ALL'; sel._refresh && sel._refresh(); };
        setSel('cat', s.cat); setSel('reg', s.reg); setSel('branch', s.branch);
        invalidate(); updatePharmacyOptions();
        setSel('pharm', s.pharm); setSel('unit', s.unit);
        byId('toggle-exact').checked = !!s.exact;
        syncOmniClear();
        changed();
    }

    function renderSavedViews() {
        const row = byId('saved-views-row');
        D.$$('.saved-view-pill', row).forEach(el => el.remove());
        const addBtn = byId('btn-add-view');
        st.savedViews.forEach((v, idx) => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'saved-view-pill';
            pill.title = describeView(v.state);
            pill.innerHTML = `<span dir="auto">${T.escapeHTML(v.name)}</span><span class="saved-view-remove" role="button" aria-label="Remove view ${T.escapeHTML(v.name)}">×</span>`;
            pill.addEventListener('click', e => {
                if (e.target.classList.contains('saved-view-remove')) {
                    st.savedViews.splice(idx, 1); S.persist.savedViews(); renderSavedViews(); return;
                }
                apply(v.state);
                D.toast(`View "${v.name}" applied`);
            });
            row.insertBefore(pill, addBtn);
        });
    }
    function describeView(s) {
        const parts = [];
        if (s.q) parts.push(`"${s.q}"`);
        ['cat', 'reg', 'branch', 'pharm', 'unit'].forEach(k => { if (s[k] && s[k] !== 'ALL') parts.push(s[k]); });
        return parts.length ? parts.join(' · ') : 'No filters';
    }

    function initSavedViews() {
        const btn = byId('btn-add-view'), input = byId('new-view-input');
        btn.addEventListener('click', () => { input.classList.add('active'); input.value = ''; input.focus(); });
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const name = input.value.trim();
                if (name) {
                    const existing = st.savedViews.findIndex(v => v.name === name);
                    const entry = { name, state: capture() };
                    if (existing >= 0) st.savedViews[existing] = entry; else st.savedViews.push(entry);
                    S.persist.savedViews(); renderSavedViews();
                    D.toast(existing >= 0 ? `View "${name}" updated` : `View "${name}" saved`);
                }
                input.classList.remove('active'); input.blur();
            } else if (e.key === 'Escape') { input.classList.remove('active'); input.blur(); }
        });
        input.addEventListener('blur', () => input.classList.remove('active'));
        renderSavedViews();
    }

    /* ---------- URL state ---------- */
    function syncURL(view) {
        const p = new URLSearchParams();
        p.set('view', view);
        const f = get();
        if (f.q) p.set('q', f.q);
        Object.keys(SELECTS).forEach(k => { if (f[k] !== 'ALL') p.set(k === 'cat' ? 'cat' : k, f[k]); });
        try { history.replaceState(null, '', `${location.pathname}?${p.toString()}`); } catch (e) {}
    }

    function readURL() {
        const p = new URLSearchParams(location.search);
        const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
        return { view: p.get('view') || hash.get('view'), subtab: p.get('tab') || hash.get('tab'), state: { q: p.get('q') || '', cat: p.get('cat') || 'ALL', reg: p.get('reg') || 'ALL', branch: p.get('branch') || 'ALL', pharm: p.get('pharm') || 'ALL', unit: p.get('unit') || 'ALL' } };
    }

    /* ---------- omnibox ---------- */
    function syncOmniClear() { byId('btn-clear-omni').classList.toggle('visible', omni.value.length > 0); }

    function clearAll() {
        apply({ q: '', exact: byId('toggle-exact').checked });
    }

    function init() {
        omni = byId('omnibox');
        initDropdowns();
        initSavedViews();
        const debounced = D.debounce(() => changed({ search: true }), 90);
        omni.addEventListener('input', () => { syncOmniClear(); invalidate(); debounced(); });
        byId('btn-clear-omni').addEventListener('click', () => { omni.value = ''; syncOmniClear(); omni.focus(); changed({ search: true }); });
        byId('btn-clear-filters').addEventListener('click', clearAll);
        byId('sel-reg').addEventListener('change', () => { invalidate(); updatePharmacyOptions(); changed(); });
        byId('sel-branch').addEventListener('change', () => { invalidate(); updatePharmacyOptions(); changed(); });
        ['sel-cat', 'sel-pharm', 'sel-unit', 'toggle-exact'].forEach(id => byId(id).addEventListener('change', () => changed()));
    }

    LX.filters = { init, get, invalidate, anyActive, populate, apply, clearAll, syncURL, readURL, syncOmniClear, get omni() { return omni; } };
})(window.LX = window.LX || {});
