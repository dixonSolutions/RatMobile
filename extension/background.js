// RatMobile service worker: session snapshots + crash restore, zoom broker for the fit engine,
// the helper behind tab strip swipes, commands, and self-updates.
import { DEFAULTS, getSettings } from './lib/settings.js';

const SNAP_KEY = 'snap:current';
const HIST_KEY = 'snap:history';
const ARCHIVE_EVERY = 10 * 60 * 1000;
const UPDATES_XML = 'https://dixonsolutions.github.io/RatMobile/updates.xml';

const log = (...a) => console.log('[RatMobile]', ...a);

// ---------------------------------------------------------------------------
// Boot: storage.session is empty on every browser start (and on extension reload/update),
// so it tells us whether this is a fresh session whose previous snapshot must be handled.
// ---------------------------------------------------------------------------
let booting = null;
function boot() {
  booting ??= (async () => {
    const { booted } = await chrome.storage.session.get('booted');
    if (booted) return;
    await chrome.storage.session.set({ booted: Date.now() });
    await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
    await startupRestore();
  })().catch((e) => log('boot failed', e));
  return booting;
}

chrome.runtime.onStartup.addListener(() => boot());

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(settings || {}) } });
  chrome.alarms.create('snapshot', { periodInMinutes: 1 });
  chrome.alarms.create('update-check', { delayInMinutes: 2, periodInMinutes: 180 });
  await boot();
  if (reason === 'install' || reason === 'update') injectIntoOpenTabs();
});

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!/^(https?|file):/.test(t.url || '') || t.discarded) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/ratmobile.js'] }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------
let snapTimer = null;
let restoredIds = new Set();
let restoredUntil = 0;
let restoring = false;
let lastSig = '';

function restorable(url) {
  return !!url && !/^(about:blank|devtools:|chrome:\/\/(crash|kill|hang|quit|restart))/.test(url);
}

function isTrivialUrl(url) {
  return !url || /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page|chrome-search:)/.test(url) || url === chrome.runtime.getURL('ui/newtab.html');
}

export function scheduleSnapshot(delay = 400) {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => takeSnapshot().catch((e) => log('snapshot failed', e)), delay);
}

async function captureSession() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  return {
    ts: Date.now(),
    windows: wins
      .filter((w) => !w.incognito)
      .map((w) => ({
        state: w.state,
        left: w.left, top: w.top, width: w.width, height: w.height,
        focused: w.focused,
        tabs: w.tabs
          .map((t) => ({ url: t.pendingUrl || t.url, title: t.title || '', pinned: t.pinned, active: t.active, groupId: t.groupId, muted: !!t.mutedInfo?.muted }))
          .filter((t) => restorable(t.url)),
        groups: groups.filter((g) => g.windowId === w.id).map((g) => ({ id: g.id, title: g.title || '', color: g.color, collapsed: g.collapsed })),
      }))
      .filter((w) => w.tabs.length),
  };
}

function signature(snap) {
  return JSON.stringify(snap.windows.map((w) => [w.tabs.map((t) => [t.url, t.pinned, t.groupId]), w.groups.map((g) => [g.id, g.title, g.color])]));
}

function tabCount(snap) {
  return snap?.windows?.reduce((n, w) => n + w.tabs.length, 0) || 0;
}

async function takeSnapshot() {
  await boot();
  if (restoring) return;
  const snap = await captureSession();
  // No windows left = the browser is shutting down. Keep the last good snapshot.
  if (!snap.windows.length) return;
  // A lone new-tab page right after start is not worth overwriting a real session with.
  const sig = signature(snap);
  if (sig === lastSig) return;
  lastSig = sig;
  const { [SNAP_KEY]: prev } = await chrome.storage.local.get(SNAP_KEY);
  await chrome.storage.local.set({ [SNAP_KEY]: snap });
  // Archive periodically, and whenever a big chunk of the session disappears at once.
  const { [HIST_KEY]: hist = [] } = await chrome.storage.local.get(HIST_KEY);
  const lastArchived = hist[0]?.ts || 0;
  const bigDrop = prev && tabCount(prev) >= 4 && tabCount(snap) < tabCount(prev) * 0.5;
  if (bigDrop) await archive(prev, 'Before closing many tabs');
  else if (Date.now() - lastArchived > ARCHIVE_EVERY) await archive(snap, 'Autosave');
}

