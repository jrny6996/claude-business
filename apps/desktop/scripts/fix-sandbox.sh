#!/usr/bin/env bash
# Grants Chromium's setuid sandbox helper the ownership and mode it needs.
#
# Needs root, and must be re-run after reinstalling Electron, because npm
# restores the file with the invoking user's ownership.
#
# You may not need this at all: if a packaged Chrome or Chromium is installed,
# the launch scripts borrow its already-granted helper and need no root.
set -euo pipefail

BINARY="$(node -p "require('node:path').join(require('node:path').dirname(require('electron')), 'chrome-sandbox')")"

# The launch scripts move an unusable helper aside so Chromium will look at
# CHROME_DEVEL_SANDBOX instead. Put it back before granting it.
if [ ! -f "$BINARY" ] && [ -f "$BINARY.unusable" ]; then
  echo "Restoring the displaced helper from $BINARY.unusable"
  mv "$BINARY.unusable" "$BINARY"
fi

if [ ! -f "$BINARY" ]; then
  echo "chrome-sandbox not found at: $BINARY" >&2
  echo "Install Electron's binary first (node node_modules/electron/install.js)." >&2
  exit 1
fi

echo "Granting the sandbox helper at:"
echo "  $BINARY"
sudo chown root:root "$BINARY"
sudo chmod 4755 "$BINARY"
echo "Done. Electron can sandbox now."
