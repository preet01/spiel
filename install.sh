#!/bin/bash
#
# Spiel voice engine installer — https://github.com/preet01/spiel
#
# Sets up the local AI voice engine (Kokoro) that powers the Spiel Chrome
# extension. Everything runs on YOUR machine — no cloud, no account, no data
# ever leaves your computer.
#
# Usage:   curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
#
# What it does:
#   1. Checks your Mac (macOS, disk space)
#   2. Installs the `uv` Python manager if missing (from astral.sh)
#   3. Downloads the Kokoro-FastAPI voice server (pinned commit, Apache-2.0)
#   4. Downloads the Kokoro AI voice model (~330 MB, Apache-2.0)
#   5. Creates a LaunchAgent so the engine auto-starts on every boot
#   6. Starts it and speaks a test sentence out loud
#
# Everything is installed under ~/.spiel — to remove it all:
#   curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/uninstall.sh | bash
#
# The whole `main "$@"` wrapper exists so a partially-downloaded script can
# never execute half-way — bash parses the full file before running anything.

set -u

# ── Config ────────────────────────────────────────────────────────────────────
SPIEL_HOME="${SPIEL_HOME:-$HOME/.spiel}"
ENGINE_DIR="$SPIEL_HOME/engine"
LOG_FILE="$SPIEL_HOME/install.log"
KOKORO_COMMIT="c5ccfa1821522fc6d5af319ef36c3e85227145e7"   # remsky/Kokoro-FastAPI, pinned & tested
TARBALL_URL="https://codeload.github.com/remsky/Kokoro-FastAPI/tar.gz/$KOKORO_COMMIT"
PLIST_LABEL="com.spiel.voice-engine"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
ENGINE_LOG="$HOME/Library/Logs/spiel-voice-engine.log"
BASE_URL="http://127.0.0.1:8880"     # 127.0.0.1, NOT localhost (IPv6 resolution bug on macOS)
PORT=8880
MIN_DISK_GB=8
HELP_URL="https://github.com/preet01/spiel#troubleshooting"

# ── Output helpers ───────────────────────────────────────────────────────────
BOLD=$(tput bold 2>/dev/null || true); DIM=$(tput dim 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true); RED=$(tput setaf 1 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true); RESET=$(tput sgr0 2>/dev/null || true)

say()  { printf '%s\n' "$1"; printf '%s\n' "$1" >> "$LOG_FILE" 2>/dev/null || true; }
step() { printf '%s' "${BOLD}$1${RESET} "; printf '\n== %s\n' "$1" >> "$LOG_FILE" 2>/dev/null || true; }
ok()   { printf '%s\n' "${GREEN}✓${RESET}"; }
warn() { printf '%s\n' "${YELLOW}⚠ $1${RESET}"; }

fail() {
  printf '\n%s\n' "${RED}${BOLD}✗ Installation failed:${RESET} $1"
  printf '%s\n' "${DIM}Full log: $LOG_FILE${RESET}"
  printf '%s\n' "${DIM}Help:     $HELP_URL${RESET}"
  exit 1
}

# Run a noisy command, appending its output to the log; fail with message on error.
run_logged() {
  local msg="$1"; shift
  if ! "$@" >> "$LOG_FILE" 2>&1; then
    fail "$msg (see log for details)"
  fi
}

# ── Steps ─────────────────────────────────────────────────────────────────────

