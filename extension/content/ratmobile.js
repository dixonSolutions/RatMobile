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
${d ? `html{margin-left:${d}px!important;width:auto!important;position:relative!important}` : ''}
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
[${ATTR_FIX}~=bleed]{margin-left:0!important;margin-right:0!important}
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
    restores: 0,
    zoomCulprits: [],
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

  // In quirks mode the body, not <html>, is the viewport's scrolling element.
  const scroller = () => document.scrollingElement || document.documentElement;

  function overflowPx() {
    const se = scroller();
    if (!se) return 0;
    return se.scrollWidth - se.clientWidth;
  }

  // The page's own CSS may already stop the viewport from scrolling sideways (overflow-x on
  // html, or on body when html is visible, propagates to the viewport). Then there is nothing to fix.
  function siteClipsViewportX() {
    const de = document.documentElement;
    const hx = getComputedStyle(de).overflowX;
    if (hx !== 'visible') return !fit.clipped && hx !== 'auto' && hx !== 'scroll';
    const bx = document.body ? getComputedStyle(document.body).overflowX : 'visible';
    return bx === 'hidden' || bx === 'clip';
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
      if ((cs.overflowX !== 'visible' && el !== document.body) || MEDIA.has(el.tagName.toUpperCase())) continue;
      for (let i = el.children.length - 1; i >= 0; i--) stack.push([el.children[i], parentOver || over]);
    }
    return out;
  }

  function isNearFull(r, vw) {
    return r.width >= vw * 0.85 && r.right <= vw + settings.dockWidth + 24;
  }

  // Wrapping cell text can crush data tables to a character per column: scroll those instead.
  function tableCrushed(table) {
    const em = parseFloat(getComputedStyle(table).fontSize) || 16;
    for (const row of [...table.rows].slice(0, 6)) {
      for (const cell of row.cells) {
        if (cell.clientWidth < em * 3 && (cell.textContent || '').trim().length >= 4) return true;
      }
    }
    return false;
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
      if (addFix(el, 'table')) {
        if (tableCrushed(el)) { el.setAttribute(ATTR_FIX, 'scrollbox'); return 'scrollbox'; }
        return 'table';
      }
      return addFix(el, 'scrollbox') ? 'scrollbox' : null;
    }
    // Full-bleed element just slightly too wide (100vw + scrollbar / dock): always safe to clamp.
    if (isNearFull(r, vw)) {
      if (parseFloat(cs.marginLeft) < 0 && addFix(el, 'bleed')) return 'bleed';
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

    const vw = scroller().clientWidth;
    let over = overflowPx();
    if (over <= 1 && fit.baseZoom == null) return;
    // A temporary overflow (ad, toast) that made us zoom out is gone: go back to the user's zoom.
    if (fit.baseZoom != null && fit.zoom < fit.baseZoom && fit.restores < 3) {
      const atBase = (vw * fit.zoom) / fit.baseZoom;
      const sx = window.scrollX;
      const gone = fit.zoomCulprits.every((ref) => {
        const el = ref.deref();
        return !el || !el.isConnected || el.getBoundingClientRect().right + sx <= atBase + 1;
      });
      if (gone) {
        const base = fit.baseZoom;
        fit.baseZoom = null;
        fit.zoomSteps = 0;
        fit.zoomCulprits = [];
        fit.restores++;
        log('zoom restore', base);
        requestZoom(base);
        return;
      }
    }
    if (over <= 1) return;
    // The site already stops the viewport scrolling sideways. Only undo what our own dock shift
    // pushed out (full-bleed bars); never zoom or reflow content the site deliberately clips.
    const siteClips = siteClipsViewportX();
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
        if (siteClips && !(reserving() && isNearFull(c.r, vw))) continue;
        // An earlier fix in this pass (e.g. wrapping its row) may already have pulled it back in.
        if (changed && !c.text && c.el.getBoundingClientRect().right + window.scrollX <= vw + 1) continue;
        const kind = fixCulprit(c, vw, responsive && !siteClips, pass);
        if (kind !== 'offscreen') offscreenOnly = false;
        if (kind && kind !== 'offscreen') { changed++; log('fix', kind, c.el); }
      }
      if (!changed) break;
      over = overflowPx();
    }
    if (over <= 1 || siteClips) return;

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
        // Remember what forced the zoom-out, so we can zoom back in when it goes away.
        fit.zoomCulprits = [...fit.zoomCulprits.filter((r) => r.deref()?.isConnected), ...findCulprits(vw).map((c) => new WeakRef(c.el))];
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
      fit.zoomCulprits = [];
      requestZoom(base);
    }
    fit.lastWidth = w;
    scheduleFit(100);
  }

  // ---------------------------------------------------------------------------
  // Reserve-space dock: shift fixed elements that would sit underneath it.
  // ---------------------------------------------------------------------------
  const shifted = new Map(); // el -> { original inline values, values we set }

  function shiftFixed(el) {
    if (!(el instanceof HTMLElement) || el.id === 'ratmobile-dock' || el.id === 'ratmobile-edge') return;
    const D = settings.dockWidth;
    const prev = shifted.get(el);
    // Sites that rewrite style.left (sticky headers, menus) undo our shift: notice and redo it.
    if (prev) {
      if (!el.isConnected) { shifted.delete(el); return; }
      const leftOk = !prev.setLeft || el.style.getPropertyValue('left') === prev.setLeft;
      const mwOk = !prev.setMax || el.style.getPropertyValue('max-width') === prev.setMax;
      if (leftOk && mwOk) return;
      restore(el, prev);
      shifted.delete(el);
    }
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= 0) return;
    const vw = window.innerWidth;
    const entry = {
      left: el.style.getPropertyValue('left'), leftP: el.style.getPropertyPriority('left'),
      maxWidth: el.style.getPropertyValue('max-width'), maxWidthP: el.style.getPropertyPriority('max-width'),
      setLeft: null, setMax: null,
    };
    let left = r.left;
    if (r.left < D - 0.5) {
      if (cs.left !== 'auto') {
        entry.setLeft = `${parseFloat(cs.left) + (D - r.left)}px`;
        el.style.setProperty('left', entry.setLeft, 'important');
        left = D;
      } else if (cs.right === 'auto') {
        return; // static position: already inside the shifted root
      }
    }
    // Full-width bars (width:100% / 100vw) now stick out on the right: clamp them.
    if (left + r.width > vw + 0.5 && r.width > vw * 0.5) {
      entry.setMax = `calc(100% - ${Math.round(left)}px)`;
      el.style.setProperty('max-width', entry.setMax, 'important');
    }
    if (!entry.setLeft && !entry.setMax) return;
    el.setAttribute(ATTR_SHIFT, '');
    shifted.set(el, entry);
  }

  function restore(el, o) {
    el.style.removeProperty('left');
    el.style.removeProperty('max-width');
    if (o.left) el.style.setProperty('left', o.left, o.leftP);
    if (o.maxWidth) el.style.setProperty('max-width', o.maxWidth, o.maxWidthP);
    el.removeAttribute(ATTR_SHIFT);
  }

  function unshiftAll() {
    for (const [el, o] of shifted) restore(el, o);
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
        if (reserving() && t.nodeType === 1) shiftFixed(t);
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
    // Start as soon as <body> exists (well before DOMContentLoaded on big pages), so the dock
    // never leaves an empty strip while the page parses.
    if (document.body) start();
    else {
      const wait = new MutationObserver(() => { if (document.body) { wait.disconnect(); start(); } });
      wait.observe(document.documentElement, { childList: true });
      cleanups.push(() => wait.disconnect());
    }
    // Stylesheets that arrive late can turn elements fixed without any DOM mutation.
    let rescanTimer = 0;
    const rescan = () => { clearTimeout(rescanTimer); rescanTimer = setTimeout(() => { if (alive && reserving()) scanFixed(); scheduleFit(0); }, 120); };
    on(window, 'load', rescan, { once: true });
    on(document, 'load', (e) => { if (e.target instanceof HTMLLinkElement || e.target instanceof HTMLStyleElement) rescan(); }, true);
    on(window, 'resize', onResize);
    on(window, 'resize', rescan);
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
