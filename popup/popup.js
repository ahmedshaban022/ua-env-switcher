// Popup logic: renders the quick-switch list, profiles, and flags for the
// active tab, and delegates every action to the service worker (which owns
// tab access and injection). The popup never talks to a tab directly.
import { DEFAULTS, matchEnv, switchUrl, urlOrigin } from '../shared/envcore.js';

const $ = (id) => document.getElementById(id);

function send(type, extra) {
  return chrome.runtime.sendMessage(Object.assign({ type }, extra || {})).catch(() => null);
}

function setStatus(html) {
  $('stats').innerHTML = html || '';
}

function hostOf(origin) {
  return origin.replace(/^https?:\/\//, '');
}

// Seeded defaults point at example.com until the user configures real
// hosts — flag them so the first click doesn't feel like a bug.
function isPlaceholder(origin) {
  try {
    return new URL(origin).hostname.endsWith('example.com');
  } catch (_) {
    return false;
  }
}

let origin = null; // null on chrome:// pages and the like: actions disabled

function disabledPage() {
  return !origin;
}

async function init() {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
  const pageUrl = (tab && tab.url) || '';
  origin = urlOrigin(pageUrl);

  const { envs, flagPrefixes } = await chrome.storage.sync.get({
    envs: DEFAULTS.envs,
    flagPrefixes: DEFAULTS.flagPrefixes
  });
  renderEnvs(envs, pageUrl);
  if (disabledPage()) {
    $('route').textContent = 'Open a normal http(s) page to switch environments.';
    $('psave').disabled = true;
  } else {
    let route = '';
    try {
      const u = new URL(pageUrl);
      route = u.pathname + u.search + u.hash;
    } catch (_) {
      route = '';
    }
    $('route').textContent = 'Route kept: ' + (route || '/');
    await renderProfiles();
    await renderFlags(flagPrefixes);
  }
}

function renderEnvs(envs, pageUrl) {
  const box = $('envs');
  box.textContent = '';
  const list = Array.isArray(envs) ? envs.filter((e) => e && e.id) : [];
  const current = pageUrl ? matchEnv(pageUrl, list) : null;

  const chip = $('current');
  chip.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = current ? current.color : '#6b7280';
  chip.appendChild(dot);
  chip.appendChild(document.createTextNode(current ? current.name : 'no match'));
  chip.title = current ? current.origin : 'This page matches no saved environment';

  for (const env of list) {
    if (current && env.id === current.id) continue;
    const btn = document.createElement('button');
    btn.className = 'env';
    const d = document.createElement('span');
    d.className = 'dot';
    d.style.background = env.color || '#4ade80';
    btn.appendChild(d);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = env.name;
    btn.appendChild(name);
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = hostOf(env.origin || '') + (isPlaceholder(env.origin) ? ' · edit me' : '');
    btn.appendChild(host);
    btn.title = pageUrl ? switchUrl(pageUrl, env) || env.origin : env.origin;
    btn.addEventListener('click', async () => {
      if (disabledPage()) return;
      const res = await send('ua-es:switch', { envId: env.id });
      setStatus(res && res.url ? 'Switching to <b>' + env.name + '</b>…' : 'Could not switch on this page.');
    });
    box.appendChild(btn);
  }
  if (!box.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No other environments — add some under Manage.';
    box.appendChild(empty);
  }
}

async function renderProfiles() {
  const box = $('profiles');
  box.textContent = '';
  const { profiles = [], undo = {} } = await chrome.storage.local.get({ profiles: [], undo: {} });
  const mine = (Array.isArray(profiles) ? profiles : []).filter((p) => p && p.origin === origin);
  for (const p of mine) {
    const row = document.createElement('div');
    row.className = 'prow';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    name.title = 'Saved ' + new Date(p.createdAt || Date.now()).toLocaleString();
    row.appendChild(name);
    const apply = document.createElement('button');
    apply.textContent = 'Apply';
    apply.addEventListener('click', async () => {
      setStatus((await send('ua-es:profile-apply', { name: p.name })) ? 'Applying profile…' : 'Could not apply.');
    });
    row.appendChild(apply);
    box.appendChild(row);
  }
  if (!mine.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No profiles saved for ' + hostOf(origin) + ' yet.';
    box.appendChild(empty);
  }
  const slot = undo[origin];
  const undoBtn = $('undolink');
  undoBtn.hidden = !slot;
  undoBtn.onclick = async () => {
    setStatus((await send('ua-es:profile-undo')) ? 'Restoring…' : 'Nothing to restore.');
  };
}

async function renderFlags(prefixes) {
  const box = $('flags');
  box.textContent = '';
  const res = await send('ua-es:flags');
  const flags = res && Array.isArray(res.flags) ? res.flags : [];
  if (!flags.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No localStorage keys matching ' + (prefixes || []).join(', ') + '.';
    box.appendChild(empty);
    return;
  }
  for (const f of flags) {
    const row = document.createElement('label');
    row.className = 'flag';
    const key = document.createElement('span');
    key.className = 'fkey';
    key.textContent = f.key;
    key.title = f.preview;
    row.appendChild(key);
    if (f.type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!f.on;
      cb.addEventListener('change', () => send('ua-es:flag-set', { key: f.key, value: cb.checked ? 'true' : 'false' }));
      row.appendChild(cb);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = f.preview;
      input.size = 1; // flex controls the real width
      input.addEventListener('change', () => send('ua-es:flag-set', { key: f.key, value: input.value }));
      row.appendChild(input);
    }
    box.appendChild(row);
  }
}

$('psave').addEventListener('click', async () => {
  if (disabledPage()) return;
  const input = $('pname');
  const res = await send('ua-es:profile-save', { name: input.value });
  if (res && res.saved) {
    input.value = '';
    setStatus('Profile saved.');
    renderProfiles();
  } else {
    setStatus(res && res.error === 'name-required' ? 'Enter a profile name first.' : 'Could not save on this page.');
  }
});

$('purge').addEventListener('click', async () => {
  if (disabledPage()) {
    setStatus('Open a normal http(s) page first.');
    return;
  }
  setStatus('Purging…');
  const res = await send('ua-es:purge');
  if (res) setStatus('Purged <b>' + res.sw + '</b> service worker(s), <b>' + res.caches + '</b> cache(s). Reloading…');
  else setStatus('Could not run on this page (try a normal http(s) page).');
});

$('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());

init().catch(() => setStatus('Popup failed to start — try reopening it.'));
