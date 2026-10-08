// Produces the Chrome Web Store 1280x800 screenshot: the demo page with
// the popup-style overlay mock visible (?shot=1).
// Run: NODE_PATH="<workspace>/.devdeps/node_modules" node tools/make-screenshot.js
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DEMO = path.join(__dirname, '..', 'test', 'demo');
const OUT = path.join(__dirname, '..', 'store', 'screenshot-1280x800.png');

async function main() {
  const { chromium } = require('playwright-core');
  const srv = http.createServer((req, res) => {
    const file = req.url.split('?')[0] === '/sw.js' ? path.join(DEMO, 'sw.js') : path.join(DEMO, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(data);
    });
  });
  await new Promise((resolve) => srv.listen(3899, '127.0.0.1', resolve));

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('http://127.0.0.1:3899/projects/42?tab=finance&shot=1', { waitUntil: 'load' });
    await page.waitForTimeout(400); // let the env chip / flags render settle
    const box = await page.locator('#mock').boundingBox();
    if (!box || box.width < 200 || box.height < 100) throw new Error('overlay mock not visible: ' + JSON.stringify(box));
    const chip = await page.textContent('#envchip');
    if (!chip) throw new Error('env chip missing');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT });
    console.log('store screenshot written:', OUT, '(overlay', Math.round(box.width) + 'x' + Math.round(box.height) + ')');
  } finally {
    await browser.close();
    srv.close();
  }
}

main().catch((e) => {
  console.error('make-screenshot crashed:', e);
  process.exit(1);
});
