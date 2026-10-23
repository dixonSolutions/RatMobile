#!/usr/bin/env node
// Before/after screenshots of the WHOLE browser window (Chromium's own vertical tabs included) at real
// device resolutions, rendered off-screen in a headless Wayland compositor (cage + grim + wlr-randr).
//
//   node tests/visual.mjs                    # all devices, all pages
//   DEVICES=tablet-portrait node tests/visual.mjs
//   OUT=dir node tests/visual.mjs            # default: test-results/visual
//
// Every device is rendered twice with identical profiles: Chromium alone, then Chromium + RatMobile.
// Native vertical tabs are configured the way scripts/install.sh --tablet sets them up.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, sleep, freshProfile, killProfile, cleanupProfiles } from './harness.mjs';
import { serve } from './server.mjs';

const OUT = process.env.OUT || join(ROOT, 'test-results/visual');
const RUNTIME = process.env.XDG_RUNTIME_DIR;

// Physical pixels + device scale factor, like the real hardware.
const ALL_DEVICES = {
  'tablet-portrait': { w: 1920, h: 2880, dsf: 2.5, label: 'Surface Pro 9 portrait (768×1152 CSS px)' },
  'tablet-landscape': { w: 2880, h: 1920, dsf: 2.5, label: 'Surface Pro 9 landscape (1152×768 CSS px)' },
  'tablet-split': { w: 1440, h: 1920, dsf: 2.5, label: 'Surface Pro 9 split screen (576×768 CSS px)' },
  // Desktop Chromium can't make a window narrower than ~620 CSS px, so at phone width it overhangs the screen.
  phone: { w: 1080, h: 2400, dsf: 2.625, label: 'Phone, Pixel-class (411×914 CSS px)' },
};
const DEVICES = (process.env.DEVICES || 'tablet-portrait,tablet-landscape,tablet-split').split(',');

const REPLAY_PAGE = 'slashdot';
// Real sites that scroll sideways at tablet-portrait width without RatMobile (checked 2026-10-23).
const PAGES = () => [
  ['slashdot', 'https://slashdot.org/'],
  ['wiki-linux-distros', 'https://en.wikipedia.org/wiki/Comparison_of_Linux_distributions'],
  ['wiki-languages', 'https://en.wikipedia.org/wiki/Comparison_of_programming_languages'],
  ['wiki-browsers', 'https://en.wikipedia.org/wiki/Comparison_of_web_browsers'],
  ['wiki-python', 'https://en.wikipedia.org/wiki/Python_(programming_language)'],
];

function chromiumCommand() {
  if (process.env.CHROMIUM) return [process.env.CHROMIUM];
  return ['flatpak', 'run', '--branch=stable', 'org.chromium.Chromium'];
}

// The tablet setup for Chromium's own vertical tabs (same keys install.sh --tablet writes).
function seedProfile(profile, pinned, expanded = false) {
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({
    vertical_tabs: { enabled: true, enabled_first_time: true, collapsed_state: !expanded, expand_on_hover: true },
    session: { restore_on_startup: 4, startup_urls: pinned },
    pinned_tabs: pinned.map((url) => ({ url })),
    browser: { has_seen_welcome_page: true },
  }));
}

