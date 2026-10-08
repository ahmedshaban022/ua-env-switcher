// Options page: environment CRUD with validation, flag-prefix editing,
// profile deletion, and reset-to-defaults. All writes go to
// chrome.storage.sync/local; the context menus rebuild themselves via the
// storage.onChanged listener in the service worker.
import {
  COLOR_PRESETS,
  DEFAULTS,
  MAX_ENVS,
  MAX_PROFILES,
  validateEnv
} from '../shared/envcore.js';

const $ = (id) => document.getElementById(id);

let envs = [];
let pickedColor = COLOR_PRESETS[0];
let editingId = null; // env id loaded into the form by "Edit"; null = adding new

function msg(text, isErr) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = isErr ? 'err' : '';
}

function loadEnv(env) {
  editingId = env.id;
  $('n-name').value = env.name;
  $('n-origin').value = env.origin;
  $('add').textContent = 'Update';
  pickedColor = COLOR_PRESETS.includes(env.color) ? env.color : COLOR_PRESETS[0];
  renderColors();
}

function renderColors() {
  const box = $('colors');
  box.textContent = '';
  for (const c of COLOR_PRESETS) {
    const b = document.createElement('button');
    b.className = c === pickedColor ? 'sel' : '';
    b.title = c;
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = c;
    b.appendChild(sw);
    b.addEventListener('click', () => {
      pickedColor = c;
      renderColors();
    });
    box.appendChild(b);
  }
}

function renderEnvs() {
  const box = $('envlist');
  box.textContent = '';
  for (const env of envs) {
    const row = document.createElement('div');
    row.className = 'envrow';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = env.color || COLOR_PRESETS[0];
    row.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'ename';
    name.textContent = env.name;
    row.appendChild(name);
    const origin = document.createElement('span');
    origin.className = 'eorigin';
    origin.textContent = env.origin;
    row.appendChild(origin);
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => loadEnv(env));
    row.appendChild(edit);
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', () => {
      envs = envs.filter((e) => e.id !== env.id);
      renderEnvs();
    });
    row.appendChild(del);
    box.appendChild(row);
  }
  if (!envs.length) {
    const empty = document.createElement('div');
    empty.className = 'note';
    empty.textContent = 'No environments yet — add one below.';
    box.appendChild(empty);
  }
}

function renderProfiles() {
  const box = $('profilelist');
  box.textContent = '';
  chrome.storage.local.get({ profiles: [] }).then(({ profiles }) => {
    const list = Array.isArray(profiles) ? profiles : [];
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'envrow';
      const name = document.createElement('span');
      name.className = 'ename';
      name.textContent = p.name;
      row.appendChild(name);
      const origin = document.createElement('span');
      origin.className = 'eorigin';
      origin.textContent = p.origin + ' — ' + new Date(p.createdAt || 0).toLocaleString();
      row.appendChild(origin);
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        const { profiles: cur } = await chrome.storage.local.get({ profiles: [] });
        await chrome.storage.local.set({ profiles: (cur || []).filter((x) => x && x.id !== p.id) });
        renderProfiles();
      });
      row.appendChild(del);
      box.appendChild(row);
    }
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'note';
      empty.textContent = 'No profiles saved yet. Use the popup on a page to save one.';
      box.appendChild(empty);
    }
    $('pcount').textContent = list.length + ' / ' + MAX_PROFILES + ' profile slots used.';
  });
}

async function init() {
  const s = await chrome.storage.sync.get({ envs: DEFAULTS.envs, flagPrefixes: DEFAULTS.flagPrefixes });
  envs = (Array.isArray(s.envs) ? s.envs : []).filter((e) => e && e.id);
  $('prefixes').value = (Array.isArray(s.flagPrefixes) ? s.flagPrefixes : []).join(', ');
  renderEnvs();
  renderColors();
  renderProfiles();
}

$('add').addEventListener('click', () => {
  if (envs.length >= MAX_ENVS && !editingId) {
    msg('At most ' + MAX_ENVS + ' environments are supported.', true);
    return;
  }
  const res = validateEnv(
    { id: editingId, name: $('n-name').value, origin: $('n-origin').value, color: pickedColor },
    envs
  );
  if (res.error) {
    msg(res.error, true);
    return;
  }
  const wasEdit = !!editingId;
  if (editingId) {
    envs = envs.map((e) => (e.id === editingId ? res.env : e));
  } else {
    envs.push(res.env);
  }
  editingId = null;
  $('add').textContent = 'Add';
  $('n-name').value = '';
  $('n-origin').value = '';
  renderEnvs();
  msg((wasEdit ? 'Environment updated — ' : 'Environment added — ') + 'remember to Save settings.');
});

$('save').addEventListener('click', async () => {
  const prefixes = $('prefixes')
    .value.split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .slice(0, 12);
  await chrome.storage.sync.set({ envs, flagPrefixes: prefixes });
  msg('Saved. The context menu and popup are updated immediately.');
});

$('reset').addEventListener('click', async () => {
  envs = DEFAULTS.envs.map((e) => ({ ...e }));
  await chrome.storage.sync.set({ envs, flagPrefixes: DEFAULTS.flagPrefixes.slice() });
  $('prefixes').value = DEFAULTS.flagPrefixes.join(', ');
  renderEnvs();
  msg('Settings reset to defaults.');
});

init().catch(() => msg('Failed to load settings.', true));