async function archive(snap, label) {
  if (!snap || !tabCount(snap)) return;
  const { historySize } = await getSettings();
  const { [HIST_KEY]: hist = [] } = await chrome.storage.local.get(HIST_KEY);
  if (hist[0] && signature(hist[0].snap) === signature(snap)) {
    hist[0].ts = snap.ts;
    if (label !== 'Autosave') hist[0].label = label;
  } else {
    hist.unshift({ id: crypto.randomUUID(), ts: snap.ts, label, snap });
  }
  await chrome.storage.local.set({ [HIST_KEY]: hist.slice(0, historySize) });
}

// Every structural change re-snapshots (debounced). Closing a window is delayed so a full
// browser shutdown (which closes windows one by one) never records a half-empty session.
chrome.tabs.onCreated.addListener(() => scheduleSnapshot());
chrome.tabs.onRemoved.addListener((_id, info) => { if (!info.isWindowClosing) scheduleSnapshot(); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined || info.title) scheduleSnapshot(info.title && !info.url ? 2000 : 400);
  if (info.url) clearZoomState(tabId);
});
chrome.tabs.onMoved.addListener(() => scheduleSnapshot());
chrome.tabs.onAttached.addListener(() => scheduleSnapshot());
chrome.tabs.onDetached.addListener(() => scheduleSnapshot());
chrome.tabs.onActivated.addListener(() => scheduleSnapshot(1500));
chrome.tabGroups.onUpdated.addListener(() => scheduleSnapshot());
chrome.tabGroups.onRemoved.addListener(() => scheduleSnapshot());
chrome.windows.onCreated.addListener(() => scheduleSnapshot());
chrome.windows.onRemoved.addListener(() => scheduleSnapshot(4000));

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'snapshot') scheduleSnapshot(0);
  if (a.name === 'update-check') checkForUpdates();
});

// ---------------------------------------------------------------------------
// Startup restore
// ---------------------------------------------------------------------------
async function allTabs() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return wins.filter((w) => !w.incognito);
}

// Wait until Chromium's own startup / session restore has stopped creating tabs.
async function waitForStableTabs(maxMs = 10000, quietMs = 1500) {
  const start = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - start < maxMs) {
    const wins = await allTabs();
    const sig = wins.map((w) => w.tabs.map((t) => t.pendingUrl || t.url).join(',')).join('|');
    if (sig !== last) { last = sig; since = Date.now(); }
    else if (wins.length && Date.now() - since >= quietMs) return wins;
    await new Promise((r) => setTimeout(r, 250));
  }
  return allTabs();
}

async function startupRestore() {
  const { [SNAP_KEY]: prev } = await chrome.storage.local.get(SNAP_KEY);
  if (!prev || !tabCount(prev)) return;
  restoring = true;
  try {
    await archive(prev, 'Previous session');
    const settings = await getSettings();
    const wins = await waitForStableTabs();
    const open = new Set(wins.flatMap((w) => w.tabs.map((t) => t.pendingUrl || t.url)));
    const wanted = prev.windows.flatMap((w) => w.tabs.filter((t) => !isTrivialUrl(t.url)));
    if (!wanted.length) return;
    const present = wanted.filter((t) => open.has(t.url)).length;
    const coverage = present / wanted.length;
    log('startup: previous session', wanted.length, 'tabs, coverage', coverage.toFixed(2));
    await chrome.storage.session.set({ lastBoot: { ts: Date.now(), coverage, wanted: wanted.length } });
    // Chromium restored the session itself (or this is just an extension reload): nothing to do.
    if (coverage >= 0.5 || !settings.autoRestore) return;
    await restoreSnapshot(prev, { onlyMissing: true, reuseTrivial: true, lazy: settings.lazyRestore });
    await chrome.storage.session.set({ restoredAt: Date.now() });
  } finally {
    restoring = false;
    scheduleSnapshot(500);
  }
}

// Recreate windows, pinned tabs, groups and the active tab. `onlyMissing` skips tabs already open.
// Each snapshot window goes into the open window that already holds most of its tabs (Chromium
// itself brings back pinned tabs), else into a window with only a new-tab page, else a new window.
export async function restoreSnapshot(snap, { onlyMissing = true, reuseTrivial = false, lazy = true } = {}) {
  const wins = await allTabs();
  const urlOf = (t) => t.pendingUrl || t.url;
  const open = new Set(wins.flatMap((w) => w.tabs.map(urlOf)));
  const used = new Set();
  const created = [];
  for (const sw of snap.windows) {
    const tabs = onlyMissing ? sw.tabs.filter((t) => !open.has(t.url)) : sw.tabs;
    const real = tabs.filter((t) => !isTrivialUrl(t.url) || tabs.length === 1);
    if (!real.length) continue;
    try {
      const target = onlyMissing ? pickWindow(wins, sw, used, reuseTrivial) : null;
      let winId;
      let leftovers = [];
      if (target) {
        used.add(target.id);
        winId = target.id;
        leftovers = target.tabs.filter((t) => isTrivialUrl(urlOf(t))).map((t) => t.id);
      } else {
        const w = await createWindow(sw);
        winId = w.id;
        leftovers = w.tabs.map((t) => t.id);
      }
      created.push(...(await fillWindow(winId, sw, real, leftovers, lazy)));
    } catch (e) {
      log('window restore failed', e);
    }
  }
  restoredIds = new Set(created);
  restoredUntil = Date.now() + 120000;
  return created.length;
}

