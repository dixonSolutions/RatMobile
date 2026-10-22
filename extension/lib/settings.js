// Shared settings. The content script keeps its own copy of DEFAULTS (it cannot import modules).
export const DEFAULTS = {
  // Fit engine: keep pages from ever scrolling horizontally.
  fitEnabled: true,
  fitZoom: true, // zoom out min-width "apps" so they fit
  minZoom: 0.3,
  // Dock: 'reserve' pushes the page right, 'float' overlays it, 'autohide' slides away while scrolling down, 'off'.
  dockMode: 'reserve',
  dockWidth: 56,
  overlayWidth: 440,
  // Sessions
  autoRestore: true,
  lazyRestore: true,
  historySize: 30,
  excludedHosts: [],
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function faviconUrl(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl || 'about:blank');
  u.searchParams.set('size', String(size));
  return u.toString();
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:') return u.protocol + '//' + u.host;
    return u.host || u.protocol;
  } catch {
    return '';
  }
}

// Live tabs: prefer the favicon the tab reports; fall back to Chromium's favicon cache.
export function tabFavicon(tab, size = 32) {
  const f = tab.favIconUrl;
  if (f && /^(https?:|data:image\/)/.test(f) && f.length < 100000) return f;
  return faviconUrl(tab.pendingUrl || tab.url, size);
}