check_system() {
  step "Checking your Mac..."
  [ "$(uname -s)" = "Darwin" ] || fail "Spiel's installer currently supports macOS only. Windows/Linux are on the roadmap: https://github.com/preet01/spiel"

  ARCH="$(uname -m)"
  MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  MACOS_MAJOR="${MACOS_VERSION%%.*}"

  # Apple Silicon only: the voice engine's dependencies ship prebuilt arm64
  # wheels but no Intel macOS wheels, so Intel installs fail after a huge
  # download unless a Rust toolchain is present. Fail fast and honestly.
  [ "$ARCH" = "arm64" ] || fail "Spiel currently requires an Apple Silicon Mac (M1 or newer). Intel support is tracked at https://github.com/preet01/spiel/issues"

  if [ "${MACOS_MAJOR:-0}" -ge 13 ]; then
    DEVICE_TYPE="mps"; USE_GPU="true"
  else
    DEVICE_TYPE="cpu"; USE_GPU="false"
  fi

  # espeak-ng (inside the engine) truncates data paths longer than ~160 chars
  # and silently falls back to a nonexistent compile-time default, crash-looping
  # the engine. The engine adds ~75 chars under SPIEL_HOME, so cap it at 80.
  if [ ${#SPIEL_HOME} -gt 80 ]; then
    fail "Install path is too long for the speech engine: $SPIEL_HOME (${#SPIEL_HOME} chars, max 80). Set SPIEL_HOME to a shorter path."
  fi

  local free_gb
  free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
  if [ "${free_gb:-0}" -lt "$MIN_DISK_GB" ]; then
    fail "Not enough disk space: ${free_gb}GB free, ${MIN_DISK_GB}GB needed (Python packages + AI model)."
  fi
  ok
  say "  ${DIM}$ARCH · macOS $MACOS_VERSION · ${free_gb}GB free · engine will use: $DEVICE_TYPE${RESET}"
  if [ "$DEVICE_TYPE" = "cpu" ]; then
    warn "macOS 13+ is needed for GPU speech — the voice will work but respond slower."
  fi
}

# Returns 0 if a healthy Kokoro engine already answers on the port.
engine_is_healthy() {
  curl -sf --max-time 3 "$BASE_URL/health" > /dev/null 2>&1
}

check_port() {
  # Port taken but not by a healthy engine → something else owns it. Don't fight it.
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
    if ! engine_is_healthy; then
      fail "Port $PORT is in use by another program (run: lsof -iTCP:$PORT -sTCP:LISTEN). Quit it and re-run this installer."
    fi
  fi
}

find_or_install_uv() {
  step "Setting up the Python manager (uv)..."
  # Look in PATH and the usual homes. Absolute path required: launchd has no user PATH.
  UV_BIN="$(command -v uv 2>/dev/null || true)"
  if [ -z "$UV_BIN" ]; then
    for candidate in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv /usr/local/Homebrew/bin/uv; do
      if [ -x "$candidate" ]; then UV_BIN="$candidate"; break; fi
    done
  fi
  if [ -z "$UV_BIN" ]; then
    say ""
    say "  ${DIM}uv not found — installing from astral.sh (the standard uv installer)...${RESET}"
    run_logged "Could not install uv" \
      /bin/bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    UV_BIN="$HOME/.local/bin/uv"
    [ -x "$UV_BIN" ] || fail "uv installed but not found at $UV_BIN"
  fi
  ok
  say "  ${DIM}uv: $UV_BIN${RESET}"
}

download_engine() {
  step "Downloading the voice server (Kokoro-FastAPI)..."
  mkdir -p "$SPIEL_HOME"
  if [ -f "$ENGINE_DIR/pyproject.toml" ]; then
    ok
    say "  ${DIM}already downloaded — keeping existing copy${RESET}"
    return
  fi
  local tmp_tar="$SPIEL_HOME/engine.tar.gz"
  # --retry survives flaky Wi-Fi; pinned commit tarball needs no git install.
  curl -fL --retry 3 --retry-delay 2 -o "$tmp_tar" "$TARBALL_URL" 2>> "$LOG_FILE" \
    || fail "Could not download the voice server from GitHub. Check your internet connection."
  rm -rf "$ENGINE_DIR" "$SPIEL_HOME/Kokoro-FastAPI-$KOKORO_COMMIT"
  run_logged "Could not extract the voice server archive" \
    tar -xzf "$tmp_tar" -C "$SPIEL_HOME"
  mv "$SPIEL_HOME/Kokoro-FastAPI-$KOKORO_COMMIT" "$ENGINE_DIR" || fail "Could not move engine into place"
  rm -f "$tmp_tar"
  ok
}

install_python_deps() {
  step "Installing the AI engine (2–4 min, ~2 GB — grab a coffee)..."
  cd "$ENGINE_DIR" || fail "Engine directory missing: $ENGINE_DIR"
  if [ ! -d .venv ]; then
    # Force uv's own managed, native-arch CPython. Never pick up a stray system
    # interpreter: an Intel (Rosetta) Python here makes pip try to compile Rust
    # deps for x86_64, which has no wheels and fails. (Found by live testing.)
    # 3.10 matches the engine repo's .python-version pin.
    run_logged "Could not create the Python environment" \
      env UV_PYTHON_PREFERENCE=only-managed \
      "$UV_BIN" venv .venv --python cpython-3.10-macos-aarch64-none
  fi
  run_logged "Could not install the voice engine's Python packages" \
    "$UV_BIN" pip install -e .
  ok
}

download_model() {
  step "Downloading the AI voice model (~330 MB)..."
  cd "$ENGINE_DIR" || fail "Engine directory missing: $ENGINE_DIR"
  # Official downloader: fetches from GitHub releases, verifies, and skips if present.
  run_logged "Could not download the voice model" \
    "$UV_BIN" run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0
  ok
}

install_launch_agent() {
  step "Setting up auto-start (runs silently in the background)..."
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

  # Note --host 127.0.0.1: the engine is reachable ONLY from this Mac, never the network.
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$UV_BIN</string>
        <string>run</string>
        <string>--no-sync</string>
        <string>uvicorn</string>
        <string>api.src.main:app</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>$PORT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ENGINE_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>USE_GPU</key><string>$USE_GPU</string>
        <key>USE_ONNX</key><string>false</string>
        <key>PYTHONPATH</key><string>$ENGINE_DIR:$ENGINE_DIR/api</string>
        <key>MODEL_DIR</key><string>src/models</string>
        <key>VOICES_DIR</key><string>src/voices/v1_0</string>
        <key>WEB_PLAYER_PATH</key><string>$ENGINE_DIR/web</string>
        <key>DEVICE_TYPE</key><string>$DEVICE_TYPE</string>
        <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$ENGINE_LOG</string>
    <key>StandardErrorPath</key><string>$ENGINE_LOG</string>
</dict>
</plist>
PLIST

  # Re-runs: unload any previous copy first (ignore "not loaded" errors).
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" > /dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >> "$LOG_FILE" 2>&1; then
    # Older macOS fallback
    launchctl load -w "$PLIST_PATH" >> "$LOG_FILE" 2>&1 || fail "Could not register the auto-start service"
  fi
  ok
}

wait_for_engine() {
  step "Starting the engine (first boot loads the AI model)..."
  local i=0
  while [ $i -lt 60 ]; do
    if engine_is_healthy; then ok; return 0; fi
    sleep 3
    i=$((i + 1))
  done
  fail "The engine did not come up after 3 minutes. Engine log: $ENGINE_LOG"
}

speak_test() {
  step "Testing — your Mac is about to speak..."
  local out="${TMPDIR:-/tmp}/spiel-ready.mp3"
  # Generous timeout: very first generation can take 10-20s while the model warms up.
  # No early abort — the engine must never have a request cancelled mid-generation.
  if curl -sf --max-time 180 -X POST "$BASE_URL/v1/audio/speech" \
      -H "Content-Type: application/json" \
      -d '{"model":"kokoro","input":"Spiel is ready.","voice":"af_heart"}' \
      -o "$out" 2>> "$LOG_FILE" && [ -s "$out" ]; then
    afplay "$out" 2>/dev/null || true
    ok
  else
    # Engine is up (health passed) but speech failed — don't junk the whole install.
    warn "Engine is running, but the spoken test failed. Try Play in the extension; log: $ENGINE_LOG"
  fi
}

print_success() {
  printf '\n'
  say "${GREEN}${BOLD}✅  Spiel voice engine installed!${RESET}"
  say ""
  say "  It runs silently in the background and auto-starts with your Mac."
  say "  Nothing you read or listen to ever leaves this computer."
  say ""
  say "  ${BOLD}Next:${RESET} open Chrome → click the Spiel icon → press Play on any article."
  say ""
  say "  ${DIM}Engine log:  $ENGINE_LOG${RESET}"
  say "  ${DIM}Uninstall:   curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/uninstall.sh | bash${RESET}"
  printf '\n'
}

main() {
  mkdir -p "$SPIEL_HOME"
  : > "$LOG_FILE" 2>/dev/null || true
  printf '\n%s\n\n' "${BOLD}🎙  Spiel — local AI voice engine installer${RESET}"

  # Already fully working? Nothing to do.
  if engine_is_healthy; then
    say "${GREEN}✓ A Kokoro voice engine is already running at $BASE_URL — you're all set!${RESET}"
    say "  Open Chrome → click the Spiel icon → press Play."
    exit 0
  fi

  check_system
  check_port
  find_or_install_uv
  download_engine
  install_python_deps
  download_model
  install_launch_agent
  wait_for_engine
  speak_test
  print_success
}

main "$@"
