// Dock + slide-over overlay, driven with real touch and mouse input through CDP.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launch, freshProfile, swEval, sleep, ROOT, EXT_ID } from './harness.mjs';
import { serve } from './server.mjs';

let server;
let b;
let page;
let cdp;
const u = (n) => `${server.url}/${n}`;

before(async () => {
  server = await serve(join(ROOT, 'tests/fixtures'));
  b = await launch({ profile: freshProfile('dock'), width: 1440, height: 960 });
  page = (await b.context.pages())[0] || (await b.context.newPage());
  await swEval(b.context, async (urls) => {
    const [w] = await chrome.windows.getAll();
    for (const url of urls) await chrome.tabs.create({ windowId: w.id, url, active: false });
  }, [u('sticky.html'), u('wide-image.html'), u('pre-code.html')]);
  await page.goto(u('good.html'));
  await page.goto(u('fixed-header.html')); // history entry, to detect accidental "back" swipes
  await page.bringToFront();
  cdp = await b.context.newCDPSession(page);
});
after(async () => { await b?.close(); server?.close(); });

const dockFrame = async () => {
  for (let i = 0; i < 50; i++) {
    const f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://`) && fr.url().includes('dock.html'));
    if (f) { await f.waitForSelector('#strip [data-tab]'); return f; }
    await sleep(100);
  }
  throw new Error('dock frame not found');
};
const isOpen = async () => (await dockFrame()).evaluate(() => document.body.classList.contains('open'));
const frameWidth = () => page.evaluate(() => document.getElementById('ratmobile-dock').getBoundingClientRect().width);
const activeTabUrl = () => swEval(b.context, async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);

async function touchSwipe(x0, y0, x1, y1, steps = 12, stepMs = 16) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
    await sleep(stepMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
}
async function tap(x, y, hold = 0) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(hold || 40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
}

