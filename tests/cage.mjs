// Real Chromium with its own browser UI (native vertical tabs) inside an off-screen Wayland compositor:
// cage on the headless wlroots backend, sized and scaled like the real display. Nothing appears on screen
// and no input reaches the desktop. Needs cage + wlr-randr (+ grim for screenshots).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { freshProfile, killProfile, sleep } from './harness.mjs';

const RUNTIME = process.env.XDG_RUNTIME_DIR;

export function hasCage() {
  if (!RUNTIME) return false;
  try {
    for (const tool of ['cage', 'wlr-randr']) execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    if (!process.env.CHROMIUM) execFileSync('flatpak', ['info', 'org.chromium.Chromium'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

// Physical pixels + scale, like the hardware: the Surface Pro 9 in portrait is 768 CSS px wide.
export const SURFACE_PORTRAIT = { w: 1920, h: 2880, dsf: 2.5 };

/**
 * @param {object} o
 * @param {string} o.name           profile name (under the test root, removed on exit)
 * @param {object} [o.prefs]        merged into Default/Preferences (vertical tabs are on and collapsed by default)
 * @param {string[]} [o.extensions] unpacked extension dirs to load
 * @param {object} [o.env]          extra environment for the browser (and native messaging hosts it starts)
 * @param {(profile: string) => void} [o.seed] write more files into the profile before start
 */
export async function launchInCage({ name, device = SURFACE_PORTRAIT, prefs = {}, extensions = [], env = {}, args = [], seed } = {}) {
  const profile = freshProfile(name);
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({
    vertical_tabs: { enabled: true, enabled_first_time: true, collapsed_state: true, expand_on_hover: true },
    browser: { has_seen_welcome_page: true },
    ...prefs,
  }));
  seed?.(profile);
  // (flatpak run passes the environment on into the sandbox)
  const bin = process.env.CHROMIUM ? [process.env.CHROMIUM] : ['flatpak', 'run', '--branch=stable', 'org.chromium.Chromium'];
  const launchedAt = Date.now() - 1000;
  const cage = spawn('cage', ['--', ...bin,
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    '--ozone-platform=wayland', '--start-maximized',
    ...(extensions.length ? [`--load-extension=${extensions.join(',')}`, `--disable-extensions-except=${extensions.join(',')}`] : ['--disable-extensions']),
    ...args,
    'about:blank',
  ], {
    env: { ...process.env, ...env, WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WLR_RENDERER: 'pixman' },
    stdio: 'ignore',
    detached: true,
  });
  let socket = null;
  const stop = async () => {
    await killProfile(profile);
    // SIGTERM lets cage remove its socket; SIGKILL only if it hangs.
    try { process.kill(-cage.pid, 'SIGTERM'); } catch {}
    await waitFor(() => { try { process.kill(cage.pid, 0); return false; } catch { return true; } }, 5000);
    try { process.kill(-cage.pid, 'SIGKILL'); } catch {}
    // A killed compositor can leave its socket behind: remove it so nothing stale piles up.
    if (socket) for (const f of [socket, `${socket}.lock`]) rmSync(join(RUNTIME, f), { force: true });
  };
  try {
    // cage picks the first free wayland-N socket; ours is the one created just now.
    socket = await waitFor(() => readdirSync(RUNTIME).find((f) => /^wayland-\d+$/.test(f) && f !== process.env.WAYLAND_DISPLAY && statSync(join(RUNTIME, f)).ctimeMs >= launchedAt));
    if (!socket) throw new Error('cage did not start');
    const wl = { ...process.env, WAYLAND_DISPLAY: socket };
    // Scale on the output, like the real display: Chromium then lays out at w/dsf CSS px.
    execFileSync('wlr-randr', ['--output', 'HEADLESS-1', '--custom-mode', `${device.w}x${device.h}`, '--scale', String(device.dsf)], { env: wl });
    const portFile = join(profile, 'DevToolsActivePort');
    if (!(await waitFor(() => existsSync(portFile)))) throw new Error('Chromium did not start');
    await sleep(300);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}`);
    return {
      browser, profile, wl,
      context: browser.contexts()[0],
      screenshot(file, scale = 0.5) { execFileSync('grim', ['-s', String(scale), file], { env: wl }); return file; },
      async close() { await browser.close().catch(() => {}); await stop(); },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

// A finger on the page, through Chromium's real touch pipeline (gesture recognition, scrolling,
// overscroll navigation), not just DOM events.
export async function touchDrag(cdp, from, to, { steps = 16, stepMs = 12, onMove } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    const p = [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p[0], y: p[1] }] });
    await onMove?.(p, i);
    await sleep(stepMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