function pickWindow(wins, sw, used, reuseTrivial) {
  const urls = new Set(sw.tabs.map((t) => t.url));
  let best = null;
  let bestScore = 0;
  for (const w of wins) {
    if (used.has(w.id)) continue;
    const real = w.tabs.filter((t) => !isTrivialUrl(t.pendingUrl || t.url));
    const overlap = real.filter((t) => urls.has(t.pendingUrl || t.url)).length;
    // Only merge into a window if everything real in it came from this snapshot window.
    if (overlap && overlap === real.length && overlap > bestScore) { best = w; bestScore = overlap; }
  }
  if (best) return best;
  if (reuseTrivial) return wins.find((w) => !used.has(w.id) && w.tabs.every((t) => isTrivialUrl(t.pendingUrl || t.url))) || null;
  return null;
}

async function createWindow(sw) {
  const opts = { focused: false };
  if (sw.state === 'maximized' || sw.state === 'fullscreen') opts.state = sw.state;
  else if (sw.width) Object.assign(opts, { left: sw.left, top: sw.top, width: sw.width, height: sw.height });
  try {
    return await chrome.windows.create(opts);
  } catch {
    // Saved bounds are off-screen (different monitor / resolution): let Chromium place it.
    return chrome.windows.create({ focused: false });
  }
}

async function fillWindow(winId, sw, real, leftovers, lazy) {
  const created = [];
  const oldToNew = new Map();
  let activeId = null;
  const ordered = [...real.filter((t) => t.pinned), ...real.filter((t) => !t.pinned)];
  for (const t of ordered) {
    const tab = await chrome.tabs.create({ windowId: winId, url: t.url, pinned: t.pinned, active: false });
    created.push(tab.id);
    if (t.muted) chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    if (t.active) activeId = tab.id;
    if (t.groupId >= 0) {
      if (!oldToNew.has(t.groupId)) oldToNew.set(t.groupId, []);
      oldToNew.get(t.groupId).push(tab.id);
    }
  }
  for (const [oldGid, ids] of oldToNew) {
    const g = sw.groups.find((x) => x.id === oldGid);
    try {
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: winId } });
      if (g) await chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: g.collapsed });
    } catch (e) { log('group restore failed', e); }
  }
  const focus = activeId ?? created.find((id, i) => !ordered[i].pinned) ?? created[0];
  if (focus != null) await chrome.tabs.update(focus, { active: true });
  if (leftovers.length) await chrome.tabs.remove(leftovers).catch(() => {});
  if (lazy) {
    // Unload background tabs once they have started navigating, so a big restore stays light.
    setTimeout(async () => {
      for (const id of created) {
        if (id === focus) continue;
        const tab = await chrome.tabs.get(id).catch(() => null);
        if (tab && !tab.active && !tab.pinned && !tab.discarded) chrome.tabs.discard(id).catch(() => {});
      }
    }, 2500);
  }
  return created;
}

// If the user also clicks Chromium's own "Restore pages?" bubble after we restored, close the
// duplicates Chromium creates in the following two minutes.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url || Date.now() > restoredUntil || restoredIds.has(tabId)) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  if (tabs.some((t) => restoredIds.has(t.id) && t.id !== tabId && (t.pendingUrl || t.url) === info.url)) {
    log('closing duplicate from Chromium crash restore', info.url);
    chrome.tabs.remove(tabId).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Zoom broker for the fit engine
// ---------------------------------------------------------------------------
const ourZoom = new Map(); // tabId -> factor we just set
const navAt = new Map(); // tabId -> time of last navigation (per-tab zoom resets on navigation)

async function userZoomed(tabId) {
  const { userZoom = {} } = await chrome.storage.session.get('userZoom');
  return !!userZoom[tabId];
}
async function setUserZoomed(tabId, v) {
  const { userZoom = {} } = await chrome.storage.session.get('userZoom');
  if (v) userZoom[tabId] = true;
  else delete userZoom[tabId];
  await chrome.storage.session.set({ userZoom });
}
function clearZoomState(tabId) {
  navAt.set(tabId, Date.now());
  ourZoom.delete(tabId);
  setUserZoomed(tabId, false);
}