async function waitFor(fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

async function measure(page) {
  return page.evaluate(async () => {
    const se = document.scrollingElement || document.documentElement;
    const y = scrollY;
    scrollTo({ left: 100000, top: y, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 150));
    const sx = Math.round(scrollX);
    scrollTo({ left: 0, top: y, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { canScrollX: sx, scrollWidth: se.scrollWidth, clientWidth: se.clientWidth, innerWidth, outerWidth, fixes: document.querySelectorAll('[data-rm-fix]').length };
  });
}

async function run(deviceName, withExtension, server, { expanded = false } = {}) {
  const dev = ALL_DEVICES[deviceName];
  const tag = `${deviceName}-${withExtension ? 'with' : 'without'}${expanded ? '-expanded' : ''}`;
  const profile = freshProfile(`visual-${tag}`);
  seedProfile(profile, ['https://github.com/', 'https://en.wikipedia.org/wiki/Main_Page'], expanded);

  const launchedAt = Date.now() - 1000;
  const [bin, ...pre] = chromiumCommand();
  const args = [
    ...pre,
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    '--ozone-platform=wayland', '--start-maximized',
    ...(withExtension ? [`--load-extension=${join(ROOT, 'dist/ratmobile')}`, `--disable-extensions-except=${join(ROOT, 'dist/ratmobile')}`] : ['--disable-extensions']),
    'about:blank',
  ];
  const cage = spawn('cage', ['--', bin, ...args], {
    env: { ...process.env, WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WLR_RENDERER: 'pixman' },
    stdio: 'ignore',
    detached: true,
  });
  // cage picks the first free wayland-N socket; ours is the one created just now.
  const socket = await waitFor(() => readdirSync(RUNTIME).find((f) => /^wayland-\d+$/.test(f) && f !== process.env.WAYLAND_DISPLAY && statSync(join(RUNTIME, f)).ctimeMs >= launchedAt));
  if (!socket) throw new Error('cage did not start');
  const wl = { ...process.env, WAYLAND_DISPLAY: socket };
  // Scale on the output, like the real display: Chromium then lays out at w/dsf CSS px.
  execFileSync('wlr-randr', ['--output', 'HEADLESS-1', '--custom-mode', `${dev.w}x${dev.h}`, '--scale', String(dev.dsf)], { env: wl });

  const portFile = join(profile, 'DevToolsActivePort');
  if (!(await waitFor(() => existsSync(portFile)))) throw new Error('Chromium did not start');
  await sleep(300);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}`);
  const results = [];
  try {
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => p.url() === 'about:blank') || (await context.newPage());
    await page.bringToFront();
    for (const [name, url] of expanded ? PAGES(server.url).slice(0, 1) : PAGES(server.url)) {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await sleep(2500);
      const m = await measure(page).catch(() => ({}));
      // Make sure the page is really back at the left edge before the screenshot (some pages re-scroll).
      for (let i = 0; i < 20; i++) {
        const x = await page.evaluate(() => { scrollTo({ left: 0, top: 0, behavior: 'instant' }); return scrollX; }).catch(() => 0);
        if (x === 0) break;
        await sleep(100);
      }
      await sleep(300);
      const file = join(OUT, `${deviceName}-${name}-${withExtension ? 'with' : 'without'}${expanded ? '-tabs-open' : ''}.png`);
      execFileSync('grim', [file], { env: wl });
      results.push({ device: deviceName, page: name, withExtension, expanded, file, ...m });
      // Replay: drag the first page sideways, the way a finger would.
      if (name === REPLAY_PAGE && !expanded) {
        const max = Math.max(m.canScrollX || 0, 1);
        const steps = [0, 0.25, 0.5, 0.75, 1, 1, 0.5, 0];
        for (const [i, f] of steps.entries()) {
          await page.evaluate((x) => scrollTo({ left: x, top: 0, behavior: 'instant' }), withExtension ? 400 * f : max * f);
          await sleep(120);
          execFileSync('grim', ['-s', '0.5', join(OUT, `replay-${deviceName}-${withExtension ? 'with' : 'without'}-${i}.png`)], { env: wl });
        }
        await page.evaluate(() => scrollTo({ left: 0, top: 0, behavior: 'instant' }));
      }
      console.log(`${tag.padEnd(28)} ${name.padEnd(14)} sideways scroll: ${String(m.canScrollX ?? '?').padStart(4)}px  viewport ${m.innerWidth}px  fixes ${m.fixes ?? 0}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await killProfile(profile);
    // SIGTERM lets cage remove its socket; SIGKILL only if it hangs.
    try { process.kill(-cage.pid, 'SIGTERM'); } catch {}
    await waitFor(() => { try { process.kill(cage.pid, 0); return false; } catch { return true; } }, 5000);
    try { process.kill(-cage.pid, 'SIGKILL'); } catch {}
    // A killed compositor can leave its socket behind: remove it so nothing stale piles up.
    for (const f of [socket, `${socket}.lock`]) rmSync(join(RUNTIME, f), { force: true });
  }
  return results;
}

const FONT = (() => {
  try { return execFileSync('fc-match', ['-f', '%{file}', 'Cantarell:bold']).toString() || 'Helvetica'; } catch { return 'Helvetica'; }
})();

function compose(results) {
  const byKey = new Map();
  for (const r of results) {
    const k = `${r.device}-${r.page}`;
    if (r.expanded) continue;
    if (!byKey.has(k)) byKey.set(k, {});
    byKey.get(k)[r.withExtension ? 'with' : 'without'] = r;
  }
  const made = [];
  for (const [k, { with: w, without: wo }] of byKey) {
    if (!w || !wo) continue;
    const label = (r, title) => `${title}: ${r.canScrollX > 0 ? `scrolls sideways ${r.canScrollX}px` : 'fits the width'}`;
    const out = join(OUT, `compare-${k}.jpg`);
    execFileSync('magick', [
      '(', wo.file, '-resize', '900x', '-gravity', 'north', '-background', '#2b2a28', '-fill', '#ffffff', '-font', FONT, '-pointsize', '30', '-splice', '0x64', '-annotate', '+0+14', label(wo, 'Chromium alone'), ')',
      '(', w.file, '-resize', '900x', '-gravity', 'north', '-background', '#d9480f', '-fill', '#ffffff', '-font', FONT, '-pointsize', '30', '-splice', '0x64', '-annotate', '+0+14', label(w, 'With RatMobile'), ')',
      '-background', '#1b1a19', '-gravity', 'north', '-splice', '0x0', '+smush', '24', '-quality', '82', out,
    ]);
    made.push(out);
  }
  for (const d of DEVICES) {
    const frames = (kind) => Array.from({ length: 8 }, (_, i) => join(OUT, `replay-${d}-${kind}-${i}.png`)).filter((f) => existsSync(f));
    const wo = frames('without');
    const w = frames('with');
    if (!wo.length || !w.length) continue;
    const label = (f, text, bg) => ['(', f, '-gravity', 'north', '-background', bg, '-fill', '#ffffff', '-font', FONT, '-pointsize', '26', '-splice', '0x54', '-annotate', '+0+12', text, ')'];
    const out = join(OUT, `replay-${d}.gif`);
    execFileSync('magick', [
      '-delay', '45', '-loop', '0',
      ...wo.flatMap((f) => label(f, 'Chromium alone: the page slides sideways', '#2b2a28')),
      ...w.flatMap((f) => label(f, 'With RatMobile: same swipe, page stays put', '#d9480f')),
      '-resize', '640x', '-layers', 'Optimize', out,
    ]);
    made.push(out);
  }
  return made;
}

mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'dist/ratmobile/manifest.json'))) execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' });
const server = await serve(join(ROOT, 'tests/fixtures'));
const all = [];
try {
  for (const d of DEVICES) {
    all.push(...(await run(d, false, server)));
    all.push(...(await run(d, true, server)));
    if (d === 'tablet-portrait') all.push(...(await run(d, true, server, { expanded: true })));
  }
} finally {
  server.close();
  cleanupProfiles();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify(all, null, 1));
const made = compose(all);
console.log(`\n${made.length} comparisons in ${OUT}`);
