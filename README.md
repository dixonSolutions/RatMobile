# RatMobile

<img src="extension/icons/128.png" width="72" align="right" alt="">

**A comfortable, tablet-style Chromium.** RatMobile is a Chromium extension. It is not on the Chrome Web Store: you install it in Developer mode or with the installer below, and it updates itself from this repo.

- **Never scroll sideways.** Pages are made to fit the window width, whether in landscape, portrait or split screen.
- **Icon dock + slide-over tabs.** A slim vertical dock of tab icons stays usable. Swipe right from it (or tap ☰, or press `Alt+Shift+A`) for a large overlay to pick tabs, with pinned tabs on top.
- **Crash-proof sessions.** Windows, pinned tabs and tab groups are snapshotted continuously and restored after a crash, a `kill -9`, or a forced power-off.

**Install page:** https://dixonsolutions.github.io/RatMobile/

## Install

| Method | Auto-update | How |
|---|---|---|
| Installer (recommended) | ✅ | `curl -fsSL https://dixonsolutions.github.io/RatMobile/install.sh \| bash`, then restart the browser (click **Enable** if asked). |
| Developer mode, CRX | ✅ | Download [`ratmobile.crx`](https://dixonsolutions.github.io/RatMobile/ratmobile.crx). On `chrome://extensions`, turn on **Developer mode** and drag the file onto the page **from your file manager**. |
| Developer mode, unpacked | ✅ via timer | `curl -fsSL https://dixonsolutions.github.io/RatMobile/install.sh \| bash -s -- --unpacked`, then **Load unpacked** → `~/.local/share/ratmobile/extension`. |

The installer finds Chromium, Google Chrome and Brave profiles, both native and Flatpak (`~/.var/app/...`). It registers RatMobile's update feed with each through Chromium's per-user `External Extensions` mechanism. Options:

- `--restore-on` also sets *On startup → Continue where you left off*. Close the browser first.
- `--uninstall` removes everything the installer added.

### How updates work

Every push to `main` runs [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Lint the code.
2. Run the end-to-end tests in real headless Chromium.
3. Build version `0.1.<run number>`.
4. Sign the CRX3 with the repo's private key (secret `RATMOBILE_KEY`).
5. Publish `updates.xml` and the CRX to GitHub Pages.
6. Create a GitHub release.

Installed copies pick the new version up through the manifest's `update_url`. Chromium checks every ~5 hours, and RatMobile also nudges it every 3 hours and applies an update the moment one arrives. To update now, click **Update** on `chrome://extensions`. Unpacked installs are refreshed by the installer's systemd user timer, and RatMobile reloads itself when the files change.

The extension ID is always `jlddfageoecfjabhpdkjjbogcnafbdfa`. The public key is in `manifest.json`, so Load unpacked gets the same ID as the CRX and keeps its settings and snapshots.

## Features

### Fit to width: no horizontal scrolling

A content script watches each page with a `ResizeObserver` and a `MutationObserver`. When the document becomes wider than the window, it finds the *root culprits*: elements sticking out past the right edge whose parent does not. It fixes only those:

| Culprit | Fix |
|---|---|
| Images, video, canvas, iframes | `max-width: 100%` (and `height: auto`) |
| `pre` / `code` | wrap long lines |
| Tables | wrap cell text; if still too wide, the table becomes its own scroll box |
| Long words / URLs | `overflow-wrap: anywhere` |
| Single-line flex rows | allow wrapping |
| Full-bleed `100vw` elements | clamp to the column |
| Off-canvas menus parked outside the viewport | clip |
| Fixed-width web apps with no responsive viewport | zoom the tab out to fit, the way a phone shows a desktop site; pinch to zoom in |

Responsive pages are never zoomed. Well-behaved pages are not touched at all. If you zoom a tab yourself (`Ctrl +/−`), RatMobile stops auto-fitting it. To turn fit and dock off for a site, add it to the excluded list in settings, or use the `toggle-fit` command.

### Dock and overlay

- **Dock:** a 56 px strip on the left of every page.
  - Pinned tabs come first, then a separator, then the other tabs.
  - Tap an icon to switch; middle-click to close.
  - In *reserve* mode (default), the page and its fixed headers are pushed right so nothing hides under the dock. *Float* and *auto-hide* (slides away while you scroll down) are also available.
- **Overlay:** swipe right from the dock (the panel follows your finger), tap ☰, long-press any icon, or press `Alt+Shift+A`. It has:
  - Search
  - A pinned grid
  - Tab groups
  - Other windows
  - Long-press actions: pin, duplicate, mute, reload, move to a new window, close
  - Drag to reorder, or drag into *Pinned*
  - A **Sessions** view with snapshot history

  Close it by swiping left, tapping outside it, pressing Esc, or picking a tab.
- **Native side panel and new tab page:** the action button opens the same tab list in Chromium's side panel, as a fallback on `chrome://` pages where extensions can't inject. The new tab page has the dock too.

If Chromium's own vertical tabs are on (right-click the tab strip → *Show tabs vertically*), you get two tab lists. Switch Chromium's back to the top. Extensions can't change that setting.

### Sessions

Every tab, window and group change is snapshotted to `chrome.storage.local`, debounced to about 0.4 s. Closing windows during a quit never overwrites the last good snapshot. Older snapshots are archived every 10 minutes, and whenever many tabs disappear at once.

After a force shutdown, Chromium itself never auto-restores; it only offers a "Restore pages?" bubble. On the next start RatMobile:

1. Waits for Chromium's startup to settle.
2. Compares the open tabs with the last snapshot.
3. Restores what's missing: windows, pinned tabs first, groups with titles and colours, and the active tab. Background tabs are unloaded until you open them.

If Chromium already restored the session itself, RatMobile does nothing, so tabs are never duplicated. If you also click Chromium's restore bubble, the duplicates it creates are closed.

> Limitation: Chromium doesn't `fsync` extension storage. After a sudden **power loss**, the last few seconds of changes may be lost, and the snapshot from just before that is used.

## Development

```bash
npm ci
node scripts/build.mjs      # dist/ratmobile (unpacked), ratmobile.zip, signed CRX + updates.xml if a key is present
npm run lint
npm test                    # real Chromium, headless, at 1440x960 / 960x1440 / 720x960 @2x
HEADED=1 npm test           # watch it
node tests/sites.mjs        # optional sweep over real websites
```

- **Which Chromium the tests use:** `$CHROMIUM` if set, otherwise the Flathub `org.chromium.Chromium`, otherwise Playwright's Chromium.
- **What the tests cover:**
  - The fit engine on a fixture page for each overflow pattern
  - The dock and overlay with real CDP touch swipes, long-press and drag
  - Session restore after a real `SIGKILL` of the browser, repeated crashes, and a graceful quit with *Continue where you left off*
  - CRX install from an update feed, then an auto-update to a newer signed build

Signing key: CI reads the `RATMOBILE_KEY` secret. Locally, the build reads `~/.config/ratmobile/key.pem`. Never commit it: whoever has the key can push updates to every install.

## License

MIT. See [LICENSE](LICENSE).
