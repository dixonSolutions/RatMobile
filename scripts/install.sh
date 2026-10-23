#!/usr/bin/env bash
# RatMobile installer for Chromium-based browsers on Linux (native or Flatpak).
#
#   install.sh                 auto-updating install: registers RatMobile's update feed with every
#                              Chromium/Chrome/Brave profile it finds, and applies the tablet setup
#                              below to browsers that are closed. Restart the browser afterwards.
#   install.sh --tablet        only the tablet setup (browser must be closed): Chromium's own vertical
#                              tabs on, collapsed to an icon strip, expand on hover, and
#                              "On startup: Continue where you left off".
#   install.sh --no-tablet     install without touching browser settings.
#   install.sh --unpacked      for "Load unpacked" (Developer mode): keeps ~/.local/share/ratmobile/extension
#                              current with an hourly systemd user timer; RatMobile reloads itself.
#   install.sh --uninstall     remove everything this script added (settings backups are kept).
#
# curl -fsSL https://dixonsolutions.github.io/RatMobile/install.sh | bash
set -euo pipefail

ID="jlddfageoecfjabhpdkjjbogcnafbdfa"
SITE="https://dixonsolutions.github.io/RatMobile"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/ratmobile"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mode=feed
tablet=auto
for a in "$@"; do
  case "$a" in
    --unpacked) mode=unpacked ;;
    --update-unpacked) mode=update-unpacked ;;
    --tablet|--restore-on) [ "$mode" = feed ] && mode=none; tablet=1 ;;
    --no-tablet) tablet=0 ;;
    --uninstall) mode=uninstall ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }

# "<user-data-dir>|<process name>" for every browser installed for this user.
browsers() {
  local d
  for d in \
    "$HOME/.var/app/org.chromium.Chromium/config/chromium|chromium" \
    "$HOME/.var/app/com.google.Chrome/config/google-chrome|chrome" \
    "$HOME/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser|brave" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/chromium|chromium" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome|chrome" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/BraveSoftware/Brave-Browser|brave"; do
    [ -d "${d%%|*}" ] && echo "$d"
  done
  return 0
}

running() { pgrep -u "$USER" -x "$1" >/dev/null 2>&1; }

install_feed() {
  local found=0 entry dir
  while IFS= read -r entry; do
    dir="${entry%%|*}"
    found=1
    mkdir -p "$dir/External Extensions"
    printf '{\n  "external_update_url": "%s/updates.xml"\n}\n' "$SITE" > "$dir/External Extensions/$ID.json"
    say "registered RatMobile with $dir"
  done < <(browsers)
  if [ "$found" = 0 ]; then
    echo "No Chromium-based browser profile found. Start your browser once, then run this again." >&2
    exit 1
  fi
  say "Restart the browser. RatMobile installs within a few seconds and updates itself from $SITE."
  say "If Chromium shows 'New extension added', click Enable."
}

fetch_unpacked() {
  local tmp latest current=""
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  latest=$(curl -fsSL "$SITE/version.json" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
  [ -f "$DATA/extension/manifest.json" ] && current=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DATA/extension/manifest.json" | head -1)
  if [ -n "$latest" ] && [ "$latest" = "$current" ]; then
    return 0
  fi
  curl -fsSL "$SITE/ratmobile.zip" -o "$tmp/r.zip"
  mkdir -p "$tmp/x" "$DATA"
  if command -v unzip >/dev/null; then unzip -q "$tmp/r.zip" -d "$tmp/x"; else python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$tmp/r.zip" "$tmp/x"; fi
  # Swap atomically so Chromium never sees a half-written folder.
  rm -rf "$DATA/extension.new" && mv "$tmp/x" "$DATA/extension.new"
  rm -rf "$DATA/extension.old"
  [ -d "$DATA/extension" ] && mv "$DATA/extension" "$DATA/extension.old"
  mv "$DATA/extension.new" "$DATA/extension"
  rm -rf "$DATA/extension.old"
  say "RatMobile ${latest:-?} unpacked to $DATA/extension"
}

install_unpacked() {
  fetch_unpacked
  mkdir -p "$UNIT_DIR" "$DATA"
  cp "$0" "$DATA/install.sh" 2>/dev/null || curl -fsSL "$SITE/install.sh" -o "$DATA/install.sh"
  chmod +x "$DATA/install.sh"
  cat > "$UNIT_DIR/ratmobile-update.service" <<EOF
[Unit]
Description=Update RatMobile (unpacked extension)
After=network-online.target

[Service]
Type=oneshot
ExecStart=$DATA/install.sh --update-unpacked
EOF
  cat > "$UNIT_DIR/ratmobile-update.timer" <<EOF
[Unit]
Description=Update RatMobile hourly

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now ratmobile-update.timer >/dev/null
  say "Now open chrome://extensions, turn on Developer mode, click 'Load unpacked' and pick:"
  echo "    $DATA/extension"
}

# Tablet setup for Chromium's own vertical tabs. Chromium rewrites Preferences on exit, so this only
# touches browsers that are closed; it keeps a backup and changes nothing else.
tablet_setup() {
  local entry dir proc prefs
  while IFS= read -r entry; do
    dir="${entry%%|*}"; proc="${entry##*|}"
    prefs="$dir/Default/Preferences"
    [ -f "$prefs" ] || continue
    if running "$proc"; then
      say "browser running: skipped tablet setup for $dir (close it, then run: install.sh --tablet)"
      continue
    fi
    cp "$prefs" "$prefs.ratmobile-backup"
    python3 - "$prefs" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
vt = d.setdefault("vertical_tabs", {})
vt.update({"enabled": True, "collapsed_state": True, "expand_on_hover": True})
d.setdefault("session", {})["restore_on_startup"] = 1  # Continue where you left off
json.dump(d, open(p, "w"), separators=(",", ":"))
PY
    say "tablet setup applied to $dir: vertical tabs collapsed + expand on hover, continue where you left off"
  done < <(browsers)
}

uninstall() {
  local entry
  while IFS= read -r entry; do rm -f "${entry%%|*}/External Extensions/$ID.json"; done < <(browsers)
  systemctl --user disable --now ratmobile-update.timer >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/ratmobile-update.service" "$UNIT_DIR/ratmobile-update.timer"
  systemctl --user daemon-reload 2>/dev/null || true
  rm -rf "$DATA"
  say "Removed. Remove RatMobile from chrome://extensions too if it is still listed."
}

case "$mode" in
  none) ;;
  feed) install_feed ;;
  unpacked) install_unpacked ;;
  update-unpacked) fetch_unpacked ;;
  uninstall) uninstall ;;
esac
if [ "$tablet" = 1 ] || { [ "$tablet" = auto ] && [ "$mode" = feed ]; }; then tablet_setup; fi
exit 0
