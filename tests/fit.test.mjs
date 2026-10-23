// Fit engine: no fixture may leave the page horizontally scrollable, at tablet landscape, portrait and split widths.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launch, freshProfile, swEval, sleep, ROOT } from './harness.mjs';
import { serve } from './server.mjs';

const SIZES = (process.env.SIZES || '1152x720,768x1100,576x720,1440x960').split(',').map((s) => s.split('x').map(Number));

let server;
before(async () => { server = await serve(join(ROOT, 'tests/fixtures')); });
after(() => server?.close());

async function zoomOf(context, url) {
  return swEval(context, async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u);
    return t ? chrome.tabs.getZoom(t.id) : null;
  }, url);
}

// Wait until the page has settled (no horizontal overflow change for a while).
async function settle(page, ms = 900) {
  let last = '';
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const s = await page.evaluate(() => `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}/${innerWidth}`).catch(() => '');
    if (s !== last) { last = s; stableSince = Date.now(); }
    else if (Date.now() - stableSince > ms) return;
    await sleep(100);
  }
}

// How far the page can end up scrolled sideways (checked a moment later, as a user would see it).
async function canScrollX(page) {
  return page.evaluate(async () => {
    const y = scrollY;
    scrollTo(100000, y);
    await new Promise((r) => setTimeout(r, 120));
    const moved = scrollX;
    scrollTo(0, y);
    return moved;
  });
}

