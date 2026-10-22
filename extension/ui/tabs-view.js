// Tab list used by the slide-over overlay (dock.html) and the native side panel (panel.html).
import { faviconUrl, tabFavicon, hostOf } from '../lib/settings.js';
import { icon } from '../lib/icons.js';

const GROUP_COLORS = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};
const LONG_PRESS = 380;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const titleOf = (t) => t.title || hostOf(t.pendingUrl || t.url) || 'New tab';

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function createTabsView(root, { getWindowId, onDone = () => {}, onClose = null }) {
  let view = 'tabs';
  let query = '';
  let renderQueued = false;
  const collapsedWins = new Set();

  root.classList.add('tv');
  root.innerHTML = `
    <div class="tv-head">
      <input class="tv-search" type="search" placeholder="Search tabs" aria-label="Search tabs" autocomplete="off">
      ${onClose ? `<button class="icon-btn" data-act="close" title="Close (Esc)">${icon('x')}</button>` : ''}
    </div>
    <div class="tv-body"></div>
    <div class="tv-foot">
      <button class="pill primary" data-act="new">${icon('plus')}New tab</button>
      <span class="grow"></span>
      <button class="icon-btn" data-act="view" title="Sessions">${icon('history')}</button>
      <button class="icon-btn" data-act="settings" title="Settings">${icon('gear')}</button>
    </div>`;
  const body = root.querySelector('.tv-body');
  const search = root.querySelector('.tv-search');
  const viewBtn = root.querySelector('[data-act="view"]');

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  search.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const first = body.querySelector('[data-tab]');
      if (first) activate(+first.dataset.tab);
    }
  });
  root.querySelector('.tv-foot').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') { await chrome.tabs.create({ windowId: await getWindowId(), active: true }); onDone(); }
    if (act === 'view') { view = view === 'tabs' ? 'sessions' : 'tabs'; viewBtn.innerHTML = icon(view === 'tabs' ? 'history' : 'tabs'); viewBtn.title = view === 'tabs' ? 'Sessions' : 'Tabs'; render(); }
    if (act === 'settings') { chrome.runtime.openOptionsPage(); onDone(); }
  });
  root.querySelector('[data-act="close"]')?.addEventListener('click', () => onClose?.());

  async function activate(tabId) {
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t && t.windowId !== (await getWindowId())) chrome.windows.update(t.windowId, { focused: true });
    onDone();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function tabRow(t) {
    const url = t.pendingUrl || t.url;
    const cls = ['row', t.active ? 'active' : '', t.discarded ? 'discarded' : ''].join(' ');
    const badge = t.audible ? icon(t.mutedInfo?.muted ? 'mute' : 'sound', 16) : t.mutedInfo?.muted ? icon('mute', 16) : '';
    return `<div class="${cls}" data-tab="${t.id}" title="${esc(titleOf(t))}\n${esc(url)}">
      <img class="fav" src="${esc(tabFavicon(t))}" alt="">
      <div class="txt"><div class="title">${esc(titleOf(t))}</div><div class="host">${esc(hostOf(url))}</div></div>
      ${badge ? `<span class="badge">${badge}</span>` : ''}
      <button class="icon-btn x" data-x="${t.id}" title="Close tab" aria-label="Close tab">${icon('x', 18)}</button>
    </div>`;
  }

  function windowSection(w, groups, isCurrent) {
    const pinned = w.tabs.filter((t) => t.pinned);
    const rest = w.tabs.filter((t) => !t.pinned);
    let html = '';
    if (isCurrent) {
      html += `<div class="tv-section" data-zone="pins"><div class="tv-label">${icon('pin', 14)}Pinned <span class="count">${pinned.length || ''}</span></div>`;
      html += pinned.length
        ? `<div class="pins">${pinned.map((t) => `<button class="pin ${t.active ? 'active' : ''}" data-tab="${t.id}" title="${esc(titleOf(t))}"><img class="fav" src="${esc(tabFavicon(t))}" alt=""><span>${esc(titleOf(t))}</span></button>`).join('')}</div>`
        : `<div class="pins-empty">Long-press a tab and choose Pin, or drag it here.</div>`;
      html += `</div>`;
    }
    const label = isCurrent ? 'This window' : `Window · ${w.tabs.length} tabs`;
    const collapsed = !isCurrent && collapsedWins.has(w.id) !== true;
    html += `<div class="tv-section" data-win="${w.id}"><div class="tv-label ${isCurrent ? '' : 'win-head'}" data-win-head="${w.id}">${isCurrent ? '' : icon(collapsed ? 'chevron' : 'window', 14)}${label} <span class="count">${isCurrent ? rest.length : ''}</span></div>`;
    if (!collapsed) {
      html += `<div class="list" data-list="${w.id}">`;
      if (!isCurrent) html += pinned.map(tabRow).join('');
      let openGroup = null;
      for (const t of rest) {
        if (t.groupId !== openGroup) {
          if (openGroup !== null && openGroup !== -1) html += `</div>`;
          openGroup = t.groupId;
          if (t.groupId !== -1) {
            const g = groups.get(t.groupId) || { title: '', color: 'grey', collapsed: false };
            const color = GROUP_COLORS[g.color] || g.color;
            html += `<div class="group-head" data-group="${t.groupId}"><span class="chip" style="background:${color}"></span>${esc(g.title || 'Group')}</div>`;
            html += `<div class="group-body ${g.collapsed ? 'hidden' : ''}" style="--gcolor:${color}">`;
          }
        }
        html += tabRow(t);
      }
      if (openGroup !== null && openGroup !== -1) html += `</div>`;
      html += `</div>`;
    }
    return html + `</div>`;
  }

  async function renderTabs() {
    const currentId = await getWindowId();
    const wins = (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter((w) => !w.incognito || w.id === currentId);
    const groups = new Map((await chrome.tabGroups.query({}).catch(() => [])).map((g) => [g.id, g]));
    if (query) {
      const hits = wins.flatMap((w) => w.tabs).filter((t) => (titleOf(t) + ' ' + (t.pendingUrl || t.url)).toLowerCase().includes(query));
      return hits.length ? `<div class="tv-section">${hits.map(tabRow).join('')}</div>` : `<div class="empty">No tabs match “${esc(query)}”.</div>`;
    }
    const cur = wins.find((w) => w.id === currentId) || wins[0];
    let html = cur ? windowSection(cur, groups, true) : '';
    for (const w of wins) if (w !== cur) html += windowSection(w, groups, false);
    return html;
  }

  async function renderSessions() {
    const { 'snap:history': hist = [], 'snap:current': cur } = await chrome.storage.local.get(['snap:history', 'snap:current']);
    const entries = hist.filter((h) => !query || h.label.toLowerCase().includes(query) || h.snap.windows.some((w) => w.tabs.some((t) => (t.title + t.url).toLowerCase().includes(query))));
    let html = `<div class="tv-section"><div class="tv-label">${icon('history', 14)}Session snapshots</div>
      <div class="snap-actions" style="margin:0 2px 6px"><button class="pill" data-snap-save>${icon('save', 18)}Save current session</button></div>`;
    if (cur) html += `<div class="snap-meta" style="padding:0 10px 4px">Live snapshot updated ${relTime(cur.ts)} — survives crashes and force shutdowns.</div>`;
    if (!entries.length) html += `<div class="empty">No saved snapshots yet.</div>`;
    for (const h of entries) {
      const tabs = h.snap.windows.flatMap((w) => w.tabs);
      html += `<div class="snap" data-snap="${h.id}">
        <div class="snap-top"><div class="snap-title">${esc(h.label)}</div><div class="snap-meta">${relTime(h.ts)}</div></div>
        <div class="snap-meta">${h.snap.windows.length} window${h.snap.windows.length > 1 ? 's' : ''} · ${tabs.length} tabs · ${tabs.filter((t) => t.pinned).length} pinned</div>
        <div class="snap-favs">${tabs.slice(0, 40).map((t) => `<img src="${faviconUrl(t.url, 16)}" title="${esc(t.title || t.url)}" alt="">`).join('')}</div>
        <div class="snap-actions">
          <button class="pill" data-snap-restore="${h.id}">${icon('restore', 18)}Restore missing</button>
          <button class="pill" data-snap-all="${h.id}">${icon('window', 18)}Open all</button>
          <button class="pill" data-snap-del="${h.id}" title="Delete snapshot">${icon('trash', 18)}</button>
        </div></div>`;
    }
    return html + `</div>`;
  }

  async function render() {
    renderQueued = false;
    const scroll = body.scrollTop;
    body.innerHTML = view === 'tabs' ? await renderTabs() : await renderSessions();
    body.scrollTop = scroll;
  }

  function queueRender() {
    if (renderQueued || document.visibilityState === 'hidden') return;
    renderQueued = true;
    setTimeout(render, 60);
  }

  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onAttached', 'onDetached', 'onReplaced']) {
    chrome.tabs[ev].addListener(queueRender);
  }
  chrome.tabGroups?.onUpdated.addListener(queueRender);
  chrome.storage.onChanged.addListener((c) => { if (view === 'sessions' && (c['snap:history'] || c['snap:current'])) queueRender(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

  // ---------------------------------------------------------------------------
  // Pointer interactions: tap = switch, long-press = actions, long-press + move (or mouse drag) = reorder.
  // ---------------------------------------------------------------------------
  let press = null;
  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-x],button[data-snap-restore],button[data-snap-all],button[data-snap-del],[data-snap-save]')) return;
    const el = e.target.closest('[data-tab]');
    if (!el) return;
    press = { el, id: +el.dataset.tab, x: e.clientX, y: e.clientY, lifted: false, dragging: false, pointerId: e.pointerId, mouse: e.pointerType === 'mouse' };
    press.timer = setTimeout(() => {
      if (!press) return;
      press.lifted = true;
      navigator.vibrate?.(15);
      el.classList.add('dragging');
    }, LONG_PRESS);
  });
  body.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.pointerId) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    const dist = Math.hypot(dx, dy);
    if (!press.lifted && !press.dragging) {
      if (press.mouse && dist > 6 && press.el.classList.contains('row')) startDrag(e);
      else if (dist > 8) cancelPress();
      return;
    }
    if (press.lifted && !press.dragging && dist > 6) startDrag(e);
    if (press.dragging) moveDrag(e);
  });
  // While dragging with a finger, stop the panel from scrolling.
  body.addEventListener('touchmove', (e) => { if (press?.lifted || press?.dragging) e.preventDefault(); }, { passive: false });
  body.addEventListener('pointerup', async (e) => {
    if (!press || e.pointerId !== press.pointerId) return;
    const p = press;
    cancelPress();
    if (p.dragging) return endDrag(p, e);
    if (p.lifted) return openSheet(p.id);
    activate(p.id);
  });
  body.addEventListener('pointercancel', () => { if (press?.dragging) clearDrag(); cancelPress(); });
  body.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-tab]');
    if (!el) return;
    e.preventDefault();
    cancelPress();
    openSheet(+el.dataset.tab);
  });
  body.addEventListener('auxclick', (e) => {
    const el = e.target.closest('[data-tab]');
    if (e.button === 1 && el) { e.preventDefault(); chrome.tabs.remove(+el.dataset.tab); }
  });
  body.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]');
    if (x) { e.stopPropagation(); chrome.tabs.remove(+x.dataset.x); return; }
    const wh = e.target.closest('[data-win-head]');
    if (wh && wh.classList.contains('win-head')) {
      const id = +wh.dataset.winHead;
      collapsedWins.has(id) ? collapsedWins.delete(id) : collapsedWins.add(id);
      return render();
    }
    const gh = e.target.closest('[data-group]');
    if (gh) {
      const g = await chrome.tabGroups.get(+gh.dataset.group);
      chrome.tabGroups.update(g.id, { collapsed: !g.collapsed });
      return;
    }
    const send = (msg) => chrome.runtime.sendMessage(msg);
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.snapSave !== undefined) await send({ type: 'session:save' });
    else if (t.dataset.snapRestore) { await send({ type: 'session:restore', id: t.dataset.snapRestore, onlyMissing: true }); onDone(); }
    else if (t.dataset.snapAll) { await send({ type: 'session:restore', id: t.dataset.snapAll, onlyMissing: false }); onDone(); }
    else if (t.dataset.snapDel) await send({ type: 'session:delete', id: t.dataset.snapDel });
    render();
  });

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    if (press && !press.dragging) press.el.classList.remove('dragging');
    press = null;
  }

  let drag = null;
  function startDrag(e) {
    press.dragging = true;
    press.el.classList.add('dragging');
    press.el.setPointerCapture?.(e.pointerId);
    drag = { line: document.createElement('div') };
    drag.line.className = 'drop-line';
  }
  function moveDrag(e) {
    const dy = e.clientY - press.y;
    press.el.style.transform = `translateY(${dy}px)`;
    // Auto-scroll near the edges.
    const r = body.getBoundingClientRect();
    if (e.clientY < r.top + 40) body.scrollTop -= 12;
    if (e.clientY > r.bottom - 40) body.scrollTop += 12;
    const pinZone = body.querySelector('[data-zone="pins"]');
    drag.toPins = !!pinZone && e.clientY < pinZone.getBoundingClientRect().bottom;
    pinZone?.classList.toggle('drop-target', drag.toPins);
    const rows = [...body.querySelectorAll('.row[data-tab]')].filter((r) => r !== press.el);
    drag.before = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; }) || null;
    if (drag.toPins) drag.line.remove();
    else if (drag.before) drag.before.before(drag.line);
    else rows.at(-1)?.after(drag.line);
  }
  function clearDrag() {
    drag?.line.remove();
    body.querySelector('.drop-target')?.classList.remove('drop-target');
    drag = null;
  }
  async function endDrag(p) {
    const d = drag;
    clearDrag();
    p.el.style.transform = '';
    p.el.classList.remove('dragging');
    const tab = await chrome.tabs.get(p.id).catch(() => null);
    if (!tab || !d) return render();
    if (d.toPins) {
      await chrome.tabs.update(tab.id, { pinned: true });
    } else {
      const target = d.before ? await chrome.tabs.get(+d.before.dataset.tab).catch(() => null) : null;
      if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
      if (target && target.windowId !== tab.windowId) {
        await chrome.tabs.move(tab.id, { windowId: target.windowId, index: target.index });
      } else if (target) {
        const fresh = await chrome.tabs.get(tab.id);
        await chrome.tabs.move(tab.id, { index: fresh.index < target.index ? target.index - 1 : target.index });
      } else {
        await chrome.tabs.move(tab.id, { index: -1 });
      }
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Action sheet
  // ---------------------------------------------------------------------------
  async function openSheet(tabId) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    const muted = t.mutedInfo?.muted;
    const scrim = document.createElement('div');
    scrim.className = 'sheet-scrim';
    scrim.innerHTML = `<div class="sheet" role="menu">
      <h3>${esc(titleOf(t))}</h3>
      <button data-a="pin">${icon(t.pinned ? 'unpin' : 'pin')}${t.pinned ? 'Unpin' : 'Pin to top'}</button>
      <button data-a="dup">${icon('copy')}Duplicate</button>
      <button data-a="mute">${icon(muted ? 'sound' : 'mute')}${muted ? 'Unmute' : 'Mute'}</button>
      <button data-a="reload">${icon('reload')}Reload</button>
      <button data-a="win">${icon('window')}Move to new window</button>
      <button data-a="close" class="danger">${icon('x')}Close tab</button>
    </div>`;
    document.body.appendChild(scrim);
    scrim.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      scrim.remove();
      if (a === 'pin') await chrome.tabs.update(t.id, { pinned: !t.pinned });
      if (a === 'dup') await chrome.tabs.duplicate(t.id);
      if (a === 'mute') await chrome.tabs.update(t.id, { muted: !muted });
      if (a === 'reload') await chrome.tabs.reload(t.id);
      if (a === 'win') await chrome.windows.create({ tabId: t.id });
      if (a === 'close') await chrome.tabs.remove(t.id);
    });
  }

  render();
  return {
    render,
    focusSearch() { search.focus(); search.select(); },
    reset() { query = ''; search.value = ''; view = 'tabs'; viewBtn.innerHTML = icon('history'); render(); },
    get busy() { return !!(press && (press.lifted || press.dragging)); },
    get sheetOpen() { return !!document.querySelector('.sheet-scrim'); },
    closeSheet() { document.querySelector('.sheet-scrim')?.remove(); },
  };
}
