// Unit tests: pure env/URL logic from shared/envcore.js (imported as an ES
// module) plus the content-script helpers from content/env.js (loaded as a
// classic script against fake Storage objects). Run: node test/run-tests.js
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (detail ? ` :: ${detail}` : ''));
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

(async () => {
  const core = await import(pathToFileURL(path.join(ROOT, 'shared', 'envcore.js')));

  // ---------- normalizeOrigin ----------
  eq('origin: adds scheme', core.normalizeOrigin('example.com'), 'https://example.com');
  eq('origin: lowercases host', core.normalizeOrigin('https://Staging.Example.COM'), 'https://staging.example.com');
  eq('origin: keeps custom port', core.normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  eq('origin: strips default port', core.normalizeOrigin('https://x.com:443'), 'https://x.com');
  eq('origin: keeps https default', core.normalizeOrigin('http://x.com:80'), 'http://x.com');
  eq('origin: rejects path', core.normalizeOrigin('https://x.com/app'), null);
  eq('origin: rejects query', core.normalizeOrigin('https://x.com/?q=1'), null);
  eq('origin: rejects credentials', core.normalizeOrigin('https://u:p@x.com'), null);
  eq('origin: rejects ftp', core.normalizeOrigin('ftp://x.com'), null);
  eq('origin: rejects empty', core.normalizeOrigin('  '), null);
  eq('origin: rejects non-string', core.normalizeOrigin(null), null);
  eq('origin: rejects garbage', core.normalizeOrigin('not a url at all'), null);

  // ---------- urlOrigin / matchEnv ----------
  eq('urlOrigin: page url', core.urlOrigin('https://a.b/projects/42?tab=f#inv'), 'https://a.b');
  eq('urlOrigin: chrome page', core.urlOrigin('chrome://extensions'), null);
  eq('urlOrigin: junk', core.urlOrigin(''), null);
  const ENVS = core.DEFAULTS.envs;
  const local = core.matchEnv('http://localhost:3000/x', ENVS);
  check('matchEnv: finds local', !!local && local.id === 'env-local');
  eq('matchEnv: different port', core.matchEnv('http://localhost:5173/x', ENVS), null);
  check(
    'matchEnv: host case-insensitive',
    core.matchEnv('https://STAGING.example.com/x', ENVS) === core.matchEnv('https://staging.example.com/x', ENVS)
  );
  eq('matchEnv: non-http url', core.matchEnv('chrome://extensions', ENVS), null);
  eq('matchEnv: empty list', core.matchEnv('http://localhost:3000/', []), null);

  // ---------- switchUrl ----------
  eq(
    'switchUrl: keeps route',
    core.switchUrl('http://localhost:3000/projects/42?tab=finance#inv', ENVS[1]),
    'https://staging.example.com/projects/42?tab=finance#inv'
  );
  eq(
    'switchUrl: back to local',
    core.switchUrl('https://example.com/a/b?c=d', ENVS[0]),
    'http://localhost:3000/a/b?c=d'
  );
  eq('switchUrl: empty path becomes /', core.switchUrl('https://example.com', ENVS[0]), 'http://localhost:3000/');
  eq('switchUrl: bad env', core.switchUrl('https://example.com/x', { origin: '::::' }), null);
  eq('switchUrl: non-http page', core.switchUrl('chrome://extensions', ENVS[0]), null);
  eq('switchUrl: same env is stable', core.switchUrl('https://example.com/x#h', ENVS[2]), 'https://example.com/x#h');

  // ---------- nextEnv ----------
  eq('nextEnv: unmatched starts at first', core.nextEnv(ENVS, null) && core.nextEnv(ENVS, null).id, 'env-local');
  eq('nextEnv: cycles forward', core.nextEnv(ENVS, 'env-local').id, 'env-staging');
  eq('nextEnv: wraps around', core.nextEnv(ENVS, 'env-prod').id, 'env-local');
  eq('nextEnv: unknown id restarts', core.nextEnv(ENVS, 'nope').id, 'env-local');
  eq('nextEnv: empty list', core.nextEnv([], 'env-local'), null);
  eq('nextEnv: null list', core.nextEnv(null, null), null);
  const only = [{ id: 'a', name: 'A', origin: 'https://a.com', color: '#4ade80' }];
  check('nextEnv: single env returns itself', core.nextEnv(only, 'a') === only[0]);

  // ---------- validateEnv ----------
  const v1 = core.validateEnv({ name: ' QA ', origin: 'qa.example.com' }, []);
  check('validateEnv: trims + adds scheme', !v1.error && v1.env.origin === 'https://qa.example.com');
  check('validateEnv: generates id', !v1.error && /^env-/.test(v1.env.id));
  check('validateEnv: bad color falls back', v1.env && v1.env.color === core.COLOR_PRESETS[0]);
  check('validateEnv: keeps preset color', core.validateEnv({ name: 'X', origin: 'https://x.com', color: '#fbbf24' }, []).env.color === '#fbbf24');
  check('validateEnv: name required', !!core.validateEnv({ name: '', origin: 'https://x.com' }, []).error);
  check('validateEnv: long name rejected', !!core.validateEnv({ name: 'x'.repeat(25), origin: 'https://x.com' }, []).error);
  check('validateEnv: bad origin rejected', !!core.validateEnv({ name: 'X', origin: 'nope nop' }, []).error);
  const existing = [{ id: 'e1', name: 'Prod', origin: 'https://x.com', color: '#4ade80' }];
  check('validateEnv: duplicate origin rejected', !!core.validateEnv({ name: 'Also', origin: 'x.com' }, existing).error);
  check(
    'validateEnv: same id may keep origin (edit case)',
    !core.validateEnv({ id: 'e1', name: 'Prod', origin: 'https://x.com' }, existing).error
  );

  // ---------- flag value round-trips ----------
  const samples = ['true', 'false', '42', '3.14', '0', '', 'hello world', 'v1.2.3', 'true-ish'];
  for (const s of samples) {
    eq(`flag: round-trip ${JSON.stringify(s)}`, core.formatFlagValue(core.parseFlagValue(s)), s);
  }
  eq('flag: bool detected', core.parseFlagValue('true').type, 'bool');
  eq('flag: number detected', core.parseFlagValue('42').type, 'number');
  eq('flag: string detected', core.parseFlagValue('hello').type, 'string');
  eq('flag: empty is string', core.parseFlagValue('').type, 'string');
  eq('flag: version-ish stays string', core.parseFlagValue('v1.2.3').type, 'string');

  // ---------- content helpers against fake Storage ----------
  class FakeStorage {
    constructor(seed) {
      this.m = new Map(Object.entries(seed || {}));
    }
    get length() {
      return this.m.size;
    }
    key(i) {
      return [...this.m.keys()][i] ?? null;
    }
    getItem(k) {
      return this.m.has(k) ? this.m.get(k) : null;
    }
    setItem(k, v) {
      this.m.set(String(k), String(v));
    }
    removeItem(k) {
      this.m.delete(k);
    }
    clear() {
      this.m.clear();
    }
  }
  global.window = globalThis;
  global.localStorage = new FakeStorage({
    flag_newUi: 'true',
    feature_beta: '7',
    ff_experiment: 'control',
    unrelated: 'x'
  });
  global.sessionStorage = new FakeStorage({ session_token: 'abc' });
  require(path.join(ROOT, 'content', 'env.js'));
  const UES = window.UAEnvSwitcher;
  const UESCore = window.UAEnvSwitcherCore;
  check('content: namespaces exposed', !!UES && !!UESCore);

  const snap = UESCore.snapshotStores(global.localStorage, global.sessionStorage);
  eq('snapshot: captures ls', snap.ls.flag_newUi, 'true');
  eq('snapshot: captures ss', snap.ss.session_token, 'abc');
  eq('snapshot: full ls count', Object.keys(snap.ls).length, 4);

  global.localStorage.setItem('extra', '1');
  const setCount = UESCore.applyStores(global.localStorage, global.sessionStorage, snap);
  eq('apply: returns count set', setCount, 5);
  eq('apply: restores values', global.localStorage.getItem('feature_beta'), '7');
  eq('apply: removes stale keys', global.localStorage.getItem('extra'), null);

  const flags = UESCore.listFlags(['flag_', 'feature_']);
  eq('flags: filtered by prefix', flags.length, 2);
  check('flags: sorted', flags[0].key === 'feature_beta' && flags[1].key === 'flag_newUi');
  eq('flags: bool typed', flags.find((f) => f.key === 'flag_newUi').type, 'bool');
  eq('flags: on reflects bool', flags.find((f) => f.key === 'flag_newUi').on, true);
  eq('flags: number typed', flags.find((f) => f.key === 'feature_beta').type, 'number');
  const all = UESCore.listFlags([]);
  eq('flags: empty prefixes lists all', all.length, 4);
  global.localStorage.setItem('flag_long', 'z'.repeat(300));
  check(
    'flags: preview capped at 120',
    UESCore.listFlags(['flag_']).find((f) => f.key === 'flag_long').preview.length <= 121
  );

  const setRes = await UES.act('flag-set', { key: 'flag_newUi', value: 'false' });
  eq('act: flag-set ok', setRes.ok, true);
  eq('act: flag-set wrote', global.localStorage.getItem('flag_newUi'), 'false');
  eq('act: rejects empty key', (await UES.act('flag-set', { key: '', value: 'x' })).error, 'bad key');
  eq('act: unknown action', (await UES.act('nope')).error, 'unknown action');
  const purgeRes = await UES.act('purge'); // no SW/CacheStorage in Node: must degrade to zeros
  eq('act: purge degrades safely', purgeRes.sw + purgeRes.caches, 0);

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.log('FAIL: ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('Unit tests crashed:', e);
  process.exit(1);
});
