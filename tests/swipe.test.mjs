// Tab strip swipes: the helper that presses Chromium's own Ctrl+Shift+L, and edge swipes opening and
// closing Chromium's native vertical tab strip in a real browser window.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, freshProfile, swEval, sleep, trackDir, extensionWithHelper, registerHelper, HELPER, ROOT, TEST_ROOT } from './harness.mjs';
import { hasCage, launchInCage, touchDrag, waitFor } from './cage.mjs';
import { serve } from './server.mjs';


// The helper over native messaging framing (length-prefixed JSON), like Chromium talks to it.
function startHelper(env) {
  const p = spawn(HELPER, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  const waiting = [];
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const n = buf.readUInt32LE(0);
      waiting.shift()?.(JSON.parse(buf.subarray(4, 4 + n)));
      buf = buf.subarray(4 + n);
    }
  });
  return {
    request: (msg) => new Promise((resolve) => {
      waiting.push(resolve);
      const body = Buffer.from(JSON.stringify(msg));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      p.stdin.write(Buffer.concat([head, body]));
    }),
    close: () => new Promise((resolve) => { p.on('exit', resolve); p.stdin.end(); }),
  };
}

const swipeState = (context) => swEval(context, async () => (await chrome.storage.local.get('swipe')).swipe);

describe('helper', () => {
  test('presses only Ctrl+Shift+<letter>, and says why when it cannot', async () => {
    const log = join(trackDir(join(TEST_ROOT, 'helper-log')), 'keys.jsonl');
    mkdirSync(join(TEST_ROOT, 'helper-log'), { recursive: true });
    const h = startHelper({ RATMOBILE_KEYS: `log:${log}` });
    assert.deepEqual(await h.request({ id: 1, cmd: 'hello' }), { id: 1, version: 1, ok: true, sink: 'log', error: null });
    assert.equal((await h.request({ id: 2, cmd: 'toggle', code: 'KeyL' })).ok, true);
    assert.equal((await h.request({ id: 3, cmd: 'toggle', code: 'KeyP' })).ok, true); // "l" on Dvorak
    for (const code of ['Digit1', 'Delete', 'KeyLL', '', 7]) assert.equal((await h.request({ id: 4, cmd: 'toggle', code })).ok, code === '' /* default KeyL */);
    assert.equal((await h.request({ id: 5, cmd: 'exec' })).ok, false);
    await h.close();
    const pressed = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).codes);
    assert.deepEqual(pressed, [[29, 42, 38], [29, 42, 25], [29, 42, 38]]);

    const none = startHelper({ RATMOBILE_KEYS: 'wayland', WAYLAND_DISPLAY: '/nonexistent' });
    const hello = await none.request({ id: 1, cmd: 'hello' });
    assert.equal(hello.ok, false);
    assert.match(hello.error, /^wayland: /);
    assert.equal((await none.request({ id: 2, cmd: 'toggle', code: 'KeyL' })).ok, false);
    await none.close();
  });

  // Only where /dev/uinput is writable and the test can hold the new device exclusively (EVIOCGRAB):
  // then not a single key reaches the desktop.
  const uinput = (() => { try { accessSync('/dev/uinput', constants.W_OK); return true; } catch { return false; } })();
  test('uinput: the virtual keyboard sends exactly Ctrl+Shift+L', { skip: !uinput && 'no write access to /dev/uinput' }, async (t) => {
    const h = startHelper({ RATMOBILE_KEYS: 'uinput' });
    assert.equal((await h.request({ id: 1, cmd: 'hello' })).sink, 'uinput');
    const grab = spawn('python3', ['-I', '-c', `
import fcntl, glob, json, os, select, struct, sys, time
dev = None
for _ in range(400):
    for n in glob.glob('/sys/class/input/event*/device/name'):
        if open(n).read().strip() == 'RatMobile tab strip keys': dev = '/dev/input/' + n.split('/')[4]
    if dev and os.access(dev, os.R_OK): break
    time.sleep(0.005)
try:
    fd = os.open(dev, os.O_RDONLY)
    fcntl.ioctl(fd, 0x40044590, 1)  # EVIOCGRAB
except Exception as e:
    print(json.dumps({'busy': str(e)}), flush=True); sys.exit()
print(json.dumps({'grabbed': dev}), flush=True)
keys = []
while len(keys) < 6 and select.select([fd], [], [], 3)[0]:
    data = os.read(fd, 24 * 64)
    keys += [(c, v) for _, _, t, c, v in struct.iter_unpack('llHHi', data) if t == 1]
print(json.dumps({'keys': keys}), flush=True)
`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = [];
    grab.stdout.on('data', (d) => lines.push(...String(d).trim().split('\n').map((l) => JSON.parse(l))));
    await waitFor(() => lines.length, 5000);
    if (!lines[0]?.grabbed) {
      grab.kill();
      await h.close();
      t.skip(`could not hold the device exclusively (${lines[0]?.busy}), so no keys were sent`);
      return;
    }
    assert.equal((await h.request({ id: 2, cmd: 'toggle', code: 'KeyL' })).ok, true);
    await waitFor(() => lines.length > 1, 5000);
    assert.deepEqual(lines[1].keys, [[29, 1], [42, 1], [38, 1], [38, 0], [42, 0], [29, 0]]);
    await h.close();
  });
});

let server;
before(async () => { server = await serve(join(ROOT, 'tests/fixtures')); });
after(() => server?.close());

