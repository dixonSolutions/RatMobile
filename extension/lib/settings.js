// Shared settings. The content script keeps its own copy of DEFAULTS (it cannot import modules).
export const DEFAULTS = {
  // Fit engine: keep pages from ever scrolling horizontally.
  fitEnabled: true,
  fitZoom: true, // zoom out min-width "apps" so they fit
  minZoom: 0.3,
  // Sessions
  autoRestore: true,
  lazyRestore: true,
  historySize: 30,
  excludedHosts: [],
  // Swipe from the left edge of a page to open/close Chromium's vertical tab strip (needs the helper).
  swipeTabs: true,
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

// Tab strip swipes need the optional nativeMessaging permission to reach RatMobile's helper.
// Call from a click (the permission prompt needs a user gesture).
export async function setSwipeTabs(on) {
  if (on && !(await chrome.permissions.request({ permissions: ['nativeMessaging'] }).catch(() => false))) return false;
  await setSettings({ swipeTabs: on });
  return on;
}

const INSTALL = 'https://dixonsolutions.github.io/RatMobile/';
export function swipeStatusHtml(swipe) {
  switch (swipe?.state) {
    case 'ready': return 'From the left edge of a page, swipe right to open the tab list and left to close it.';
    case 'off': return 'Off.';
    case 'no-permission': return 'Turn on, then allow RatMobile to talk to its helper.';
    case 'no-helper': return `Needs RatMobile's small helper program: run the <a href="${INSTALL}" target="_blank" rel="noopener">installer</a> again, then reopen this.`;
    case 'error': return `The helper can't press keys: ${String(swipe.error || '').replace(/[<>&]/g, '')}. See <a href="${INSTALL}" target="_blank" rel="noopener">install notes</a>.`;
    default: return 'Checking…';
  }
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