chrome.tabs.onZoomChange.addListener(async ({ tabId, newZoomFactor, oldZoomFactor }) => {
  const expected = ourZoom.get(tabId);
  if (expected != null && Math.abs(expected - newZoomFactor) < 0.006) { ourZoom.delete(tabId); return; }
  if (Date.now() - (navAt.get(tabId) || 0) < 2000) return;
  if (Math.abs(newZoomFactor - oldZoomFactor) < 0.006) return;
  await setUserZoomed(tabId, true);
  chrome.tabs.sendMessage(tabId, { type: 'fit:user-zoom', zoom: newZoomFactor }, { frameId: 0 }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => { ourZoom.delete(tabId); navAt.delete(tabId); });

async function handleZoom(tabId, factor) {
  if (await userZoomed(tabId)) return { ok: false, reason: 'user' };
  const { minZoom } = await getSettings();
  const z = Math.min(5, Math.max(minZoom, Math.round(factor * 100) / 100));
  await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' });
  ourZoom.set(tabId, z);
  await chrome.tabs.setZoom(tabId, z);
  return { ok: true, zoom: z };
}

// ---------------------------------------------------------------------------
// Tab strip swipes
//  Chromium has no extension API for its vertical tab strip, but its own shortcut Ctrl+Shift+L
//  expands and collapses it. Content scripts recognise edge swipes; RatMobile's native helper
//  (scripts/ratmobile-host, set up by install.sh) presses the shortcut. The helper's port stays open,
//  which also keeps this service worker alive, so a swipe never waits for anything to start.
//  storage.local "swipe" = { state: ready | off | no-permission | no-helper | error, sink?, error? }
// ---------------------------------------------------------------------------
const HELPER = 'com.dixonsolutions.ratmobile';
let helper = null; // { port, ready: Promise<swipe state> }
let helperRestarts = 0;
let layoutCode = 'KeyL'; // the key that types "l", as last reported by a page

async function setSwipe(state) {
  const { swipe } = await chrome.storage.local.get('swipe');
  if (JSON.stringify(swipe) !== JSON.stringify(state)) await chrome.storage.local.set({ swipe: state });
  return state;
}

function disconnectHelper() {
  const h = helper;
  helper = null;
  try { h?.port?.disconnect(); } catch {}
}

function connectHelper() {
  if (helper) return helper.ready;
  const h = (helper = {});
  h.ready = (async () => {
    const off = !(await getSettings()).swipeTabs ? 'off'
      : !(await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) ? 'no-permission' : null;
    if (off) {
      if (helper === h) helper = null;
      return setSwipe({ state: off });
    }
    return new Promise((resolve) => {
      let ready = false;
      let port;
      try {
        port = h.port = chrome.runtime.connectNative(HELPER);
      } catch (e) {
        if (helper === h) helper = null;
        resolve(setSwipe({ state: 'error', error: String(e.message || e) }));
        return;
      }
      port.onMessage.addListener((m) => {
        if (m.id === 'hello') {
          ready = !!m.ok;
          if (ready) helperRestarts = 0;
          resolve(setSwipe(ready ? { state: 'ready', sink: m.sink } : { state: 'error', error: m.error }));
        } else if (!m.ok) log('helper:', m.error);
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message || 'The helper stopped';
        if (helper !== h) return; // we closed it on purpose
        helper = null;
        resolve(setSwipe({ state: /not found|forbidden/i.test(error) ? 'no-helper' : 'error', error }));
        // A helper that worked and then went away (killed, crashed): start it again, a few times.
        if (ready && helperRestarts++ < 3) setTimeout(connectHelper, 2000);
      });
      port.postMessage({ id: 'hello', cmd: 'hello' });
    });
  })();
  return h.ready;
}

async function toggleTabStrip(code) {
  if (/^Key[A-Z]$/.test(code || '')) layoutCode = code;
  const state = await connectHelper();
  if (state.state !== 'ready' || !helper?.port) return { ok: false, ...state };
  helper.port.postMessage({ id: Date.now(), cmd: 'toggle', code: layoutCode });
  return { ok: true };
}

function reconnectHelper() {
  disconnectHelper();
  helperRestarts = 0;
  return connectHelper();
}
chrome.permissions.onAdded.addListener(reconnectHelper);
chrome.permissions.onRemoved.addListener(reconnectHelper);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.newValue?.swipeTabs !== changes.settings.oldValue?.swipeTabs) reconnectHelper();
});

