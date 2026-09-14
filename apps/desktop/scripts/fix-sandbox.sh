#!/usr/bin/env bash
# Grants Chromium's setuid sandbox helper the ownership and mode it needs.
#
# Needs root, and must be re-run after reinstalling Electron, because npm
# restores the file with the invoking user's ownership.
set -euo pipefail

BINARY="$(node -p "require('node:path').join(require('node:path').dirname(require('electron')), 'chrome-sandbox')")"

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