for (const [w, h] of SIZES) {
  describe(`fit @ ${w}x${h}`, () => {
    let b;
    let page;
    before(async () => {
      b = await launch({ profile: freshProfile(`fit-${w}`), width: w, height: h });
      page = await b.context.newPage();
    });
    after(async () => b?.close());

    const open = async (name) => {
      await page.goto(`${server.url}/${name}`);
      await settle(page);
      return page.url();
    };

    test('well-behaved page is left alone', async () => {
      const url = await open('good.html');
      assert.equal(await canScrollX(page), 0);
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-rm-fix]').length), 0);
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-rm-clip')), false);
      assert.equal(await zoomOf(b.context, url), 1);
    });

    test('page that already hides sideways overflow is left alone', async () => {
      const url = await open('site-clipped.html');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-rm-fix]').length), 0);
      assert.equal(await zoomOf(b.context, url), 1);
    });

    for (const name of ['wide-image.html', 'long-word.html', 'pre-code.html', 'wide-table.html', 'vw.html', 'flex-row.html', 'sticky.html']) {
      test(`${name}: reflowed, no sideways scroll, no zoom`, async () => {
        const url = await open(name);
        assert.equal(await canScrollX(page), 0, 'page scrolls horizontally');
        assert.equal(await zoomOf(b.context, url), 1, 'responsive page should not be zoomed');
      });
    }

    test('wide image is scaled into the column', async () => {
      await open('wide-image.html');
      const r = await page.evaluate(() => { const i = document.getElementById('img').getBoundingClientRect(); return { right: i.right, cw: document.documentElement.clientWidth + parseFloat(getComputedStyle(document.documentElement).marginLeft) }; });
      assert.ok(r.right <= r.cw + 1, `image right ${r.right} > ${r.cw}`);
    });

    test('off-canvas drawer is clipped, not zoomed', async () => {
      const url = await open('offcanvas.html');
      assert.equal(await canScrollX(page), 0);
      assert.equal(await zoomOf(b.context, url), 1);
    });

    test('sticky header still sticks after fixes', async () => {
      await open('sticky.html');
      await page.evaluate(() => scrollTo(0, 600));
      await sleep(100);
      const top = await page.evaluate(() => document.getElementById('sticky').getBoundingClientRect().top);
      assert.equal(Math.round(top), 0);
    });

    test('content added later is caught', async () => {
      await open('dynamic.html');
      await page.waitForFunction(() => document.title === 'Dynamic loaded');
      await sleep(600);
      await settle(page);
      assert.equal(await canScrollX(page), 0);
    });

    for (const [name, id] of [['min-width-app.html', 'aside'], ['fixed-grid-app.html', 'c']]) {
      test(`${name}: min-width app is zoomed to fit`, async () => {
        const url = await open(name);
        await settle(page, 1200);
        const z = await zoomOf(b.context, url);
        const need = await page.evaluate(() => (document.documentElement.clientWidth / document.documentElement.scrollWidth));
        if (z <= 0.3 + 0.005 && need < 0.99) {
          // Would need less than the 30% readability floor: stop there, keep the rest reachable (never clip content).
          assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-rm-clip')), false, 'content clipped');
          return;
        }
        assert.equal(await canScrollX(page), 0, 'page scrolls horizontally');
        assert.ok(z < 1 && z >= 0.3, `zoom ${z}`);
        const r = await page.evaluate((i) => ({ right: document.getElementById(i).getBoundingClientRect().right, iw: innerWidth }), id);
        assert.ok(r.right <= r.iw + 2, `#${id} right ${r.right} beyond viewport ${r.iw}`);
      });
    }

    test('fixed header and rail move out from under the dock', async () => {
      await open('fixed-header.html');
      const get = () => page.evaluate(() => Object.fromEntries(['burger', 'rail', 'bar', 'later'].map((i) => { const r = document.getElementById(i).getBoundingClientRect(); return [i, { left: r.left, right: r.right }]; })));
      let r = await get();
      assert.ok(r.burger.left >= 56, `burger at ${r.burger.left}`);
      assert.ok(r.rail.left >= 56, `rail at ${r.rail.left}`);
      assert.ok(r.bar.right <= w + 1, `bar overflows: ${r.bar.right}`);
      await page.evaluate(() => document.getElementById('later').classList.add('fixed'));
      await sleep(400);
      r = await get();
      assert.ok(r.later.left >= 56, `late-fixed element at ${r.later.left}`);
      assert.equal(await canScrollX(page), 0);
    });

    test('quirks-mode page is reflowed, not zoomed', async () => {
      const url = await open('quirks-table.html');
      assert.equal(await canScrollX(page), 0);
      assert.equal(await zoomOf(b.context, url), 1);
    });

    test('data table is not crushed: it scrolls inside itself instead', async () => {
      const url = await open('data-table.html');
      assert.equal(await canScrollX(page), 0);
      assert.equal(await zoomOf(b.context, url), 1);
      const minCell = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#t td')].map((c) => c.clientWidth)));
      assert.ok(minCell >= 40, `cells crushed to ${minCell}px`);
    });

    test('absolutely positioned app root is not hidden under the dock', async () => {
      await open('abs-left.html');
      assert.ok((await page.evaluate(() => document.getElementById('app').getBoundingClientRect().left)) >= 56);
    });

    test('fixed bar whose left the site rewrites gets shifted again, and stays inside the window', async () => {
      await open('fixed-rewrite.html');
      await page.waitForFunction(() => document.title === 'rewritten');
      await sleep(300);
      const r = await page.evaluate(() => { const b = document.getElementById('bar').getBoundingClientRect(); return { left: b.left, right: b.right, iw: innerWidth }; });
      assert.ok(r.left >= 56, `bar at ${r.left}`);
      assert.ok(r.right <= r.iw + 1, `bar sticks out: ${r.right} > ${r.iw}`);
    });

    test('element made fixed by a late stylesheet is shifted', async () => {
      await open('late-css.html');
      await page.waitForFunction(() => document.title === 'late');
      await sleep(500);
      assert.ok((await page.evaluate(() => document.getElementById('menu').getBoundingClientRect().left)) >= 56);
    });

    test('full-bleed (100vw, negative margin) block stays out from under the dock', async () => {
      await open('bleed.html');
      assert.equal(await canScrollX(page), 0);
      const r = await page.evaluate(() => document.getElementById('bleed').getBoundingClientRect());
      assert.ok(r.left >= 55, `bleed starts at ${r.left}`);
    });

    test('site that hides overflow: our shift does not push its header items off-screen', async () => {
      const url = await open('body-hidden-vw.html');
      const r = await page.evaluate(() => ({ right: document.getElementById('rightitem').getBoundingClientRect().right, iw: document.documentElement.clientWidth + 56 }));
      assert.ok(r.right <= r.iw + 1, `header item cut off: ${r.right} > ${r.iw}`);
      assert.equal(await zoomOf(b.context, url), 1);
    });

    test('zoom goes back up when a temporary overflow disappears', async () => {
      const url = await open('temp-overflow.html');
      await settle(page, 600);
      assert.ok((await zoomOf(b.context, url)) < 1, 'zoomed out for the wide ad');
      await page.waitForFunction(() => document.title === 'ad gone');
      await sleep(1500);
      await settle(page);
      assert.equal(await zoomOf(b.context, url), 1);
    });

    test('user zoom wins over auto-fit', async () => {
      const url = await open('min-width-app.html');
      await settle(page, 1200);
      await sleep(2100);
      // Simulate the user pressing Ctrl+= : a zoom change the extension did not make.
      await swEval(b.context, async (u) => {
        const t = (await chrome.tabs.query({})).find((x) => x.url === u);
        await chrome.tabs.setZoom(t.id, 1.25);
      }, url);
      await sleep(1500);
      assert.equal(await zoomOf(b.context, url), 1.25);
    });
  });
}
