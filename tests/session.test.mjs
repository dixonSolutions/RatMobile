// Session snapshots: SIGKILL the whole browser (force shutdown) and check everything comes back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, freshProfile, swEval, sleep, killProfile, ROOT } from './harness.mjs';
import { serve } from './server.mjs';

let server;
before(async () => { server = await serve(join(ROOT, 'tests/fixtures')); });
after(() => server?.close());

const u = (name) => `${server.url}/${name}`;

// Build a session: window A = 2 pinned + 2 grouped + 1 normal, window B = 2 tabs.
async function buildSession(context) {
  return swEval(context, async (urls) => {
    const [a, b] = [urls.slice(0, 5), urls.slice(5)];
    const winA = (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0];
    const created = [];
    for (const url of a) created.push(await chrome.tabs.create({ windowId: winA.id, url, active: false }));
    await chrome.tabs.update(created[0].id, { pinned: true });
    await chrome.tabs.update(created[1].id, { pinned: true });
    const gid = await chrome.tabs.group({ tabIds: [created[2].id, created[3].id] });
    await chrome.tabGroups.update(gid, { title: 'Research', color: 'purple' });
    await chrome.tabs.update(created[4].id, { active: true });
    // Close the initial new-tab page(s).
    const extra = (await chrome.tabs.query({ windowId: winA.id })).filter((t) => !created.some((c) => c.id === t.id));
    if (extra.length) await chrome.tabs.remove(extra.map((t) => t.id));
    const winB = await chrome.windows.create({ url: b[0], focused: false });
    await chrome.tabs.create({ windowId: winB.id, url: b[1] });
  }, [u('good.html'), u('sticky.html'), u('wide-image.html'), u('pre-code.html'), u('long-word.html'), u('vw.html'), u('flex-row.html')]);
}

async function describeSession(context) {
  return swEval(context, async () => {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const groups = await chrome.tabGroups.query({});
    return wins.map((w) => ({
      tabs: w.tabs.map((t) => ({ url: t.pendingUrl || t.url, pinned: t.pinned, group: groups.find((g) => g.id === t.groupId)?.title ?? null })),
    }));
  });
}

async function waitForSnapshot(context, minTabs) {
  for (let i = 0; i < 100; i++) {
    const n = await swEval(context, async () => {
      const { 'snap:current': s } = await chrome.storage.local.get('snap:current');
      return s ? s.windows.reduce((n, w) => n + w.tabs.length, 0) : 0;
    });
    if (n >= minTabs) return n;
    await sleep(200);
  }
  throw new Error('snapshot never reached ' + minTabs + ' tabs');
}

async function waitForTabs(context, pred, timeout = 25000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await describeSession(context).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  return last;
}

const flat = (s) => s.flatMap((w) => w.tabs);
const fixtureTabs = (s) => flat(s).filter((t) => t.url?.startsWith(server.url));

function assertRestored(s) {
  const tabs = fixtureTabs(s);
  assert.equal(tabs.length, 7, `expected 7 restored tabs, got ${JSON.stringify(s)}`);
  assert.equal(s.length, 2, 'two windows');
  const urls = new Set(tabs.map((t) => t.url));
  for (const n of ['good', 'sticky', 'wide-image', 'pre-code', 'long-word', 'vw', 'flex-row']) assert.ok(urls.has(u(`${n}.html`)), `${n} missing`);
  const pinned = tabs.filter((t) => t.pinned).map((t) => t.url).sort();
  assert.deepEqual(pinned, [u('good.html'), u('sticky.html')].sort(), 'pinned tabs');
  const grouped = tabs.filter((t) => t.group === 'Research').map((t) => t.url).sort();
  assert.deepEqual(grouped, [u('pre-code.html'), u('wide-image.html')].sort(), 'tab group');
  // Pinned tabs come first in their window.
  const winA = s.find((w) => w.tabs.some((t) => t.pinned));
  assert.ok(winA.tabs[0].pinned && winA.tabs[1].pinned, 'pinned tabs on top');
  // No duplicates.
  assert.equal(new Set(flat(s).map((t) => t.url)).size, flat(s).length, 'duplicate tabs');
}

test('force kill (SIGKILL) -> everything restored on next start', async () => {
  const profile = freshProfile('session-kill');
  let b = await launch({ profile });
  await buildSession(b.context);
  await waitForSnapshot(b.context, 7);
  await sleep(500);
  await b.browser.close().catch(() => {});
  await killProfile(profile); // force shutdown
  b = await launch({ profile });
  try {
    const s = await waitForTabs(b.context, (s) => fixtureTabs(s).length >= 7 && s.length >= 2);
    await sleep(1500);
    assertRestored(await describeSession(b.context));
    const hist = await swEval(b.context, async () => (await chrome.storage.local.get('snap:history'))['snap:history'].map((h) => h.label));
    assert.ok(hist.includes('Previous session'), 'previous session archived');
  } finally {
    await b.close();
  }
});

test('repeated crashes do not lose or duplicate the session', async () => {
  const profile = freshProfile('session-kill-twice');
  let b = await launch({ profile });
  await buildSession(b.context);
  await waitForSnapshot(b.context, 7);
  await b.browser.close().catch(() => {});
  await killProfile(profile);
  for (let i = 0; i < 2; i++) {
    b = await launch({ profile });
    await waitForTabs(b.context, (s) => fixtureTabs(s).length >= 7 && s.length >= 2);
    await sleep(2500); // let the restored session be snapshotted again
    await b.browser.close().catch(() => {});
    await killProfile(profile);
  }
  b = await launch({ profile });
  try {
    await waitForTabs(b.context, (s) => fixtureTabs(s).length >= 7 && s.length >= 2);
    await sleep(1500);
    assertRestored(await describeSession(b.context));
  } finally {
    await b.close();
  }
});

test('graceful quit with Chromium "Continue where you left off" -> no duplicates', async () => {
  const profile = freshProfile('session-continue');
  let b = await launch({ profile });
  await buildSession(b.context);
  await waitForSnapshot(b.context, 7);
  await sleep(500);
  // Graceful shutdown through CDP Browser.close.
  const cdp = await b.browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => {});
  await sleep(3000);
  await killProfile(profile);
  const prefsPath = join(profile, 'Default/Preferences');
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
  writeFileSync(prefsPath, JSON.stringify(prefs));
  b = await launch({ profile });
  try {
    const s = await waitForTabs(b.context, (s) => fixtureTabs(s).length >= 7);
    await sleep(4000);
    const final = await describeSession(b.context);
    assert.ok(fixtureTabs(final).length >= 7, `restored: ${JSON.stringify(s)}`);
    assert.equal(new Set(fixtureTabs(final).map((t) => t.url)).size, fixtureTabs(final).length, `duplicates: ${JSON.stringify(final)}`);
  } finally {
    await b.close();
  }
});

test('snapshot survives a graceful quit (not overwritten by closing windows)', async () => {
  const profile = freshProfile('session-quit');
  let b = await launch({ profile });
  await buildSession(b.context);
  await waitForSnapshot(b.context, 7);
  await sleep(500);
  const cdp = await b.browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => {});
  await sleep(3000);
  await killProfile(profile);
  b = await launch({ profile });
  try {
    const s = await waitForTabs(b.context, (s) => fixtureTabs(s).length >= 7 && s.length >= 2);
    await sleep(1500);
    assertRestored(await describeSession(b.context));
  } finally {
    await b.close();
  }
});
