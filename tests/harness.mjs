// Launches a real Chromium with RatMobile loaded and connects Playwright over CDP.
// Chromium binary: $CHROMIUM, else the Flathub org.chromium.Chromium, else Playwright's Chromium.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_ID = 'jlddfageoecfjabhpdkjjbogcnafbdfa';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasFlatpakChromium() {
  try {
    execSync('flatpak info org.chromium.Chromium', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function command() {
  if (process.env.CHROMIUM) return [process.env.CHROMIUM];
  if (hasFlatpakChromium()) return ['flatpak', 'run', '--branch=stable', 'org.chromium.Chromium'];
  return [chromium.executablePath()];
}

export function profileDir(name) {
  // Inside $HOME so the flatpak sandbox can reach it.
  const dir = join(homedir(), '.cache/ratmobile-test', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function freshProfile(name) {
  const dir = join(homedir(), '.cache/ratmobile-test', name);
  rmSync(dir, { recursive: true, force: true });
  return profileDir(name);
}

export async function launch({
  profile,
  extensionDir = join(ROOT, 'dist/ratmobile'),
  headless = process.env.HEADED ? false : true,
  width = 1440,
  height = 960,
  dsf = 2,
  args = [],
  urls = [],
} = {}) {
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const [bin, ...pre] = command();
  const flags = [
    ...pre,
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider,MediaRouter',
    '--password-store=basic',
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dsf}`,
    ...(extensionDir ? [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`] : []),
    ...(headless ? ['--headless=new'] : ['--ozone-platform=wayland']),
    ...args,
    ...urls,
  ];
  const proc = spawn(bin, flags, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error('Chromium did not start:\n' + stderr.slice(-3000));
  await sleep(150);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  return {
    proc, browser, context, port, profile,
    stderr: () => stderr,
    async close() {
      await browser.close().catch(() => {});
      await killProfile(profile);
    },
  };
}

// SIGKILL every Chromium process using this profile: a real "force shutdown" from the browser's view.
export async function killProfile(profile) {
  try { execSync(`pkill -9 -f -- "--user-data-dir=${profile}"`, { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 50; i++) {
    try { execSync(`pgrep -f -- "--user-data-dir=${profile}"`, { stdio: 'ignore' }); } catch { return; }
    await sleep(100);
  }
}

export async function serviceWorker(context, timeout = 10000) {
  const find = () => context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const sw = find();
    if (sw) return sw;
    await sleep(100);
  }
  throw new Error('RatMobile service worker not found');
}

// Evaluate in the extension's service worker (full chrome.* API access).
export async function swEval(context, fn, arg) {
  const sw = await serviceWorker(context);
  return sw.evaluate(fn, arg);
}

// Ask the content script in a tab for its fit status (via the service worker).
export async function fitStatus(context, page) {
  const url = page.url();
  return swEval(context, async (u) => {
    const [tab] = await chrome.tabs.query({ url: u.split('#')[0] });
    if (!tab) return null;
    return chrome.tabs.sendMessage(tab.id, { type: 'fit:status' }, { frameId: 0 });
  }, url);
}

export async function pageOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth,
    canScrollX: (() => { const before = scrollX; scrollTo(99999, scrollY); const moved = scrollX; scrollTo(before, scrollY); return moved; })(),
  }));
}

export function fixtureUrl(server, name) {
  return `${server.url}/${name}`;
}
