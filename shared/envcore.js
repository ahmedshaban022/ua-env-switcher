// Pure environment/URL logic shared by the service worker, popup, options
// page, and unit tests. Nothing here touches chrome.* or the DOM, so every
// rule is verifiable in plain Node.

export const DEFAULTS = {
  envs: [
    { id: 'env-local', name: 'Local', origin: 'http://localhost:3000', color: '#4ade80' },
    { id: 'env-staging', name: 'Staging', origin: 'https://staging.example.com', color: '#fbbf24' },
    { id: 'env-prod', name: 'Production', origin: 'https://example.com', color: '#f87171' }
  ],
  flagPrefixes: ['flag_', 'feature_', 'ff_']
};

// Hard caps: settings stay small enough for chrome.storage.sync and the
// profile list can never grow unbounded in chrome.storage.local.
export const MAX_ENVS = 12;
export const MAX_PROFILES = 20;

export const COLOR_PRESETS = ['#4ade80', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#f87171', '#fbbf24', '#94a3b8'];

// Normalize a user-typed origin to a comparable "scheme://host[:port]".
// Tolerates a missing scheme; rejects anything that is not a clean http(s)
// origin (paths, queries, credentials, other protocols). Returns null on
// rejection so callers can show an error instead of guessing.
export function normalizeOrigin(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.pathname !== '/' || u.search || u.hash) return null;
  return u.origin === 'null' ? null : u.origin; // origin lowercases host and strips default ports
}

// Origin of an http(s) page URL, or null (chrome:// pages, empty strings…).
export function urlOrigin(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
}

// Which saved environment (if any) the URL is currently on. First matching
// origin wins; list order is user-controlled via the options page.
export function matchEnv(url, envs) {
  const origin = urlOrigin(url);
  if (!origin || !Array.isArray(envs)) return null;
  for (const env of envs) {
    if (env && normalizeOrigin(env.origin) === origin) return env;
  }
  return null;
}

// Rewrite `url` onto the environment's origin, keeping path, query, and
// hash exactly as they are — that route preservation is the whole point.
export function switchUrl(url, env) {
  const origin = normalizeOrigin(env && env.origin);
  const from = urlOrigin(url);
  if (!origin || !from) return null;
  const u = new URL(url);
  const t = new URL(origin);
  u.protocol = t.protocol;
  u.hostname = t.hostname;
  u.port = t.port; // '' clears a stale port from the previous environment
  return u.href;
}

// Next stop for the Alt+Shift+E cycle: saved-list order, wrapping around.
// A tab that matches no environment starts at the first one.
export function nextEnv(envs, currentId) {
  if (!Array.isArray(envs) || envs.length === 0) return null;
  const i = envs.findIndex((e) => e && e.id === currentId);
  return i === -1 ? envs[0] : envs[(i + 1) % envs.length];
}

// Validate + normalize an environment row from the options form. Returns
// {env} on success or {error} for display; never throws.
export function validateEnv(candidate, existing) {
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const origin = normalizeOrigin(candidate.origin);
  if (!name) return { error: 'Name is required.' };
  if (name.length > 24) return { error: 'Name is too long (max 24 characters).' };
  if (!origin) return { error: 'Origin must be an http(s) URL, e.g. https://staging.example.com' };
  if ((existing || []).some((e) => e && e.id !== candidate.id && normalizeOrigin(e.origin) === origin)) {
    return { error: 'That origin is already used by another environment.' };
  }
  const color = COLOR_PRESETS.includes(candidate.color) ? candidate.color : COLOR_PRESETS[0];
  const id = candidate.id || 'env-' + origin.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return { env: { id, name, origin, color } };
}

// localStorage only stores strings; flags round-trip through these two so
// "true"/"false" toggle as booleans and "42" edits as a number, while
// everything else stays an opaque string (never reinterpreted).
export function parseFlagValue(raw) {
  if (raw === 'true' || raw === 'false') return { type: 'bool', value: raw === 'true' };
  if (typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw))) {
    return { type: 'number', value: Number(raw) };
  }
  return { type: 'string', value: raw == null ? '' : String(raw) };
}

export function formatFlagValue(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (parsed.type === 'bool') return parsed.value ? 'true' : 'false';
  return String(parsed.value);
}
