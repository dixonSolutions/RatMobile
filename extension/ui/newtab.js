import { faviconUrl, hostOf } from '../lib/settings.js';
import { icon } from '../lib/icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || (/^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(q) && !q.includes(' '));
  if (looksLikeUrl) location.href = /^[a-z][a-z0-9+.-]*:\/\//i.test(q) ? q : 'https://' + q;
  else chrome.search.query({ text: q, disposition: 'CURRENT_TAB' });
});

chrome.topSites.get((sites) => {
  document.getElementById('tiles').innerHTML = sites.slice(0, 12).map((s) => `
    <a class="tile" href="${esc(s.url)}"><div class="ic"><img src="${faviconUrl(s.url, 32)}" alt=""></div><span>${esc(s.title || hostOf(s.url))}</span></a>`).join('');
});

// Offer the last session if this window looks like a fresh start and tabs from it are missing.
const { 'snap:history': hist = [] } = await chrome.storage.local.get('snap:history');
const tabs = await chrome.tabs.query({});
const open = new Set(tabs.map((t) => t.url));
const prev = hist.find((h) => h.label === 'Previous session') || hist[0];
if (prev) {
  const missing = prev.snap.windows.flatMap((w) => w.tabs).filter((t) => !open.has(t.url) && !/^chrome:\/\/newtab/.test(t.url));
  if (missing.length && tabs.length <= 2) {
    const card = document.getElementById('restore');
    card.classList.remove('hidden');
    card.innerHTML = `<div class="grow"><div><b>${esc(prev.label)}</b> has ${missing.length} tab${missing.length > 1 ? 's' : ''} not open</div>
      <div class="meta">${new Date(prev.ts).toLocaleString()}</div></div>
      <button class="pill primary" id="restoreBtn">${icon('restore', 18)}Restore</button>`;
    document.getElementById('restoreBtn').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'session:restore', id: prev.id, onlyMissing: true });
      card.classList.add('hidden');
    });
  }
}
