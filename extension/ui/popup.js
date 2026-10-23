// Toolbar popup: per-site fit toggle and the session snapshot history.
import { getSettings, setSettings, faviconUrl } from '../lib/settings.js';
import { icon } from '../lib/icons.js';

const $ = (s) => document.getElementById(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

$('settings').innerHTML = icon('gear');
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('save').innerHTML = `${icon('save', 18)}Save current session`;
$('snapLabel').innerHTML = `${icon('history', 14)}Session snapshots`;

// ---- This site ----
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
const settings = await getSettings();
$('host').textContent = host || 'This page';
$('fit').checked = settings.fitEnabled && !settings.excludedHosts.includes(host);
$('fit').disabled = !host || !settings.fitEnabled;
const status = host ? await chrome.tabs.sendMessage(tab.id, { type: 'fit:status' }, { frameId: 0 }).catch(() => null) : null;
$('state').textContent = !host ? 'Fit to width does not run on this page'
  : !settings.fitEnabled ? 'Fit to width is off in settings'
  : !status ? 'Fit to width (reload the page to apply)'
  : status.zoom < 1 ? `Zoomed to ${Math.round(status.zoom * 100)}% to fit · pinch to zoom in`
  : status.fixes ? `Fit to width · ${status.fixes} element${status.fixes > 1 ? 's' : ''} reflowed`
  : 'Fit to width · nothing needed fixing';
$('fit').addEventListener('change', async () => {
  const s = await getSettings();
  const excludedHosts = $('fit').checked ? s.excludedHosts.filter((h) => h !== host) : [...new Set([...s.excludedHosts, host])];
  await setSettings({ excludedHosts });
  chrome.tabs.reload(tab.id);
});

// ---- Snapshots ----
async function render() {
  const { 'snap:history': hist = [], 'snap:current': cur } = await chrome.storage.local.get(['snap:history', 'snap:current']);
  let html = cur ? `<div class="snap-meta">Live snapshot updated ${relTime(cur.ts)}. It survives crashes and force shutdowns.</div>` : '';
  if (!hist.length) html += `<div class="empty">No saved snapshots yet.</div>`;
  for (const h of hist) {
    const tabs = h.snap.windows.flatMap((w) => w.tabs);
    html += `<div class="snap">
      <div class="snap-top"><div class="snap-title">${esc(h.label)}</div><div class="snap-meta">${relTime(h.ts)}</div></div>
      <div class="snap-meta">${h.snap.windows.length} window${h.snap.windows.length > 1 ? 's' : ''} · ${tabs.length} tabs · ${tabs.filter((t) => t.pinned).length} pinned</div>
      <div class="snap-favs">${tabs.slice(0, 40).map((t) => `<img src="${faviconUrl(t.url, 16)}" title="${esc(t.title || t.url)}" alt="">`).join('')}</div>
      <div class="snap-actions">
        <button class="pill" data-restore="${h.id}">${icon('restore', 18)}Restore missing</button>
        <button class="pill" data-all="${h.id}">${icon('window', 18)}Open all</button>
        <button class="pill" data-del="${h.id}" title="Delete snapshot" aria-label="Delete snapshot">${icon('trash', 18)}</button>
      </div></div>`;
  }
  $('snaps').innerHTML = html;
}
$('save').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'session:save' }); render(); });
$('snaps').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.restore) await chrome.runtime.sendMessage({ type: 'session:restore', id: b.dataset.restore, onlyMissing: true });
  if (b.dataset.all) await chrome.runtime.sendMessage({ type: 'session:restore', id: b.dataset.all, onlyMissing: false });
  if (b.dataset.del) await chrome.runtime.sendMessage({ type: 'session:delete', id: b.dataset.del });
  render();
});
render();
