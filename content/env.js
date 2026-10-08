// Content-side actions: service-worker/CacheStorage purge, localStorage +
// sessionStorage snapshot & apply (storage profiles), and feature-flag
// listing. Runs in the page's isolated world on demand; every action
// returns plain structured-clone-safe data and never throws.
'use strict';
(function () {
  const UES = (window.UAEnvSwitcher = window.UAEnvSwitcher || {});
  const core = (window.UAEnvSwitcherCore = window.UAEnvSwitcherCore || {});

  const MAX_VALUE_PREVIEW = 120; // popup shows a snippet, not the whole value

  // Mirrors parseFlagValue in shared/envcore.js — content scripts load as
  // classic scripts, so the eight lines are duplicated deliberately.
  function parseFlagValue(raw) {
    if (raw === 'true' || raw === 'false') return { type: 'bool', value: raw === 'true' };
    if (typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw))) {
      return { type: 'number', value: Number(raw) };
    }
    return { type: 'string', value: raw == null ? '' : String(raw) };
  }

  function snapshotStores(ls, ss) {
    const out = { ls: {}, ss: {} };
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      out.ls[k] = ls.getItem(k);
    }
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      out.ss[k] = ss.getItem(k);
    }
    return out;
  }

  function applyStores(ls, ss, data) {
    const d = data && typeof data === 'object' ? data : {};
    let set = 0;
    for (const [store, bag] of [
      [ls, d.ls],
      [ss, d.ss]
    ]) {
      const stale = [];
      for (let i = 0; i < store.length; i++) stale.push(store.key(i));
      for (const k of stale) store.removeItem(k);
      for (const [k, v] of Object.entries(bag || {})) {
        store.setItem(k, String(v));
        set++;
      }
    }
    return set;
  }

  async function purgeCaches() {
    let sw = 0;
    let gone = 0;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
        sw++;
      }
    } catch (_) {
      /* no service worker support on this scheme; nothing to unregister */
    }
    try {
      const keys = await window.caches.keys();
      for (const key of keys) {
        await window.caches.delete(key);
        gone++;
      }
    } catch (_) {
      /* CacheStorage needs a secure context; skip silently */
    }
    return { sw, caches: gone };
  }

  function listFlags(prefixes) {
    const ps = Array.isArray(prefixes) ? prefixes.filter((p) => typeof p === 'string' && p !== '') : [];
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (ps.length && !ps.some((p) => key.startsWith(p))) continue;
      const raw = localStorage.getItem(key) || '';
      const parsed = parseFlagValue(raw);
      out.push({
        key,
        type: parsed.type,
        on: parsed.type === 'bool' ? parsed.value : null,
        preview: raw.length > MAX_VALUE_PREVIEW ? raw.slice(0, MAX_VALUE_PREVIEW) + '…' : raw
      });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }

  UES.act = async function (action, arg) {
    try {
      if (action === 'purge') return await purgeCaches();
      if (action === 'ls-snapshot') return snapshotStores(localStorage, sessionStorage);
      if (action === 'ls-apply') return { set: applyStores(localStorage, sessionStorage, arg) };
      if (action === 'flags') return { flags: listFlags(arg && arg.prefixes) };
      if (action === 'flag-set') {
        if (!arg || typeof arg.key !== 'string' || !arg.key) return { error: 'bad key' };
        localStorage.setItem(arg.key, String(arg.value));
        return { ok: true };
      }
      return { error: 'unknown action' };
    } catch (_) {
      return { error: 'action failed' }; // e.g. storage blocked by site settings
    }
  };

  // Exposed for the unit/e2e tests.
  core.parseFlagValue = parseFlagValue;
  core.snapshotStores = snapshotStores;
  core.applyStores = applyStores;
  core.listFlags = listFlags;
})();
