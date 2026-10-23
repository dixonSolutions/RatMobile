// Toolbar popup (snapshots, per-site switch) and "pages are left as they are" guarantees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launch, freshProfile, swEval, sleep, ROOT, EXT_ID } from './harness.mjs';
import { serve } from './server.mjs';

let server;
let b;
const u = (n) => `${server.url}/${n}`;

before(async () => {
  server = await serve(join(ROOT, 'tests/fixtures'));
  b = await launch({ profile: freshProfile('popup'), width: 1152, height: 720 });
});
after(async () => { await b?.close(); server?.close(); });

test('pages are not shifted or injected into: tabs live in Chromium\'s own vertical tab strip', async () => {
  const page = await b.context.newPage();
  await page.goto(u('good.html'));
  await sleep(800);
  const r = await page.evaluate(() => ({
    margin: getComputedStyle(document.documentElement).marginLeft,
    iframes: document.querySelectorAll('iframe').length,
    extra: [...document.documentElement.children].map((e) => e.tagName),
  }));
  assert.deepEqual(r, { margin: '0px', iframes: 0, extra: ['HEAD', 'BODY'] });
  await page.close();
});

test('per-site switch: an excluded site is left completely alone', async () => {
  await swEval(b.context, async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, excludedHosts: ['127.0.0.1'] } });
  });
  const page = await b.context.newPage();
  await page.goto(u('wide-image.html'));
  await sleep(1200);
  const fixes = await page.evaluate(() => document.querySelectorAll('[data-rm-fix]').length);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(fixes, 0);
  assert.equal(sw, true, 'excluded page should keep its own layout');
  await swEval(b.context, async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, excludedHosts: [] } });
  });
  await page.reload();
  await sleep(1200);
  assert.ok((await page.evaluate(() => document.querySelectorAll('[data-rm-fix]').length)) > 0, 'fixes back after re-enabling');
  await page.close();
});

test('popup lists snapshots, saves one, and restores missing tabs', async () => {
  const work = await b.context.newPage();
  await work.goto(u('sticky.html'));
  await sleep(600);
  const popup = await b.context.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/ui/popup.html`);
  await popup.click('#save');
  await popup.waitForSelector('.snap');
  const before = await popup.locator('.snap').count();
  assert.ok(before >= 1);
  await work.close();
  await sleep(500);
  const restoreBtn = popup.locator('[data-restore]').first();
  await restoreBtn.click();
  await sleep(1500);
  const urls = await swEval(b.context, async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url));
  assert.ok(urls.includes(u('sticky.html')), `sticky.html not restored: ${urls.join(', ')}`);
  await popup.close();
});
