import { getSettings, setSettings } from '../lib/settings.js';

const s = await getSettings();
for (const el of document.querySelectorAll('[data-k]')) {
  const k = el.dataset.k;
  if (el.type === 'checkbox') el.checked = !!s[k];
  else if ('list' in el.dataset) el.value = s[k].join('\n');
  else el.value = String(s[k]);
  el.addEventListener('change', () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if ('num' in el.dataset) v = Number(v);
    if ('list' in el.dataset) v = v.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    setSettings({ [k]: v });
  });
}

document.getElementById('ver').textContent = chrome.runtime.getManifest().version;
const self = await chrome.management.getSelf();
document.getElementById('itype').textContent = self.installType === 'development' ? 'Load unpacked (developer)' : 'CRX (auto-updating)';
document.getElementById('ihelp').textContent = self.installType === 'development'
  ? 'Chromium does not update unpacked extensions. Run scripts/install.sh once and it keeps this folder current; RatMobile reloads itself when it changes.'
  : 'Chromium checks for updates every few hours; RatMobile applies them right away.';

const upd = document.getElementById('upd');
function show(info) {
  if (!info) return;
  upd.textContent = `Last check ${new Date(info.checked || Date.now()).toLocaleString()} · running ${info.current}` +
    (info.latest ? ` · latest ${info.latest}` : '') + (info.behind ? ' (update pending)' : '') + (info.status ? ` · updater: ${info.status}` : '') +
    (info.fetchError ? `\n${info.fetchError}` : '');
}
show((await chrome.storage.local.get('updateInfo')).updateInfo);
document.getElementById('check').addEventListener('click', async () => {
  upd.textContent = 'Checking…';
  show({ ...(await chrome.runtime.sendMessage({ type: 'update:check' })), checked: Date.now() });
});