describe('dock', () => {
  test('dock is injected, page reserved, icons listed with active tab marked', async () => {
    const f = await dockFrame();
    assert.equal(Math.round(await frameWidth()), 56);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).marginLeft), '56px');
    const n = await f.evaluate(() => document.querySelectorAll('#strip [data-tab]').length);
    const tabs = await swEval(b.context, async () => (await chrome.tabs.query({ lastFocusedWindow: true })).length);
    assert.equal(n, tabs);
    assert.equal(await f.evaluate(() => document.querySelectorAll('#strip .active').length), 1);
  });

  test('pinned tabs are shown first, above a separator', async () => {
    await swEval(b.context, async (url) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url === url);
      await chrome.tabs.update(t.id, { pinned: true });
    }, u('pre-code.html'));
    await sleep(400);
    const f = await dockFrame();
    const order = await f.evaluate(() => [...document.querySelectorAll('#strip > *')].map((e) => (e.classList.contains('sep') ? 'SEP' : e.title)));
    assert.equal(order[1], 'SEP', JSON.stringify(order));
  });

  test('tapping a dock icon switches tab', async () => {
    const f = await dockFrame();
    const { y, id } = await f.evaluate(() => { const el = [...document.querySelectorAll('#strip [data-tab]')].find((e) => !e.classList.contains('active')); const r = el.getBoundingClientRect(); return { y: r.top + r.height / 2, id: +el.dataset.tab }; });
    await tap(28, y);
    const active = await swEval(b.context, async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    assert.equal(active, id);
    await swEval(b.context, async (url) => { const t = (await chrome.tabs.query({})).find((x) => x.url === url); await chrome.tabs.update(t.id, { active: true }); }, page.url());
    await page.bringToFront();
    await sleep(300);
  });

  test('swipe right from the dock opens the overlay, without navigating back', async () => {
    const url = page.url();
    await touchSwipe(20, 500, 420, 505);
    assert.equal(await isOpen(), true);
    assert.ok((await frameWidth()) > 1000, 'frame expanded to cover the page');
    assert.equal(page.url(), url, 'swipe must not trigger history navigation');
    const f = await dockFrame();
    const rows = await f.evaluate(() => document.querySelectorAll('#panel .row[data-tab]').length);
    const pins = await f.evaluate(() => document.querySelectorAll('#panel .pin[data-tab]').length);
    assert.ok(rows >= 3, `rows ${rows}`);
    assert.equal(pins, 1);
  });

  test('swipe left on the overlay closes it back to the dock', async () => {
    await touchSwipe(380, 600, 20, 600);
    assert.equal(await isOpen(), false);
    await sleep(300);
    assert.equal(Math.round(await frameWidth()), 56);
  });

  test('short, slow drag snaps back closed (a fast flick would open)', async () => {
    await touchSwipe(20, 500, 70, 500, 5, 80);
    assert.equal(await isOpen(), false);
    await sleep(300);
    assert.equal(Math.round(await frameWidth()), 56);
  });

  test('menu button opens; tapping a tab row switches tab and closes the overlay', async () => {
    await tap(28, 30);
    assert.equal(await isOpen(), true);
    const f = await dockFrame();
    const target = await f.evaluate((want) => { const el = [...document.querySelectorAll('#panel .row[data-tab]')].find((r) => r.title.includes(want)); const r = el.getBoundingClientRect(); return { x: r.left + 100, y: r.top + r.height / 2 }; }, 'wide-image.html');
    await tap(target.x, target.y);
    assert.match(await activeTabUrl(), /wide-image\.html/);
    await swEval(b.context, async (url) => { const t = (await chrome.tabs.query({})).find((x) => x.url === url); await chrome.tabs.update(t.id, { active: true }); }, page.url());
    await page.bringToFront();
    await sleep(400);
    assert.equal(await isOpen(), false);
  });

  test('tapping the scrim closes; keyboard command toggles', async () => {
    await swEval(b.context, async (url) => { const t = (await chrome.tabs.query({})).find((x) => x.url === url); await chrome.tabs.sendMessage(t.id, { type: 'overlay:toggle' }, { frameId: 0 }); }, page.url());
    await sleep(400);
    assert.equal(await isOpen(), true);
    await tap((await page.evaluate(() => innerWidth)) - 60, 400);
    assert.equal(await isOpen(), false);
  });

  test('long-press a row -> Pin to top', async () => {
    await tap(28, 30);
    const f = await dockFrame();
    const pos = await f.evaluate(() => { const el = [...document.querySelectorAll('#panel .row[data-tab]')].find((r) => r.title.includes('sticky.html')); const r = el.getBoundingClientRect(); return { x: r.left + 100, y: r.top + r.height / 2 }; });
    await tap(pos.x, pos.y, 600);
    await f.waitForSelector('.sheet [data-a="pin"]');
    const btn = await f.evaluate(() => { const r = document.querySelector('.sheet [data-a="pin"]').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; });
    await tap(btn.x, btn.y);
    const pinned = await swEval(b.context, async (url) => (await chrome.tabs.query({})).find((x) => x.url === url).pinned, u('sticky.html'));
    assert.equal(pinned, true);
    await sleep(300);
    assert.equal(await f.evaluate(() => document.querySelectorAll('#panel .pin[data-tab]').length), 2);
  });

  test('mouse-drag a row into Pinned pins it', async () => {
    const f = await dockFrame();
    const from = await f.evaluate(() => { const el = [...document.querySelectorAll('#panel .row[data-tab]')].find((r) => r.title.includes('wide-image.html')); const r = el.getBoundingClientRect(); return { x: r.left + 120, y: r.top + r.height / 2 }; });
    const to = await f.evaluate(() => { const r = document.querySelector('#panel .pins').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 20 }; });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) { await page.mouse.move(from.x, from.y + ((to.y - from.y) * i) / 15); await sleep(16); }
    await page.mouse.up();
    await sleep(500);
    const pinned = await swEval(b.context, async (url) => (await chrome.tabs.query({})).find((x) => x.url === url).pinned, u('wide-image.html'));
    assert.equal(pinned, true);
  });

  test('search filters tabs', async () => {
    const f = await dockFrame();
    await f.fill('.tv-search', 'pre-code');
    await sleep(200);
    const titles = await f.evaluate(() => [...document.querySelectorAll('#panel [data-tab]')].map((e) => e.title));
    assert.equal(titles.length, 1, JSON.stringify(titles));
    await f.press('.tv-search', 'Escape');
    await sleep(400);
    assert.equal(await isOpen(), false);
  });

  test('sessions view lists snapshots and can save one', async () => {
    await tap(28, 30);
    const f = await dockFrame();
    await f.click('[data-act="view"]');
    await f.waitForSelector('[data-snap-save]');
    await f.click('[data-snap-save]');
    await f.waitForSelector('.snap');
    assert.ok((await f.evaluate(() => document.querySelectorAll('.snap').length)) >= 1);
    await f.press('.tv-search', 'Escape').catch(() => {});
    await page.keyboard.press('Escape');
  });

  test('new tab page has the dock too', async () => {
    const p = await b.context.newPage();
    await p.goto('chrome://newtab/');
    await sleep(1200);
    assert.ok(p.url().startsWith(`chrome-extension://${EXT_ID}/ui/newtab.html`) || p.url().startsWith('chrome://newtab'), p.url());
    const has = await p.evaluate(() => !!document.getElementById('ratmobile-dock'));
    assert.equal(has, true);
    await p.close();
  });
});
