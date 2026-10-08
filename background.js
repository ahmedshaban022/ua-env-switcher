// Service worker: environment hopping (popup / Alt+Shift+E / context menu),
// cache purge + hard reload, and storage-profile save/apply/undo. Settings
// live in chrome.storage.sync, profiles and the per-origin undo slot in
// chrome.storage.local. No other state is kept here.

import { DEFAULTS, MAX_PROFILES, matchEnv, nextEnv, switchUrl, urlOrigin } from './shared/envcore.js';
import { runInTab } from './shared/inject.js';

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function getEnvs() {
  const s = await chrome.storage.sync.get({ envs: DEFAULTS.envs });
  return Array.isArray(s.envs) ? s.envs.filter((e) => e && e.id) : [];
}

async function getLocal(key, fallback) {
  const s = await chrome.storage.local.get({ [key]: fallback });
  return s[key];
}

// ---------- context menus (rebuilt whenever the env list changes) ----------

async function rebuildMenus() {
  const envs = await getEnvs();
  await chrome.contextMenus.removeAll();
  if (envs.length) {
    chrome.contextMenus.create({
      id: 'ua-es-open',
      title: 'Open this page in',
      contexts: ['page']
    });
    for (const env of envs) {
      chrome.contextMenus.create({
        id: 'ua-es-env:' + env.id,
        parentId: 'ua-es-open',
        title: env.name + '  —  ' + env.origin.replace(/^https?:\/\//, ''),
        contexts: ['page']
      });
    }
  }
  chrome.contextMenus.create({
    id: 'ua-es-purge',
    title: 'Purge SW caches & hard reload',
    contexts: ['page']
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get({ envs: null, flagPrefixes: null });
  const patch = {};
  if (!Array.isArray(s.envs)) patch.envs = DEFAULTS.envs;
  if (!Array.isArray(s.flagPrefixes)) patch.flagPrefixes = DEFAULTS.flagPrefixes;
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  await rebuildMenus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.envs) rebuildMenus();
});

// ---------- actions ----------

async function doSwitch(envId, pageUrl) {
  const envs = await getEnvs();
  const env = envs.find((e) => e.id === envId);
  const url = switchUrl(pageUrl, env);
  if (!url) return null;
  return url; // caller performs the tabs.update with its own tab id
}

async function doCycle() {
  const tab = await activeTab();
  if (!tab || !tab.url || !urlOrigin(tab.url)) return null;
  const envs = await getEnvs();
  const current = matchEnv(tab.url, envs);
  const target = nextEnv(envs, current && current.id);
  if (!target || (current && target.id === current.id)) return { url: null };
  const url = switchUrl(tab.url, target);
  if (!url) return null;
  await chrome.tabs.update(tab.id, { url });
  return { url, env: target.name };
}

async function doPurge() {
  const tab = await activeTab();
  if (!tab || tab.id == null) return null;
  const res = await runInTab(tab.id, 'purge').catch(() => null);
  if (!res) return null;
  await chrome.tabs.reload(tab.id, { bypassCache: true });
  return res;
}

async function doProfileSave(name) {
  const tab = await activeTab();
  const origin = tab && tab.url ? urlOrigin(tab.url) : null;
  if (!origin || !tab || tab.id == null) return { error: 'not-a-page' };
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return { error: 'name-required' };
  const snap = await runInTab(tab.id, 'ls-snapshot').catch(() => null);
  if (!snap || snap.error) return { error: 'snapshot-failed' };
  const profiles = await getLocal('profiles', []);
  const next = profiles.filter((p) => p && !(p.origin === origin && p.name === clean));
  next.push({ id: 'p-' + Date.now().toString(36), origin, name: clean, data: snap, createdAt: Date.now() });
  while (next.length > MAX_PROFILES) next.shift(); // FIFO past the cap
  await chrome.storage.local.set({ profiles: next });
  return { saved: true, total: next.length };
}

async function doProfileApply(name) {
  const tab = await activeTab();
  const origin = tab && tab.url ? urlOrigin(tab.url) : null;
  if (!origin || !tab || tab.id == null) return { error: 'not-a-page' };
  const profiles = await getLocal('profiles', []);
  const profile = profiles.find((p) => p && p.origin === origin && p.name === String(name || '').trim());
  if (!profile) return { error: 'not-found' };
  const before = await runInTab(tab.id, 'ls-snapshot').catch(() => null);
  if (before && !before.error) {
    await chrome.storage.local.set({ undo: { [origin]: { data: before, at: Date.now() } } });
  }
  const res = await runInTab(tab.id, 'ls-apply', profile.data).catch(() => null);
  if (!res || res.error) return { error: 'apply-failed' };
  await chrome.tabs.reload(tab.id);
  return { applied: profile.name };
}

async function doProfileUndo() {
  const tab = await activeTab();
  const origin = tab && tab.url ? urlOrigin(tab.url) : null;
  if (!origin || !tab || tab.id == null) return { error: 'not-a-page' };
  const undo = await getLocal('undo', {});
  const slot = undo && undo[origin];
  if (!slot || !slot.data) return { error: 'nothing-to-undo' };
  const res = await runInTab(tab.id, 'ls-apply', slot.data).catch(() => null);
  if (!res || res.error) return { error: 'apply-failed' };
  delete undo[origin];
  await chrome.storage.local.set({ undo });
  await chrome.tabs.reload(tab.id);
  return { undone: true };
}

async function doFlags() {
  const tab = await activeTab();
  if (!tab || tab.id == null) return null;
  const { flagPrefixes } = await chrome.storage.sync.get({ flagPrefixes: DEFAULTS.flagPrefixes });
  return runInTab(tab.id, 'flags', { prefixes: flagPrefixes }).catch(() => null);
}

async function doFlagSet(key, value) {
  const tab = await activeTab();
  if (!tab || tab.id == null) return null;
  return runInTab(tab.id, 'flag-set', { key, value }).catch(() => null);
}

// ---------- wiring ----------

chrome.commands.onCommand.addListener((command) => {
  if (command === 'cycle-env') doCycle();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const pageUrl = info && info.pageUrl ? info.pageUrl : tab && tab.url;
  if (info.menuItemId === 'ua-es-purge') {
    doPurge();
    return;
  }
  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('ua-es-env:')) {
    const envId = info.menuItemId.slice('ua-es-env:'.length);
    const url = await doSwitch(envId, pageUrl);
    if (url && tab && tab.id != null) chrome.tabs.update(tab.id, { url });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const run = (p) => p.then(sendResponse).catch(() => sendResponse(null));
  if (msg.type === 'ua-es:switch') {
    run((async () => {
      const tab = await activeTab();
      if (!tab || !tab.url || !urlOrigin(tab.url) || tab.id == null) return null;
      const url = await doSwitch(msg.envId, tab.url);
      if (!url) return null;
      await chrome.tabs.update(tab.id, { url });
      return { url };
    })());
    return true;
  }
  if (msg.type === 'ua-es:purge') {
    run(doPurge());
    return true;
  }
  if (msg.type === 'ua-es:profile-save') {
    run(doProfileSave(msg.name));
    return true;
  }
  if (msg.type === 'ua-es:profile-apply') {
    run(doProfileApply(msg.name));
    return true;
  }
  if (msg.type === 'ua-es:profile-undo') {
    run(doProfileUndo());
    return true;
  }
  if (msg.type === 'ua-es:flags') {
    run(doFlags());
    return true;
  }
  if (msg.type === 'ua-es:flag-set') {
    run(doFlagSet(msg.key, msg.value));
    return true;
  }
  return undefined;
});
