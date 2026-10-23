// Launches a real Chromium with RatMobile loaded and connects Playwright over CDP.
// Chromium binary: $CHROMIUM, else the Flathub org.chromium.Chromium, else Playwright's Chromium.
import { spawn, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
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

// Everything tests create lives under one folder inside $HOME (so the flatpak sandbox can reach it)
// and is removed when the test process exits, pass or fail: the machine stays clean.
export const TEST_ROOT = join(homedir(), '.cache/ratmobile-test');
const created = new Set();

export function profileDir(name) {
  const dir = join(TEST_ROOT, name);
  mkdirSync(dir, { recursive: true });
  created.add(dir);
  return dir;
}

export function freshProfile(name) {
  rmSync(join(TEST_ROOT, name), { recursive: true, force: true });
  return profileDir(name);
}

export function trackDir(dir) {
  created.add(dir);
  return dir;
}

export function cleanupProfiles() {
  for (const dir of created) {
    try { execSync(`pkill -9 -f -- "--user-data-dir=${dir}"`, { stdio: 'ignore' }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  created.clear();
  try { rmdirSync(TEST_ROOT); } catch {} // only if nothing else is left in it
}
process.on('exit', cleanupProfiles);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupProfiles(); process.exit(130); });

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
    // Headed: the compositor already applies the display scale (2x on the Surface).
    ...(headless ? [`--force-device-scale-factor=${dsf}`] : []),
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

// RatMobile's swipe helper (scripts/ratmobile-host).
export const HELPER = join(ROOT, 'scripts/ratmobile-host');

// A copy of the build with nativeMessaging granted up front (it is optional and asked for in the popup),
// and the helper registered in the profile (Chromium reads <user-data-dir>/NativeMessagingHosts).
export function extensionWithHelper() {
  const dir = trackDir(join(TEST_ROOT, 'swipe-ext'));
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'dist/ratmobile'), dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.permissions.push('nativeMessaging');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}
export function registerHelper(profile) {
  mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(join(profile, 'NativeMessagingHosts', 'com.dixonsolutions.ratmobile.json'), JSON.stringify({
    name: 'com.dixonsolutions.ratmobile', description: 'RatMobile swipe helper (test)', path: HELPER, type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`],
  }));
}

export function fixtureUrl(server, name) {
  return `${server.url}/${name}`;
}
