// Dock iframe: a slim icon strip that is always usable, and a larger slide-over overlay for picking tabs.
// Open it by swiping right from the strip, tapping the menu button, long-pressing an icon, or Alt+Shift+A.
import { getSettings, tabFavicon } from '../lib/settings.js';
import { icon } from '../lib/icons.js';
import { createTabsView } from './tabs-view.js';

const $ = (s) => document.querySelector(s);
const panel = $('#panel');
const dock = $('#dock');
const strip = $('#strip');
const scrim = $('#scrim');
let settings = await getSettings();
let isOpen = false;
let windowIdPromise = null;

function getWindowId() {
  windowIdPromise ??= chrome.windows.getCurrent().then((w) => w.id);
  return windowIdPromise;
}
chrome.tabs.onAttached.addListener(() => { windowIdPromise = null; renderStrip(); });
chrome.tabs.onDetached.addListener(() => { windowIdPromise = null; renderStrip(); });

function applySizes() {
  document.documentElement.style.setProperty('--dw', settings.dockWidth + 'px');
  document.documentElement.style.setProperty('--ow', settings.overlayWidth + 'px');
}
applySizes();
chrome.storage.onChanged.addListener((c) => {
  if (c.settings) { settings = { ...settings, ...c.settings.newValue }; applySizes(); }
});

$('#open').innerHTML = icon('menu', 22);
$('#new').innerHTML = icon('plus', 22);

const parentPost = (cmd) => parent.postMessage({ ratmobile: true, cmd }, '*');

const view = createTabsView(panel, { getWindowId, onDone: () => close(), onClose: () => close() });

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------
function panelWidth() {
  return Math.min(settings.overlayWidth, innerWidth - 40);
}

function open({ focusSearch = false } = {}) {
  if (!isOpen) parentPost('expand');
  isOpen = true;
  view.reset();
  requestAnimationFrame(() => {
    document.body.classList.add('open');
    panel.style.transform = '';
    scrim.style.opacity = '';
    if (focusSearch) setTimeout(() => view.focusSearch(), 60);
  });
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  view.closeSheet();
  document.body.classList.remove('open');
  panel.style.transform = '';
  scrim.style.opacity = '';
  document.activeElement?.blur?.();
  setTimeout(() => { if (!isOpen) parentPost('collapse'); }, 240);
}

window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data?.ratmobile) return;
  if (e.data.cmd === 'open') open({ focusSearch: e.data.focusSearch });
  if (e.data.cmd === 'close') close();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (view.sheetOpen) view.closeSheet();
  else close();
});
scrim.addEventListener('click', close);
$('#open').addEventListener('click', () => (isOpen ? close() : open()));
$('#new').addEventListener('click', async () => chrome.tabs.create({ windowId: await getWindowId(), active: true }));

// ---------------------------------------------------------------------------
// Swipe: from the dock to the right opens; on the panel to the left closes. The finger drags the panel.
// ---------------------------------------------------------------------------
let swipe = null;
function swipeStart(e, mode) {
  if (e.button !== 0) return;
  swipe = { mode, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, active: false, target: e.currentTarget, lastX: e.clientX, lastT: performance.now(), v: 0 };
}
function swipeMove(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  if (view.busy) { swipe = null; return; }
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    const dirOk = swipe.mode === 'open' ? dx > 10 : dx < -10;
    if (dirOk && Math.abs(dx) > Math.abs(dy) * 1.2) {
      swipe.active = true;
      swipe.target.setPointerCapture?.(e.pointerId);
      document.body.classList.add('dragging');
      if (swipe.mode === 'open' && !isOpen) { parentPost('expand'); view.reset(); }
      suppressClick = true;
    } else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      swipe = null; // vertical: let it scroll
      return;
    } else return;
  }
  const now = performance.now();
  swipe.v = (e.clientX - swipe.lastX) / Math.max(1, now - swipe.lastT);
  swipe.lastX = e.clientX;
  swipe.lastT = now;
  const w = panelWidth();
  const shown = swipe.mode === 'open' ? Math.min(w, Math.max(0, dx)) : Math.min(w, Math.max(0, w + dx));
  panel.style.transform = `translateX(${shown - w}px)`;
  scrim.style.opacity = String(shown / w);
  scrim.style.pointerEvents = 'auto';
}
function swipeEnd(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const s = swipe;
  swipe = null;
  if (!s.active) return;
  document.body.classList.remove('dragging');
  scrim.style.pointerEvents = '';
  const dx = e.clientX - s.x;
  const w = panelWidth();
  if (s.mode === 'open') {
    if (dx > w * 0.28 || s.v > 0.35) { isOpen = true; open(); }
    else { isOpen = true; close(); }
  } else if (-dx > w * 0.25 || s.v < -0.35) close();
  else open();
  setTimeout(() => { suppressClick = false; }, 0);
}
let suppressClick = false;
document.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
dock.addEventListener('pointerdown', (e) => swipeStart(e, 'open'));
panel.addEventListener('pointerdown', (e) => { if (!e.target.closest('input')) swipeStart(e, 'close'); });
for (const el of [dock, panel]) {
  el.addEventListener('pointermove', swipeMove);
  el.addEventListener('pointerup', swipeEnd);
  el.addEventListener('pointercancel', swipeEnd);
}

// ---------------------------------------------------------------------------
// Icon strip
// ---------------------------------------------------------------------------
let stripQueued = false;
async function renderStrip() {
  stripQueued = false;
  const windowId = await getWindowId();
  const tabs = await chrome.tabs.query({ windowId });
  const pinned = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  const btn = (t) => {
    const cls = ['d', t.active ? 'active' : '', t.discarded ? 'discarded' : '', t.status === 'loading' && !t.discarded ? 'loading' : ''].join(' ');
    return `<button class="${cls}" data-tab="${t.id}" title="${(t.title || t.url || '').replace(/"/g, '&quot;')}"><img src="${tabFavicon(t).replace(/"/g, '%22')}" alt="">${t.audible ? '<span class="dot"></span>' : ''}</button>`;
  };
  strip.innerHTML = pinned.map(btn).join('') + (pinned.length ? '<div class="sep"></div>' : '') + rest.map(btn).join('');
  $('#count').textContent = String(tabs.length);
  strip.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}
function queueStrip() {
  if (stripQueued || document.visibilityState === 'hidden') return;
  stripQueued = true;
  setTimeout(renderStrip, 50);
}
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onReplaced']) chrome.tabs[ev].addListener(queueStrip);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderStrip();
  else if (isOpen) close();
});

let iconPress = null;
strip.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b || e.button !== 0) return;
  iconPress = { id: +b.dataset.tab, timer: setTimeout(() => { iconPress = null; suppressClick = true; open(); setTimeout(() => (suppressClick = false), 400); }, 450) };
});
const cancelIconPress = () => { if (iconPress) clearTimeout(iconPress.timer); iconPress = null; };
strip.addEventListener('pointermove', (e) => { if (iconPress && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) cancelIconPress(); });
strip.addEventListener('pointerup', cancelIconPress);
strip.addEventListener('pointercancel', cancelIconPress);
strip.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) chrome.tabs.update(+b.dataset.tab, { active: true });
});
strip.addEventListener('auxclick', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b && e.button === 1) chrome.tabs.remove(+b.dataset.tab);
});
strip.addEventListener('contextmenu', (e) => { e.preventDefault(); open(); });

renderStrip();
