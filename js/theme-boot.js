/* Runs before first paint to avoid a theme flash. Kept tiny and dependency-free. */
(function () {
    var pref = 'system';
    try { pref = localStorage.getItem('uni_theme') || 'system'; } catch (e) {}
    var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
    var r = document.documentElement;
    r.dataset.theme = resolved;
    r.dataset.themePref = pref;
    r.style.colorScheme = resolved;
})();
