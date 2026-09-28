/* ==========================================================================
   LX Parser — ui/table.js
   One generic paginated + multi-sort table controller.
   Replaces v1's seven hand-written render/append function pairs.

   const t = LX.table.create({
       key: 'view-pricing',               // sort/limit namespace
       table: <table>, tbody: <tbody>, cap: <div>,
       defaultSort: [{ k: 'stat', d: -1 }],
       row: (d, idx, ctx) => '<tr>…</tr>',  // HTML string for one row
       empty: () => 'No items match',
       ctx: () => ({ tokens })             // per-render context
   });
   t.setData(array); t.render();
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text, D = LX.dom, C = LX.config;
    const registry = {};

    function create(opts) {
        const self = {
            key: opts.key,
            data: [],
            sorted: [],
            limit: C.PAGE_SIZE,
            rendered: 0,
            rules: (opts.defaultSort || []).slice(),
            opts
        };

        function colspan() { return opts.table ? opts.table.querySelectorAll('thead th:not(.hidden)').length || 8 : 8; }

        function sort() {
            const rules = self.rules;
            if (!rules.length) { self.sorted = self.data.slice(); return; }
            self.sorted = self.data.slice().sort((a, b) => {
                for (const r of rules) { const c = T.compare(a[r.k], b[r.k]); if (c) return c * r.d; }
                return 0;
            });
        }

        function rowsHTML(from, to, ctx) {
            let html = '';
            for (let i = from; i < to; i++) html += opts.row(self.sorted[i], i, ctx);
            return html;
        }

        function updateCap() {
            if (!opts.cap) return;
            const total = self.sorted.length;
            if (!total) { opts.cap.innerHTML = ''; opts.cap.classList.add('hidden'); return; }
            opts.cap.classList.remove('hidden');
            opts.cap.innerHTML = total > self.rendered
                ? `<span>Showing <b>${D.fmt.num(self.rendered)}</b> of <b>${D.fmt.num(total)}</b></span><button type="button" class="btn btn-ghost load-more-btn" data-load-more="${self.key}">Load ${D.fmt.num(Math.min(C.PAGE_STEP, total - self.rendered))} more</button><button type="button" class="btn btn-ghost load-more-btn" data-load-all="${self.key}">Show all</button>`
                : `<span>Showing all <b>${D.fmt.num(total)}</b> ${total === 1 ? 'record' : 'records'}</span>`;
        }

        self.setData = function (arr) { self.data = arr || []; self.limit = C.PAGE_SIZE; sort(); };
        self.resetLimit = function () { self.limit = C.PAGE_SIZE; };

        self.render = function () {
            const ctx = opts.ctx ? opts.ctx() : {};
            const end = Math.min(self.limit, self.sorted.length);
            opts.tbody.innerHTML = end ? rowsHTML(0, end, ctx) : D.emptyRow(opts.empty ? opts.empty() : 'Nothing here', colspan());
            self.rendered = end;
            updateCap();
            opts.after && opts.after(self);
        };

        self.loadMore = function (all) {
            const ctx = opts.ctx ? opts.ctx() : {};
            const old = self.rendered;
            self.limit = all ? self.sorted.length : self.limit + C.PAGE_STEP;
            const end = Math.min(self.limit, self.sorted.length);
            if (end > old) opts.tbody.insertAdjacentHTML('beforeend', rowsHTML(old, end, ctx));
            self.rendered = end;
            updateCap();
        };

        self.toggleSort = function (key, additive) {
            const rules = self.rules, idx = rules.findIndex(r => r.k === key);
            const cur = idx >= 0 ? rules[idx].d : null;
            const next = cur == null ? 1 : cur === 1 ? -1 : null;
            if (additive) {
                if (idx === -1) rules.push({ k: key, d: 1 });
                else if (next == null) rules.splice(idx, 1);
                else rules[idx].d = next;
            } else if (rules.length === 1 && idx === 0) {
                self.rules = next == null ? [] : [{ k: key, d: next }];
            } else {
                self.rules = [{ k: key, d: 1 }];
            }
            self.syncHeaders();
            sort();
            self.render();
        };

        self.syncHeaders = function () {
            if (!opts.table) return;
            opts.table.querySelectorAll('th[data-sort]').forEach(th => {
                const ri = self.rules.findIndex(r => r.k === th.dataset.sort);
                const rule = self.rules[ri];
                th.classList.toggle('sort-active', !!rule);
                th.setAttribute('aria-sort', rule ? (rule.d === 1 ? 'ascending' : 'descending') : 'none');
                if (rule) th.dataset.dir = rule.d === 1 ? 'asc' : 'desc'; else delete th.dataset.dir;
                const badge = th.querySelector('.sort-order');
                if (badge) badge.textContent = (rule && self.rules.length > 1) ? String(ri + 1) : '';
            });
        };

        self.item = i => self.sorted[i];

        // header wiring
        if (opts.table) {
            opts.table.querySelectorAll('th[data-sort]').forEach(th => {
                th.setAttribute('role', 'button');
                th.tabIndex = 0;
                if (!th.querySelector('.sort-icon')) th.insertAdjacentHTML('beforeend', ' <span class="sort-icon"></span>');
                if (!th.querySelector('.sort-order')) th.insertAdjacentHTML('beforeend', '<span class="sort-order"></span>');
            });
            const onSort = e => {
                const th = e.target.closest('th[data-sort]');
                if (!th || !opts.table.contains(th)) return;
                if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                self.toggleSort(th.dataset.sort, e.shiftKey);
            };
            opts.table.querySelector('thead').addEventListener('click', onSort);
            opts.table.querySelector('thead').addEventListener('keydown', onSort);
            self.syncHeaders();
        }

        registry[self.key] = self;
        return self;
    }

    document.addEventListener('click', e => {
        const more = e.target.closest('[data-load-more]');
        if (more && registry[more.dataset.loadMore]) { registry[more.dataset.loadMore].loadMore(false); return; }
        const all = e.target.closest('[data-load-all]');
        if (all && registry[all.dataset.loadAll]) registry[all.dataset.loadAll].loadMore(true);
    });

    LX.table = { create, get: k => registry[k] };
})(window.LX = window.LX || {});
