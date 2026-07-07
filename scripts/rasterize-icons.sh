#!/bin/bash
# Rasterize assets/icon.svg → assets/icons/icon{16,48,128}.png (transparent PNGs).
# Uses headless Chrome so no extra image tooling is needed. Run this only when the
# icon SVG changes; the build (`npm run icons`) just copies the committed PNGs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/assets/icon.svg"
OUT="$ROOT/assets/icons"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$OUT"

for N in 16 48 128; do
  TMP="$(mktemp -t spiel-icon).html"
  {
    echo '<!doctype html><meta charset="utf-8">'
    echo "<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${N}px;height:${N}px}</style>"
    cat "$SVG"   # inline the SVG; its viewBox lets CSS scale it to N×N
  } > "$TMP"
  "$CHROME" --headless --disable-gpu --force-device-scale-factor=1 \
    --hide-scrollbars --default-background-color=00000000 \
    --window-size="$N,$N" --screenshot="$OUT/icon$N.png" "$TMP" >/dev/null 2>&1
  rm -f "$TMP"
  echo "✓ assets/icons/icon$N.png"
done
