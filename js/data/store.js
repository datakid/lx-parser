/* ==========================================================================
   LX Parser — data/store.js
   Persistence adapters: safe localStorage JSON + a tiny IndexedDB wrapper.
   Every call is failure-tolerant (private mode, quota, disabled storage).
   ========================================================================== */
(function (LX) {
    'use strict';
    const C = LX.config;
    const listeners = new Set();

    const ls = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch (e) { return fallback; }
        },
        getRaw(key, fallback) {
            try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
                return true;
            } catch (e) {
                if (e && (e.name === 'QuotaExceededError' || e.code === 22)) listeners.forEach(fn => fn('quota', key));
                return false;
            }
        },
        remove(key) { try { localStorage.removeItem(key); } catch (e) {} },
        keys(prefix) {
            const out = [];
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!prefix || k.startsWith(prefix)) out.push(k); } } catch (e) {}
            return out;
        },
        onError(fn) { listeners.add(fn); }
    };

    let dbPromise = null;
    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            const req = indexedDB.open(C.IDB_NAME, C.IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(C.IDB_STORES.sources)) db.createObjectStore(C.IDB_STORES.sources, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(C.IDB_STORES.kv)) db.createObjectStore(C.IDB_STORES.kv);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
        }).catch(err => { dbPromise = null; throw err; });
        return dbPromise;
    }

    function tx(store, mode, fn) {
        return openDB().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(store, mode);
            const os = t.objectStore(store);
            let result;
            const req = fn(os);
            if (req) req.onsuccess = () => { result = req.result; };
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('Transaction aborted'));
        }));
    }

    const idb = {
        put: (store, value, key) => tx(store, 'readwrite', os => key === undefined ? os.put(value) : os.put(value, key)),
        get: (store, key) => tx(store, 'readonly', os => os.get(key)),
        getAll: (store) => tx(store, 'readonly', os => os.getAll()).then(r => r || []),
        del: (store, key) => tx(store, 'readwrite', os => os.delete(key))
    };

    LX.store = { ls, idb };
})(window.LX = window.LX || {});
