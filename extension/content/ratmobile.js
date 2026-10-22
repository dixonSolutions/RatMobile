// RatMobile content script: fit engine (no page-level horizontal scrolling, ever) + dock host.
// Runs at document_start in the top frame of every page (and is loaded directly by the new tab page).
(() => {
  if (window.top !== window) return;

  const DEFAULTS = {
    fitEnabled: true,
    fitZoom: true,
    minZoom: 0.3,
    dockMode: 'reserve',
    dockWidth: 56,
    overlayWidth: 440,
    excludedHosts: [],
  };
  const ATTR_FIX = 'data-rm-fix';
  const ATTR_SHIFT = 'data-rm-shift';
  const isExtensionPage = location.protocol === 'chrome-extension:';
  const log = (...a) => { if (window.__ratmobileDebug) console.debug('[RatMobile]', ...a); };

  // A previous instance (e.g. before an extension update) tears itself down when a new one starts.
  document.dispatchEvent(new CustomEvent('ratmobile:teardown'));
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  let settings = { ...DEFAULTS };
  let alive = true;

  function extensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function send(msg) {
    if (!extensionAlive()) { teardown(); return Promise.resolve(null); }
    return chrome.runtime.sendMessage(msg).catch(() => null);
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const style = document.createElement('style');
  style.id = 'ratmobile-style';
  function css() {
    const d = dockActive() && settings.dockMode === 'reserve' ? settings.dockWidth : 0;
    return `
html{--rm-dock:${d}px}
${d ? `html{margin-left:${d}px!important;width:auto!important;}` : ''}
html[data-rm-clip]{overflow-x:clip!important}
html[data-rm-clip] > body{overflow-x:clip!important}
[${ATTR_FIX}~=media]{max-width:100%!important}
img[${ATTR_FIX}~=media],video[${ATTR_FIX}~=media],canvas[${ATTR_FIX}~=media]{height:auto!important}
[${ATTR_FIX}~=pre]{white-space:pre-wrap!important;overflow-wrap:anywhere!important;max-width:100%!important}
[${ATTR_FIX}~=text]{overflow-wrap:anywhere!important;min-width:0!important}
[${ATTR_FIX}~=table]{max-width:100%!important}
[${ATTR_FIX}~=table] :is(td,th){overflow-wrap:anywhere!important}
[${ATTR_FIX}~=scrollbox]{display:block!important;overflow-x:auto!important;max-width:100%!important}
[${ATTR_FIX}~=box]{max-width:100%!important;min-width:0!important;box-sizing:border-box!important}
[${ATTR_FIX}~=wrap]{flex-wrap:wrap!important}
[${ATTR_FIX}~=box2]{width:auto!important;flex-shrink:1!important}
[${ATTR_FIX}~=vw]{max-width:calc(100vw - var(--rm-dock) - 16px)!important}
#ratmobile-dock{all:initial!important;position:fixed!important;left:0!important;top:0!important;bottom:0!important;height:100%!important;
  width:var(--rm-frame-w,${settings.dockWidth}px)!important;border:0!important;margin:0!important;padding:0!important;
  z-index:2147483647!important;display:block!important;color-scheme:light dark!important;background:transparent!important;
  transform:translateX(var(--rm-frame-x,0px))!important;transition:transform .2s ease!important;visibility:visible!important;opacity:1!important}
html[data-rm-fullscreen] #ratmobile-dock{display:none!important}
#ratmobile-edge{all:initial!important;position:fixed!important;left:0!important;top:0!important;bottom:0!important;width:14px!important;
  z-index:2147483646!important;touch-action:none!important;display:block!important}
`;
  }
  function applyStyle() {
    style.textContent = css();
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Fit engine
  // ---------------------------------------------------------------------------
  const fit = {
    zoom: 1, // current browser zoom (as told by background)
    baseZoom: null, // zoom before we started fitting
    zoomSteps: 0,
    userZoomed: false,
    clipped: false,
    passes: 0,
    scheduled: false,
    lastRun: 0,
    lastWidth: 0,
  };

  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'SVG', 'IFRAME', 'EMBED', 'OBJECT']);
  const PRE = new Set(['PRE', 'CODE', 'SAMP', 'KBD', 'TEXTAREA', 'XMP', 'LISTING']);

  function siteExcluded() {
    return settings.excludedHosts.includes(location.hostname);
  }

  function hasResponsiveViewport() {
    const m = document.querySelector('meta[name="viewport" i]');
    return !!m && /width\s*=\s*device-width/i.test(m.content || '');
  }

  function overflowPx() {
    const de = document.documentElement;
    if (!de) return 0;
    return de.scrollWidth - de.clientWidth;
  }

  function addFix(el, kind) {
    const cur = el.getAttribute(ATTR_FIX) || '';
    if (cur.split(' ').includes(kind)) return false;
    el.setAttribute(ATTR_FIX, (cur + ' ' + kind).trim());
    return true;
  }

  // Walk the DOM (skipping subtrees that clip horizontally or are fixed) and return the
  // "root culprits": elements sticking out past the right edge whose parent does not.
  function findCulprits(vw) {
    const out = [];
    const sx = window.scrollX;
    const limit = vw + 1;
    let visited = 0;
    const stack = [[document.body, false]];
    while (stack.length) {
      const [el, parentOver] = stack.pop();
      if (!el || ++visited > 20000) break;
      if (el.id === 'ratmobile-dock' || el.id === 'ratmobile-edge') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      const right = r.right + sx;
      const over = right > limit && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
      if (over && !parentOver) out.push({ el, r: { left: r.left + sx, right, width: r.width }, cs });
      // Text sticking out of an element whose box fits.
      if (!over && el.childElementCount === 0 && r.width > 0 && el.scrollWidth > el.clientWidth + 1 && r.left + sx + el.scrollWidth > limit) {
        if (cs.overflowX === 'visible') out.push({ el, r: { left: r.left + sx, right: r.left + sx + el.scrollWidth, width: r.width }, cs, text: true });
      }
      if (cs.overflowX !== 'visible' || MEDIA.has(el.tagName.toUpperCase())) continue;
      for (let i = el.children.length - 1; i >= 0; i--) stack.push([el.children[i], parentOver || over]);
    }
    return out;
  }

  function fixCulprit({ el, r, cs, text }, vw, responsive, pass) {
    const tag = el.tagName.toUpperCase();
    if (r.left >= vw - 1) return 'offscreen';
    if (text) return addFix(el, 'text') ? 'text' : null;
    if (MEDIA.has(tag)) return addFix(el, 'media') ? 'media' : null;
    if (PRE.has(tag) || cs.whiteSpace === 'pre' || cs.whiteSpace === 'nowrap') {
      if (PRE.has(tag)) return addFix(el, 'pre') ? 'pre' : null;
    }
    if (tag === 'TABLE') {
      if (addFix(el, 'table')) return 'table';
      return addFix(el, 'scrollbox') ? 'scrollbox' : null;
    }
    // Full-bleed element just slightly too wide (100vw + scrollbar / dock): always safe to clamp.
    const nearFull = r.width >= vw * 0.85 && r.right <= vw + settings.dockWidth + 24;
    if (nearFull) {
      if (addFix(el, 'box')) return 'box';
      if (addFix(el, 'vw')) return 'vw';
    }
    if (responsive) {
      // Overflowing item in a single-line flex row: let the row wrap, like a phone layout would.
      const p = el.parentElement;
      if (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        if (/flex/.test(pcs.display) && pcs.flexWrap === 'nowrap' && pcs.flexDirection.startsWith('row') && pcs.overflowX === 'visible') {
          if (addFix(p, 'wrap')) return 'wrap';
        }
      }
      if (addFix(el, 'box')) return 'box';
      if (pass > 0 && addFix(el, 'box2')) return 'box2';
      if (pass > 0 && addFix(el, 'text')) return 'text';
    }
    return null;
  }

  function setClip(v) {
    if (v === fit.clipped) return;
    fit.clipped = v;
    if (v) document.documentElement.setAttribute('data-rm-clip', '');
    else document.documentElement.removeAttribute('data-rm-clip');
  }

  async function requestZoom(factor) {
    const res = await send({ type: 'fit:zoom', factor });
    if (!res || !res.ok) {
      if (res && res.reason === 'user') fit.userZoomed = true;
      return false;
    }
    fit.zoom = res.zoom;
    return true;
  }

  function scheduleFit(delay = 0) {
    if (fit.scheduled || !alive) return;
    fit.scheduled = true;
    const wait = Math.max(delay, 200 - (performance.now() - fit.lastRun));
    setTimeout(() => requestAnimationFrame(runFit), wait);
  }

  async function runFit() {
    fit.scheduled = false;
    fit.lastRun = performance.now();
    if (!alive || !document.body) return;
    if (!settings.fitEnabled || siteExcluded()) { setClip(false); return; }
    if (document.fullscreenElement) return;

    const vw = document.documentElement.clientWidth;
    let over = overflowPx();
    if (over <= 1) return;
    // Measure without our own clip so we see the real overflow.
    if (fit.clipped) {
      setClip(false);
      over = overflowPx();
      if (over <= 1) return;
    }
    const responsive = hasResponsiveViewport();
    let offscreenOnly = true;
    for (let pass = 0; pass < 3 && over > 1; pass++) {
      const culprits = findCulprits(vw);
      if (!culprits.length) { offscreenOnly = false; break; }
      let changed = 0;
      for (const c of culprits.slice(0, 300)) {
        // An earlier fix in this pass (e.g. wrapping its row) may already have pulled it back in.
        if (changed && !c.text && c.el.getBoundingClientRect().right + window.scrollX <= vw + 1) continue;
        const kind = fixCulprit(c, vw, responsive, pass);
        if (kind !== 'offscreen') offscreenOnly = false;
        if (kind && kind !== 'offscreen') { changed++; log('fix', kind, c.el); }
      }
      if (!changed) break;
      over = overflowPx();
    }
    if (over <= 1) return;

    const ratio = (vw + over) / vw;
    // Off-canvas menus etc. sitting fully outside the viewport, or a tiny residue: just clip.
    if (offscreenOnly || ratio <= 1.04 || !settings.fitZoom || fit.userZoomed || isExtensionPage) {
      setClip(true);
      return;
    }
    // Min-width web apps: zoom out so the whole layout fits.
    if (fit.zoomSteps < 4) {
      if (fit.baseZoom == null) fit.baseZoom = fit.zoom;
      const target = Math.max(settings.minZoom, Math.floor((fit.zoom / ratio) * 100) / 100);
      if (target < fit.zoom - 0.005) {
        fit.zoomSteps++;
        log('zoom', fit.zoom, '->', target, 'ratio', ratio);
        if (await requestZoom(target)) return; // resize triggers another pass
      }
    }
    // At the zoom floor, only clip a small residue: never hide real content the user can't reach.
    if (ratio <= 1.04) setClip(true);
  }

  // When the window gets wider (rotation, un-snap), undo our zoom and fit again from scratch.
  function onResize() {
    const w = window.innerWidth * (fit.zoom || 1);
    if (fit.baseZoom != null && w > fit.lastWidth + 40 && fit.zoom < fit.baseZoom) {
      const base = fit.baseZoom;
      fit.baseZoom = null;
      fit.zoomSteps = 0;
      requestZoom(base);
    }
    fit.lastWidth = w;
    scheduleFit(100);
  }

  // ---------------------------------------------------------------------------
  // Reserve-space dock: shift fixed elements that would sit underneath it.
  // ---------------------------------------------------------------------------
  const shifted = new Map(); // el -> original inline values

  function shiftFixed(el) {
    if (!(el instanceof HTMLElement) || el.id === 'ratmobile-dock' || el.id === 'ratmobile-edge') return;
    const D = settings.dockWidth;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') {
      if (shifted.has(el) && !el.isConnected) shifted.delete(el);
      return;
    }
    if (shifted.has(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= 0 || r.left >= D - 0.5) return;
    const orig = {
      left: el.style.getPropertyValue('left'), leftP: el.style.getPropertyPriority('left'),
      maxWidth: el.style.getPropertyValue('max-width'), maxWidthP: el.style.getPropertyPriority('max-width'),
    };
    if (cs.left !== 'auto') {
      el.style.setProperty('left', `${parseFloat(cs.left) + D}px`, 'important');
    } else if (cs.right === 'auto') {
      return; // static position: already inside the shifted root
    }
    if (r.width > window.innerWidth - D - 1) el.style.setProperty('max-width', `calc(100% - ${D}px)`, 'important');
    el.setAttribute(ATTR_SHIFT, '');
    shifted.set(el, orig);
  }

  function unshiftAll() {
    for (const [el, o] of shifted) {
      el.style.removeProperty('left');
      el.style.removeProperty('max-width');
      if (o.left) el.style.setProperty('left', o.left, o.leftP);
      if (o.maxWidth) el.style.setProperty('max-width', o.maxWidth, o.maxWidthP);
      el.removeAttribute(ATTR_SHIFT);
    }
    shifted.clear();
  }

  function scanFixed(root = document.body) {
    if (!root || !reserving()) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = 0;
    for (let el = walker.currentNode; el && n < 30000; el = walker.nextNode(), n++) shiftFixed(el);
  }

  // ---------------------------------------------------------------------------
  // Dock host
  // ---------------------------------------------------------------------------
  let frame = null;
  let edge = null;
  let dockState = 'closed'; // 'closed' | 'open' | 'hidden'

  function dockActive() {
    return settings.dockMode !== 'off' && !siteExcluded() && innerWidth >= 360;
  }
  function reserving() {
    return dockActive() && settings.dockMode === 'reserve';
  }

  function setFrame(width, x = 0) {
    if (!frame) return;
    frame.style.setProperty('--rm-frame-w', typeof width === 'number' ? width + 'px' : width);
    frame.style.setProperty('--rm-frame-x', x + 'px');
  }

  function mountDock() {
    if (!dockActive() || frame || !document.documentElement) return;
    frame = document.createElement('iframe');
    frame.id = 'ratmobile-dock';
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('aria-label', 'RatMobile tabs');
    frame.src = chrome.runtime.getURL('ui/dock.html');
    document.documentElement.appendChild(frame);
    setFrame(settings.dockWidth);
    if (settings.dockMode === 'autohide') {
      edge = document.createElement('div');
      edge.id = 'ratmobile-edge';
      document.documentElement.appendChild(edge);
      edge.addEventListener('pointerdown', (e) => { e.preventDefault(); showDock(); }, { passive: false });
    }
  }

  function unmountDock() {
    frame?.remove();
    edge?.remove();
    frame = edge = null;
  }

  function post(msg) {
    frame?.contentWindow?.postMessage({ ratmobile: true, ...msg }, '*');
  }

  function openOverlay(focusSearch = false) {
    if (!frame) mountDock();
    if (!frame) return;
    dockState = 'open';
    setFrame('100vw');
    post({ cmd: 'open', focusSearch });
  }

  function showDock() {
    if (!frame) return;
    if (dockState === 'hidden') { dockState = 'closed'; setFrame(settings.dockWidth, 0); }
  }

  // Messages from the dock iframe. Only accept from our own frame; commands are UI-only.
  on(window, 'message', (e) => {
    if (!frame || e.source !== frame.contentWindow || !e.data?.ratmobile) return;
    const { cmd } = e.data;
    if (cmd === 'expand') { dockState = 'open'; setFrame('100vw'); }
    else if (cmd === 'collapse') { dockState = 'closed'; setFrame(settings.dockWidth); }
  });

  // A clipped root still lets scripts (focus(), scrollIntoView) move the viewport sideways: snap back.
  on(window, 'scroll', () => {
    if (fit.clipped && window.scrollX !== 0) window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
  }, { passive: true });

  // Autohide: slide the dock away while scrolling down, back when scrolling up.
  let lastY = 0;
  on(window, 'scroll', () => {
    if (settings.dockMode !== 'autohide' || !frame || dockState === 'open') return;
    const y = window.scrollY;
    if (y > lastY + 12 && y > 80 && dockState === 'closed') { dockState = 'hidden'; setFrame(settings.dockWidth, -settings.dockWidth); }
    else if (y < lastY - 12 && dockState === 'hidden') showDock();
    lastY = y;
  }, { passive: true });

  on(document, 'fullscreenchange', () => {
    if (document.fullscreenElement) document.documentElement.setAttribute('data-rm-fullscreen', '');
    else document.documentElement.removeAttribute('data-rm-fullscreen');
  });

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  const mo = new MutationObserver((records) => {
    let fitDirty = false;
    for (const rec of records) {
      if (rec.type === 'childList') {
        fitDirty = true;
        if (reserving()) for (const n of rec.addedNodes) if (n.nodeType === 1) scanFixed(n);
        // Keep our nodes attached: some SPAs replace <html> children wholesale.
        if (frame && !frame.isConnected) document.documentElement.appendChild(frame);
        if (!style.isConnected) applyStyle();
      } else if (rec.type === 'attributes') {
        const t = rec.target;
        if (rec.attributeName === ATTR_FIX || rec.attributeName === ATTR_SHIFT || t === frame) continue;
        if (rec.attributeName === 'data-rm-clip' || rec.attributeName === 'data-rm-fullscreen') continue;
        fitDirty = true;
        if (reserving() && t.nodeType === 1 && !shifted.has(t)) shiftFixed(t);
      }
    }
    if (fitDirty) scheduleFit(300);
  });

  function applySettings() {
    applyStyle();
    if (dockActive()) mountDock();
    else unmountDock();
    if (reserving()) scanFixed();
    else unshiftAll();
    if (frame) setFrame(dockState === 'open' ? '100vw' : settings.dockWidth);
    scheduleFit();
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    mo.disconnect();
    cleanups.forEach((f) => f());
    unmountDock();
    unshiftAll();
    style.remove();
    document.documentElement?.removeAttribute('data-rm-clip');
    document.querySelectorAll(`[${ATTR_FIX}]`).forEach((el) => el.removeAttribute(ATTR_FIX));
  }
  on(document, 'ratmobile:teardown', teardown, { once: true });

  async function init() {
    try {
      const { settings: s } = await chrome.storage.local.get('settings');
      settings = { ...DEFAULTS, ...(s || {}) };
    } catch {
      return teardown();
    }
    const z = await send({ type: 'fit:hello' });
    if (z) { fit.zoom = z.zoom || 1; fit.userZoomed = !!z.userZoomed; }
    fit.lastWidth = window.innerWidth * fit.zoom;
    applyStyle();
    const start = () => {
      applySettings();
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'width'] });
      new ResizeObserver(() => scheduleFit(150)).observe(document.documentElement);
    };
    if (document.body) start();
    else on(document, 'DOMContentLoaded', start, { once: true });
    on(window, 'load', () => scheduleFit(0), { once: true });
    on(window, 'resize', onResize);
  }

  if (extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!alive || area !== 'local' || !changes.settings) return;
      const prevMode = settings.dockMode;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (prevMode !== settings.dockMode) { unmountDock(); unshiftAll(); }
      applySettings();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!alive) return;
      if (msg.type === 'overlay:toggle') {
        if (dockState === 'open') post({ cmd: 'close' });
        else openOverlay(true);
      } else if (msg.type === 'fit:user-zoom') {
        fit.userZoomed = true;
        fit.zoom = msg.zoom;
      } else if (msg.type === 'fit:status') {
        reply({ overflow: overflowPx(), clipped: fit.clipped, zoom: fit.zoom, fixes: document.querySelectorAll(`[${ATTR_FIX}]`).length, dock: !!frame });
      }
    });
    window.__ratmobile = { runFit, overflowPx, fit, get settings() { return settings; }, openOverlay };
    init();
  }
})();
