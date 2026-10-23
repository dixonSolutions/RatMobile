// Real-site sweep for the fit engine (standalone script, not a node:test file).
//
//   node tests/sites.mjs                       # extension on, all SIZES
//   SIZES=720x960 BASELINE=1 node tests/sites.mjs   # extension disabled (baseline overflow)
//   ONLY=hn,bbc node tests/sites.mjs           # subset of sites
//
// Env: SIZES (default 1440x960,960x1440,720x960), EXT (extension dir, default dist/ratmobile),
//      OUT (output dir for screenshots + results JSON), BASELINE=1, ONLY=name,name, PROFILE_PREFIX.
// For every site x size it records whether a user could still scroll sideways, the root's
// scrollWidth/clientWidth, browser zoom, clip state, data-rm-fix counts by kind, dock presence,
// the elements still sticking out, what sits under the dock, and a JPEG screenshot.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, freshProfile, swEval, sleep, ROOT } from './harness.mjs';

export const SITES = [
  ['wiki-gdp', 'https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)'],
  ['wiki-python', 'https://en.wikipedia.org/wiki/Python_(programming_language)'],
  ['wiki-comparison', 'https://en.wikipedia.org/wiki/Comparison_of_programming_languages'],
  ['github-repo', 'https://github.com/torvalds/linux'],
  ['github-code', 'https://github.com/python/cpython/blob/main/Lib/json/encoder.py'],
  ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/CSS/grid-template-columns'],
  ['stackoverflow', 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array'],
  ['hn', 'https://news.ycombinator.com/'],
  ['hn-item', 'https://news.ycombinator.com/item?id=8863'],
  ['old-reddit', 'https://old.reddit.com/r/programming/'],
  ['reddit', 'https://www.reddit.com/r/programming/'],
  ['bbc', 'https://www.bbc.com/news'],
  ['nytimes', 'https://www.nytimes.com/'],
  ['verge', 'https://www.theverge.com/'],
  ['amazon', 'https://www.amazon.com/dp/B08N5WRWNW'],
  ['ebay', 'https://www.ebay.com/'],
  ['craigslist', 'https://sfbay.craigslist.org/search/sss'],
  ['python-docs', 'https://docs.python.org/3/library/functions.html'],
  ['kernel-org', 'https://www.kernel.org/'],
  ['lwn', 'https://lwn.net/'],
  ['archwiki', 'https://wiki.archlinux.org/title/Installation_guide'],
  ['gitlab', 'https://gitlab.com/gitlab-org/gitlab-runner'],
  ['npm', 'https://www.npmjs.com/package/react'],
  ['crates', 'https://crates.io/crates/serde'],
  ['docs-rs', 'https://docs.rs/tokio/latest/tokio/'],
  ['google-search', 'https://www.google.com/search?q=css+overflow+hidden&hl=en'],
  ['google-maps', 'https://www.google.com/maps/@52.2297,21.0122,13z?hl=en'],
  ['youtube', 'https://www.youtube.com/'],
  ['discourse', 'https://meta.discourse.org/'],
  ['spacejam', 'https://www.spacejam.com/1996/'],
  ['berkshire', 'https://www.berkshirehathaway.com/'],
  ['cern-www', 'http://info.cern.ch/hypertext/WWW/TheProject.html'],
  ['grafana', 'https://play.grafana.org/'],
  ['excalidraw', 'https://excalidraw.com/'],
  ['datatables', 'https://datatables.net/examples/basic_init/zero_configuration.html'],
  ['w3schools-table', 'https://www.w3schools.com/css/css_table.asp'],
  ['gnu-manual', 'https://www.gnu.org/software/bash/manual/bash.html'],
  ['imdb', 'https://www.imdb.com/title/tt0111161/'],
  // Second batch: pages that are known to be wide, fixed-width, quirks-mode, or app-like.
  ['wiki-browsers', 'https://en.wikipedia.org/wiki/Comparison_of_web_browsers'],
  ['w3c-propidx', 'https://www.w3.org/TR/CSS2/propidx.html'],
  ['caniuse', 'https://caniuse.com/css-grid'],
  ['timeanddate', 'https://www.timeanddate.com/worldclock/'],
  ['sqlite', 'https://www.sqlite.org/lang_select.html'],
  ['php-manual', 'https://www.php.net/manual/en/function.array-map.php'],
  ['bugzilla', 'https://bugzilla.mozilla.org/buglist.cgi?quicksearch=overflow&limit=50'],
  ['jsfiddle', 'https://jsfiddle.net/'],
  ['godbolt', 'https://godbolt.org/'],
  ['regex101', 'https://regex101.com/'],
  ['drudge', 'https://www.drudgereport.com/'],
  ['lkml', 'https://lkml.org/'],
  ['rfc9110', 'https://www.rfc-editor.org/rfc/rfc9110.html'],
  ['osm', 'https://www.openstreetmap.org/'],
  ['sourcehut', 'https://git.sr.ht/~sircmpwn/scdoc/tree/master/item/src/main.c'],
  ['debian-lists', 'https://lists.debian.org/debian-devel/2024/01/threads.html'],
  ['apache-dist', 'https://archive.apache.org/dist/'],
  ['dolekemp96', 'http://www.dolekemp96.org/main.htm'],
  ['wayback-yahoo', 'https://web.archive.org/web/19961017235908/http://www2.yahoo.com/'],
  ['lichess', 'https://lichess.org/'],
  ['phpmyadmin', 'https://demo.phpmyadmin.net/master-config/'],
];

const SIZES = (process.env.SIZES || '1440x960,960x1440,720x960').split(',').map((s) => s.split('x').map(Number));
const BASELINE = !!process.env.BASELINE;
const OUT = process.env.OUT || join(ROOT, 'test-results/sites');
const EXT = process.env.EXT || join(ROOT, 'dist/ratmobile');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PREFIX = process.env.PROFILE_PREFIX || 'sweep';
// Optional: UA=<string> overrides the HeadlessChrome user agent (some sites block it; others, e.g. Cloudflare, then challenge).
const UA = process.env.UA;
mkdirSync(OUT, { recursive: true });

const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout: ${what}`); })]);

async function settle(page, ms = 900, max = 8000) {
  let last = '';
  let since = Date.now();
  const start = Date.now();
  while (Date.now() - start < max) {
    const s = await page.evaluate(() => `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}/${innerWidth}`).catch(() => '');
    if (s !== last) { last = s; since = Date.now(); } else if (Date.now() - since > ms) return;
    await sleep(100);
  }
}

// Everything measured inside the page.
function measure() {
  return (async () => {
    const de = document.documentElement;
    const desc = (el) => {
      if (!el || !el.tagName) return String(el);
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
      if (cls.length) s += '.' + cls.join('.');
      return s;
    };
    const y = scrollY;
    scrollTo(100000, y);
    await new Promise((r) => setTimeout(r, 150));
    const scrollXAfter = scrollX;
    scrollTo(0, y);
    await new Promise((r) => requestAnimationFrame(r));
    // In quirks mode the root's clientWidth is the html box (minus our margin), not the viewport.
    const quirks = document.compatMode === 'BackCompat';
    const se = document.scrollingElement || de;
    const cw = quirks && document.body ? document.body.clientWidth : de.clientWidth;
    const fixes = {};
    const fixSamples = [];
    for (const el of document.querySelectorAll('[data-rm-fix]')) {
      const kinds = el.getAttribute('data-rm-fix').split(' ');
      for (const k of kinds) fixes[k] = (fixes[k] || 0) + 1;
      if (fixSamples.length < 25) {
        const r = el.getBoundingClientRect();
        fixSamples.push(`${desc(el)} [${kinds.join(',')}] w=${Math.round(r.width)} l=${Math.round(r.left)}`);
      }
    }
    // Root culprits still past the right edge (ignoring the clip): what a user loses or can scroll to.
    const offenders = [];
    let maxRight = 0;
    const stack = [[document.body, false]];
    let n = 0;
    while (stack.length && n++ < 30000) {
      const [el, pOver] = stack.pop();
      if (!el || el.id === 'ratmobile-dock') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      const over = r.right + scrollX > cw + 1 && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
      if (over && !pOver) {
        maxRight = Math.max(maxRight, r.right);
        if (offenders.length < 12) offenders.push(`${desc(el)} pos=${cs.position} l=${Math.round(r.left)} r=${Math.round(r.right)} w=${Math.round(r.width)} fix=${el.getAttribute('data-rm-fix') || '-'}`);
      }
      if (cs.overflowX !== 'visible' && el !== document.body) continue;
      for (let i = el.children.length - 1; i >= 0; i--) stack.push([el.children[i], pOver || over]);
    }
    // What is right under the dock strip (x=28), besides the dock itself.
    const underDock = [];
    for (const yy of [10, 40, 80, 150, 300, Math.round(innerHeight / 2), innerHeight - 30]) {
      const els = document.elementsFromPoint(28, yy).filter((e) => e.id !== 'ratmobile-dock');
      const top = els[0];
      if (top && top !== de && top !== document.body) {
        const cs = getComputedStyle(top);
        const txt = (top.innerText || top.getAttribute('aria-label') || '').trim().slice(0, 30).replace(/\s+/g, ' ');
        underDock.push(`y${yy}:${desc(top)}(${cs.position}${txt ? ' "' + txt + '"' : ''})`);
      }
    }
    return {
      title: document.title.slice(0, 80),
      url: location.href,
      scrollX: scrollXAfter,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      viewportWidth: cw,
      seScrollWidth: se.scrollWidth,
      quirks,
      innerWidth,
      bodyScrollWidth: document.body ? document.body.scrollWidth : null,
      clip: de.hasAttribute('data-rm-clip'),
      dock: !!document.getElementById('ratmobile-dock'),
      marginLeft: getComputedStyle(de).marginLeft,
      viewportMeta: document.querySelector('meta[name="viewport" i]')?.content || null,
      fixes,
      fixSamples,
      offenders,
      hiddenRight: Math.round(maxRight - cw),
      underDock,
    };
  })();
}

async function zoomOf(context, url) {
  return swEval(context, async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u) || tabs.find((x) => x.active);
    return t ? chrome.tabs.getZoom(t.id) : null;
  }, url).catch(() => null);
}

async function runSite(b, name, url, w, h) {
  const page = await b.context.newPage();
  const tag = `${name}-${BASELINE ? 'base-' : ''}${w}x${h}`;
  const rec = { name, size: `${w}x${h}`, baseline: BASELINE };
  try {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
      rec.navError = String(e.message).split('\n')[0];
      // Heavy pages may never fire 'load': measure whatever is there.
    }
    await sleep(3000);
    // Interstitials (Cloudflare, consent redirects) navigate again: wait for the final document.
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await settle(page);
    Object.assign(rec, await withTimeout(page.evaluate(measure), 15000, 'measure'));
    if (!BASELINE) rec.zoom = await zoomOf(b.context, page.url());
    await withTimeout(page.screenshot({ path: join(OUT, `${tag}.png`).replace(/\.png$/, '.jpg'), type: 'jpeg', quality: 50, scale: 'css' }), 20000, 'screenshot').catch((e) => { rec.shotError = String(e.message).split('\n')[0]; });
    rec.shot = join(OUT, `${tag}.jpg`);
  } catch (e) {
    rec.error = String(e.message).split('\n')[0];
  } finally {
    await page.close().catch(() => {});
  }
  return rec;
}

function verdict(r) {
  if (r.error) return 'ERROR';
  if (r.scrollX > 0) return `SCROLLS(${r.scrollX})`;
  if (r.clip && r.hiddenRight > 40) return `CLIPPED(${r.hiddenRight})`;
  return 'ok';
}

const all = [];
for (const [w, h] of SIZES) {
  const profile = freshProfile(`${PREFIX}${process.env.TAG ? '-' + process.env.TAG : ''}-${BASELINE ? 'base' : 'ext'}-${w}`);
  const b = await launch({ profile, width: w, height: h, extensionDir: BASELINE ? null : EXT, args: UA ? [`--user-agent=${UA}`] : [] });
  // Close the initial tab once a page of ours exists; keeps zoom lookups unambiguous.
  try {
    for (const [name, url] of SITES) {
      if (ONLY && !ONLY.has(name)) continue;
      const rec = await withTimeout(runSite(b, name, url, w, h), 90000, name).catch((e) => ({ name, size: `${w}x${h}`, error: String(e.message) }));
      all.push(rec);
      const fx = rec.fixes ? Object.entries(rec.fixes).map(([k, v]) => `${k}:${v}`).join(' ') : '';
      console.log(`${w}x${h} ${name.padEnd(16)} ${verdict(rec).padEnd(14)} sw/cw=${rec.scrollWidth}/${rec.clientWidth} zoom=${rec.zoom ?? '-'} vw=${rec.viewportWidth}${rec.quirks ? " Q" : ""} clip=${rec.clip ? 1 : 0} dock=${rec.dock ? 1 : 0} ${fx}${rec.navError ? ' [nav: ' + rec.navError.slice(0, 60) + ']' : ''}${rec.error ? ' ' + rec.error : ''}`);
      writeFileSync(join(OUT, `results-${PREFIX}${process.env.TAG ? '-' + process.env.TAG : ''}-${BASELINE ? 'base' : 'ext'}-${SIZES.map((s) => s.join('x')).join('_')}.json`), JSON.stringify(all, null, 1));
    }
  } finally {
    await b.close();
  }
}
// Pending per-site timeout timers would otherwise keep node alive for up to 90s.
process.exit(0);
