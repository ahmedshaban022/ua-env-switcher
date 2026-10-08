// End-to-end tests: serves test/demo on two local ports (two fake
// "environments"), loads the real content bundle into a real Chrome page,
// and exercises purge / storage profiles / flag toggling against live
// ServiceWorker, CacheStorage, and localStorage APIs.
// Run: NODE_PATH="<workspace>/.devdeps/node_modules" node test/e2e.js
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(__dirname, 'demo');
const ENV_FILE = path.join(ROOT, 'content', 'env.js');

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function startServer(port) {
  const srv = http.createServer((req, res) => {
    const file = req.url.split('?')[0] === '/sw.js' ? path.join(DEMO, 'sw.js') : path.join(DEMO, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] });
      res.end(data);
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function main() {
  const { chromium } = require('playwright-core');
  const envcore = await import(pathToFileURL(path.join(ROOT, 'shared', 'envcore.js')));

  const PORT_A = 3771; // "local"
  const PORT_B = 3772; // "staging"
  const srvA = await startServer(PORT_A);
  const srvB = await startServer(PORT_B);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT_A}/projects/42?tab=finance#inv`, { waitUntil: 'load' });
    await page.addScriptTag({ path: ENV_FILE }); // exactly what the extension injects

    // ---------- 1. environment switch keeps the exact route ----------
    const envs = [
      { id: 'local', name: 'Local', origin: `http://127.0.0.1:${PORT_A}`, color: '#4ade80' },
      { id: 'staging', name: 'Staging', origin: `http://127.0.0.1:${PORT_B}`, color: '#fbbf24' }
    ];
    check('e2e: page matched local env', envcore.matchEnv(page.url(), envs).id === 'local');
    const target = envcore.switchUrl(page.url(), envs[1]);
    await page.goto(target, { waitUntil: 'load' });
    await page.addScriptTag({ path: ENV_FILE }); // navigation wiped the first injection
    check(
      'e2e: switchUrl kept route',
      page.url() === `http://127.0.0.1:${PORT_B}/projects/42?tab=finance#inv`,
      page.url()
    );
    check('e2e: demo page renders kept path', (await page.textContent('#path')).includes('/projects/42?tab=finance#inv'));

    // ---------- 2. flag listing + toggling ----------
    const flagsRes = await page.evaluate(() =>
      window.UAEnvSwitcher.act('flags', { prefixes: ['flag_', 'feature_', 'ff_'] })
    );
    const flagNames = flagsRes.flags.map((f) => f.key);
    check('e2e: flags listed', flagNames.join(',') === 'feature_beta,ff_experiment,flag_newUi', flagNames.join(','));
    check('e2e: bool flag on', flagsRes.flags.find((f) => f.key === 'flag_newUi').on === true);
    await page.evaluate(() => window.UAEnvSwitcher.act('flag-set', { key: 'flag_newUi', value: 'false' }));
    check('e2e: flag toggled off', (await page.evaluate(() => localStorage.getItem('flag_newUi'))) === 'false');

    // ---------- 3. storage profile snapshot → mutate → apply ----------
    const snap = await page.evaluate(() => window.UAEnvSwitcher.act('ls-snapshot'));
    check('e2e: snapshot has ls+ss', snap.ls && snap.ss && snap.ls.ua_role === 'admin');
    await page.evaluate(() => {
      localStorage.setItem('ua_role', 'viewer');
      localStorage.setItem('ua_token', 'tok-viewer-9');
      localStorage.setItem('extra_junk', '1');
    });
    const applyRes = await page.evaluate((d) => window.UAEnvSwitcher.act('ls-apply', d), snap);
    check('e2e: apply set count', applyRes.set === 5, `got ${applyRes.set}`); // 5 ls keys, empty ss
    const after = await page.evaluate(() => ({
      role: localStorage.getItem('ua_role'),
      token: localStorage.getItem('ua_token'),
      junk: localStorage.getItem('extra_junk')
    }));
    check('e2e: apply restored values', after.role === 'admin' && after.token === 'tok-admin-1');
    check('e2e: apply removed stale key', after.junk === null);

    // ---------- 4. SW + CacheStorage purge ----------
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js'));
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready; // wait for demo-v1 cache from install
      const c = await caches.open('demo-manual'); // second cache to prove enumeration
      await c.put(new Request('/manual'), new Response('x'));
    });
    const beforeRegs = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length));
    check('e2e: one SW registered', beforeRegs === 1, `got ${beforeRegs}`);
    const purge = await page.evaluate(() => window.UAEnvSwitcher.act('purge'));
    check('e2e: purged 1 SW', purge.sw === 1, JSON.stringify(purge));
    check('e2e: purged 2 caches', purge.caches === 2, JSON.stringify(purge));
    const afterRegs = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length));
    const afterCaches = await page.evaluate(() => caches.keys());
    check('e2e: no SW left', afterRegs === 0);
    check('e2e: no caches left', afterCaches.length === 0, afterCaches.join(','));

    // ---------- 5. idempotent re-injection ----------
    await page.addScriptTag({ path: ENV_FILE });
    const again = await page.evaluate(() => window.UAEnvSwitcher.act('flags', { prefixes: ['flag_'] }));
    check('e2e: re-inject stays idempotent', again.flags.length === 1);

    console.log(`${pass} passed, ${fail} failed`);
  } finally {
    await browser.close();
    srvA.close();
    srvB.close();
  }
  if (fail) {
    for (const f of failures) console.log('FAIL: ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
