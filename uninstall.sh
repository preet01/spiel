#!/bin/bash
#
# Spiel voice engine uninstaller — removes everything install.sh created.
# Usage: curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/uninstall.sh | bash
#
# Removes: ~/.spiel (engine + model), the LaunchAgent, and the engine log.
# Leaves:  the `uv` tool (other apps may use it) and the Chrome extension
#          (remove that from chrome://extensions).

set -u

SPIEL_HOME="${SPIEL_HOME:-$HOME/.spiel}"
PLIST_LABEL="com.spiel.voice-engine"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
ENGINE_LOG="$HOME/Library/Logs/spiel-voice-engine.log"

main() {
  echo ""
  echo "🗑  Removing the Spiel voice engine..."

  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" > /dev/null 2>&1 || true
  launchctl unload "$PLIST_PATH" > /dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  rm -rf "$SPIEL_HOME"
  rm -f "$ENGINE_LOG"

  echo "✅  Done. The engine, AI model, and auto-start service are gone."
  echo "   To remove the extension too: chrome://extensions → Spiel → Remove."
  echo "   (The 'uv' tool was left installed — other apps may use it.)"
  echo ""
}

main "$@"