// ---------------------------------------------------------------------------
// Messages from content scripts and UI pages
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  const handlers = {
    'fit:hello': async () => {
      if (tabId == null) return { zoom: 1 };
      const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
      return { zoom, userZoomed: await userZoomed(tabId) };
    },
    'fit:zoom': () => (tabId == null ? { ok: false } : handleZoom(tabId, msg.factor)),
    'session:restore': async () => {
      const { [HIST_KEY]: hist = [] } = await chrome.storage.local.get(HIST_KEY);
      const entry = msg.id === 'current' ? { snap: (await chrome.storage.local.get(SNAP_KEY))[SNAP_KEY] } : hist.find((h) => h.id === msg.id);
      if (!entry?.snap) return { ok: false };
      const n = await restoreSnapshot(entry.snap, { onlyMissing: msg.onlyMissing !== false, lazy: (await getSettings()).lazyRestore });
      return { ok: true, created: n };
    },
    'session:delete': async () => {
      const { [HIST_KEY]: hist = [] } = await chrome.storage.local.get(HIST_KEY);
      await chrome.storage.local.set({ [HIST_KEY]: hist.filter((h) => h.id !== msg.id) });
      return { ok: true };
    },
    'session:save': async () => {
      await archive(await captureSession(), msg.label || 'Saved manually');
      return { ok: true };
    },
    'session:snapshot-now': async () => { await takeSnapshot(); return { ok: true }; },
    'update:check': () => checkForUpdates(true),
    'swipe:toggle': () => toggleTabStrip(msg.code),
    // The popup and settings ask on open: re-check anything not working yet (e.g. helper just installed).
    'swipe:status': async () => {
      const { swipe } = await chrome.storage.local.get('swipe');
      return swipe?.state === 'ready' && helper ? swipe : reconnectHelper();
    },
    'debug:state': async () => ({
      boot: await chrome.storage.session.get(null),
      current: (await chrome.storage.local.get(SNAP_KEY))[SNAP_KEY],
      history: ((await chrome.storage.local.get(HIST_KEY))[HIST_KEY] || []).map((h) => ({ id: h.id, ts: h.ts, label: h.label, tabs: tabCount(h.snap) })),
    }),
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h()).then(reply, (e) => reply({ ok: false, error: String(e) }));
  return true;
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return;
  if (command === 'toggle-fit') {
    const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
    if (!host) return;
    const s = await getSettings();
    const excludedHosts = s.excludedHosts.includes(host) ? s.excludedHosts.filter((h) => h !== host) : [...s.excludedHosts, host];
    await chrome.storage.local.set({ settings: { ...s, excludedHosts } });
    chrome.tabs.reload(tab.id);
  }
});

// ---------------------------------------------------------------------------
// Updates
//  - CRX installs: Chromium's updater uses update_url; we just nudge it and apply right away.
//  - Unpacked installs (Developer mode "Load unpacked"): reload when the files on disk change
//    (scripts/install.sh keeps the folder current), and flag newer releases on the badge.
// ---------------------------------------------------------------------------
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkForUpdates(manual = false) {
  const current = chrome.runtime.getManifest().version;
  const self = await chrome.management.getSelf().catch(() => ({ installType: 'normal' }));
  const result = { current, installType: self.installType };
  if (self.installType === 'development') {
    try {
      const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
      if (disk.version !== current) { chrome.runtime.reload(); return { ...result, reloading: disk.version }; }
    } catch {}
  } else {
    const status = await chrome.runtime.requestUpdateCheck().catch((e) => ({ status: 'error', error: String(e) }));
    result.status = status?.status;
    if (status?.status === 'update_available') result.latest = status.version;
  }
  try {
    const xml = await (await fetch(UPDATES_XML, { cache: 'no-store' })).text();
    const latest = /version='([\d.]+)'/.exec(xml)?.[1] || /version="([\d.]+)"/.exec(xml)?.[1];
    if (latest) {
      result.latest = latest;
      const behind = newer(latest, current);
      result.behind = behind;
      chrome.action.setBadgeText({ text: behind ? '↑' : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#d9480f' });
    }
  } catch (e) {
    result.fetchError = manual ? String(e) : undefined;
  }
  await chrome.storage.local.set({ updateInfo: { ...result, checked: Date.now() } });
  return result;
}

// Fast reload loop for unpacked installs kept current by scripts/install.sh.
chrome.alarms.create('dev-reload', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'dev-reload') return;
  const self = await chrome.management.getSelf().catch(() => null);
  if (self?.installType !== 'development') return;
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (disk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {}
});

boot();
connectHelper();
