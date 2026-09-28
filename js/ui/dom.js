/* ==========================================================================
   LX Parser — ui/dom.js
   DOM helpers, formatters, icons, toasts, KPI animation, sparklines.
   ========================================================================== */
(function (LX) {
    'use strict';
    const T = LX.text;

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const byId = id => document.getElementById(id);

    const fmtEGP = new Intl.NumberFormat('en-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 2 });
    const fmtNum = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
    const fmt = { egp: v => fmtEGP.format(v || 0), num: v => fmtNum.format(v || 0) };
    const plural = (n, one, many) => `${fmt.num(n)} ${n === 1 ? one : (many || one + 's')}`;

    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const svg = (body, size, sw) => `<svg width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 2.5}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const ICON = {
        search: s => svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', s, 2),
        check: s => svg('<polyline points="20 6 9 17 4 12"/>', s),
        info: s => svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', s),
        warn: s => svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', s),
        x: s => svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', s),
        arrow: s => svg('<polyline points="6 9 12 15 18 9"/>', s),
        edit: s => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>', s),
        upload: s => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>', s, 2),
        merge: s => svg('<path d="M8 6h3a4 4 0 0 1 4 4v8"/><polyline points="11 15 15 19 19 15"/><circle cx="5" cy="6" r="2"/>', s),
        file: s => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', s),
        undo: s => svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>', s),
        cmd: s => svg('<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>', s, 2)
    };

    function emptyRow(label, colspan) {
        return `<tr class="empty-row"><td colspan="${colspan || 12}"><div class="empty-state">${ICON.search(34)}<span>${T.escapeHTML(label)}</span></div></td></tr>`;
    }

    function badgeClass(text) { return `badge-p${T.hashClass(text, 6)}`; }

    /* ---------- toasts ---------- */
    function toast(message, type, action) {
        type = type || 'success';
        const stack = byId('toast-stack');
        const icon = type === 'success' ? ICON.check() : type === 'warning' ? ICON.warn() : ICON.info();
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.innerHTML = `${icon}<span class="toast-msg">${T.escapeHTML(message)}</span>${action ? `<button type="button" class="toast-action">${T.escapeHTML(action.label)}</button>` : ''}<button type="button" class="toast-close" aria-label="Dismiss">${ICON.x(12)}</button>`;
        stack.appendChild(el);
        const close = () => { el.classList.remove('visible'); setTimeout(() => el.remove(), 320); };
        if (action) el.querySelector('.toast-action').addEventListener('click', () => { action.fn(); close(); });
        el.querySelector('.toast-close').addEventListener('click', close);
        // keep at most 4 toasts on screen
        const all = stack.querySelectorAll('.toast');
        if (all.length > 4) all[0].remove();
        requestAnimationFrame(() => el.classList.add('visible'));
        let timer = setTimeout(close, action ? 6000 : type === 'error' ? 5200 : 3400);
        el.addEventListener('mouseenter', () => clearTimeout(timer));
        el.addEventListener('mouseleave', () => { timer = setTimeout(close, 1800); });
        return el;
    }

    /* ---------- KPI counter ---------- */
    function animateKpi(el, target, formatter) {
        if (!el) return;
        const f = formatter || fmt.num;
        if (reduceMotion() || typeof el._val !== 'number') { el.textContent = f(target); el._val = target; return; }
        if (el._raf) cancelAnimationFrame(el._raf);
        const start = el._val, t0 = performance.now(), dur = 420;
        const step = t => {
            const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
            el.textContent = f(start + (target - start) * e);
            if (p < 1) el._raf = requestAnimationFrame(step); else { el._val = target; el.textContent = f(target); }
        };
        el._raf = requestAnimationFrame(step);
    }

    function sparkline(svgEl, values) {
        if (!svgEl) return;
        if (!values || values.length < 2) { svgEl.innerHTML = ''; return; }
        const w = 100, h = 30, min = Math.min(...values), max = Math.max(...values), range = (max - min) || 1, step = w / (values.length - 1);
        const pts = values.map((v, i) => [i * step, h - ((v - min) / range) * (h - 4) - 2]);
        const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
        const last = pts[pts.length - 1];
        svgEl.innerHTML = `<path class="spark-fill" d="${line} L${w},${h} L0,${h} Z"></path><path class="spark-line" d="${line}"></path><circle class="spark-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2"></circle>`;
    }

    function relTime(ts) {
        const diff = Math.max(0, Date.now() - ts), m = Math.floor(diff / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    function debounce(fn, ms) {
        let t;
        return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(this, a), ms); };
    }

    /* ---------- focus trap for modals ---------- */
    function focusables(root) {
        return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root).filter(el => el.offsetParent !== null);
    }
    function trapTab(e, root) {
        if (e.key !== 'Tab') return;
        const f = focusables(root);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function confirmDialog(message, okLabel) {
        return Promise.resolve(window.confirm(message + (okLabel ? '' : '')));
    }

    LX.dom = { $, $$, byId, fmt, plural, ICON, emptyRow, badgeClass, toast, animateKpi, sparkline, relTime, debounce, reduceMotion, trapTab, focusables, confirmDialog };
})(window.LX = window.LX || {});