describe('headless window (no tab strip beside the page)', () => {
  let b;
  let log;
  before(async () => {
    log = join(trackDir(join(TEST_ROOT, 'swipe-headless-log')), 'keys.jsonl');
    mkdirSync(join(TEST_ROOT, 'swipe-headless-log'), { recursive: true });
    const profile = freshProfile('swipe-headless');
    registerHelper(profile);
    const prev = process.env.RATMOBILE_KEYS;
    process.env.RATMOBILE_KEYS = `log:${log}`;
    try {
      b = await launch({ profile, extensionDir: extensionWithHelper(), width: 768, height: 1100 });
    } finally {
      if (prev === undefined) delete process.env.RATMOBILE_KEYS; else process.env.RATMOBILE_KEYS = prev;
    }
  });
  after(async () => b?.close());

  test('the extension reaches its helper over native messaging', async () => {
    const s = await waitFor(async () => { const v = await swipeState(b.context); return v?.state === 'ready' && v; }, 10000);
    assert.deepEqual(s, { state: 'ready', sink: 'log' });
  });

  test('without a vertical tab strip, edge swipes are left alone and nothing is pressed', async () => {
    const page = await b.context.newPage();
    await page.goto(`${server.url}/good.html`);
    await page.goto(`${server.url}/swipe.html`);
    await sleep(800);
    const cdp = await b.context.newCDPSession(page);
    await touchDrag(cdp, [6, 900], [8, 300]);
    await sleep(600);
    assert.ok((await page.evaluate(() => scrollY)) > 200, 'scrolling from the edge works');
    await touchDrag(cdp, [6, 600], [506, 600], { steps: 25 });
    assert.ok(await waitFor(() => page.url().endsWith('/good.html'), 5000), "Chromium's own back swipe, as without RatMobile");
    await sleep(300);
    assert.equal(existsSync(log), false, 'no key pressed');
    await page.close();
  });

  test('turning swipes off in settings stops the helper', async () => {
    await swEval(b.context, async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, swipeTabs: false } });
    });
    assert.ok(await waitFor(async () => (await swipeState(b.context))?.state === 'off', 5000));
    await swEval(b.context, async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, swipeTabs: true } });
    });
    assert.ok(await waitFor(async () => (await swipeState(b.context))?.state === 'ready', 5000));
  });
});

// The real thing: Chromium's own browser UI with native vertical tabs, collapsed to the icon strip, at the
// Surface's portrait size. The helper presses Ctrl+Shift+L through the compositor's virtual keyboard
// (the window is off-screen, so a uinput key would go to the desktop instead).
describe('real Chromium window with native vertical tabs', { skip: !hasCage() && 'needs cage, wlr-randr and Chromium' }, () => {
  let b;
  let page;
  let cdp;
  const OUT = join(ROOT, 'test-results/swipe');
  const width = () => page.evaluate(() => innerWidth);
  const seen = () => page.evaluate(() => ({ ...window.seen, url: location.href }));

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    b = await launchInCage({ name: 'swipe-cage', extensions: [extensionWithHelper()], env: { RATMOBILE_KEYS: 'wayland' }, seed: registerHelper });
    page = b.context.pages().find((p) => p.url() === 'about:blank') || (await b.context.newPage());
    await page.goto(`${server.url}/good.html`);
    await page.goto(`${server.url}/swipe.html`);
    await sleep(800);
    cdp = await b.context.newCDPSession(page);
  });
  after(async () => b?.close());

  test('the helper is ready', async () => {
    const s = await waitFor(async () => { const v = await swipeState(b.context); return v?.state === 'ready' && v; }, 10000);
    assert.deepEqual(s, { state: 'ready', sink: 'wayland' });
  });

  test('swipe right from the left edge: the tab strip expands, the page does not go back', async () => {
    assert.equal(await width(), 712, 'collapsed icon strip (56px) beside a 712px page');
    b.screenshot(join(OUT, '1-collapsed.png'));
    await touchDrag(cdp, [8, 600], [508, 600], { steps: 25 }); // a long swipe: would be "back" without RatMobile
    assert.ok(await waitFor(async () => (await width()) < 600, 3000), 'strip expanded');
    await sleep(600);
    b.screenshot(join(OUT, '2-expanded.png'));
    const s = await seen();
    assert.ok((await width()) < 600, 'and stays expanded (the page is narrower: the strip pushes it, not an overlay)');
    assert.ok(s.url.endsWith('/swipe.html'), `stayed on the page (${s.url})`);
    assert.deepEqual(s.keys, [], 'the page never saw the shortcut');
    console.log(`  strip started opening ${Math.round(s.resized - s.trigger)} ms after the finger moved 24px`);
  });

  test('swipe left from the page edge: the tab strip collapses again', async () => {
    await touchDrag(cdp, [10, 600], [-290, 600]);
    assert.ok(await waitFor(async () => (await width()) === 712, 3000), 'strip collapsed');
    const s = await seen();
    assert.ok(s.url.endsWith('/swipe.html'));
    assert.deepEqual(s.keys, []);
    console.log(`  strip started closing ${Math.round(s.resized - s.trigger)} ms after the finger moved 24px`);
  });

  test('scrolling that starts at the edge still scrolls, and does not touch the strip', async () => {
    await touchDrag(cdp, [10, 900], [14, 300]);
    await sleep(800);
    assert.ok((await page.evaluate(() => scrollY)) > 300, 'page scrolled');
    assert.equal(await width(), 712);
    await page.evaluate(() => scrollTo(0, 0));
  });

  test('a tap at the very left edge still opens the link there', async () => {
    const box = await page.locator('#edge').boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 2, y: box.y + box.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await waitFor(() => page.evaluate(() => location.hash === '#tapped'), 3000));
    assert.equal(await width(), 712);
  });

  test("Chromium's own back swipe still works away from the edge", async () => {
    const before = page.url();
    await touchDrag(cdp, [200, 600], [700, 600], { steps: 25 });
    assert.ok(await waitFor(() => page.url() !== before, 5000), 'went back');
    await sleep(500);
    assert.equal(await width(), 712, 'strip untouched');
  });
});
