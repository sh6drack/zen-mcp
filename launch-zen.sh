#!/bin/bash
# Launch Zen Browser with remote debugging on an ISOLATED, throwaway profile so
# the zen-mcp server (and the LLM agent driving it) never touches your everyday
# Zen profile, cookies, or logged-in sessions.
#
# Safe to run alongside your normal Zen: it does NOT kill any existing instance.
#
# Config (all optional, via env):
#   ZEN_DEBUG_PORT  debugging port                       (default: 9222)
#   ZEN_PROFILE     throwaway profile directory          (default: /tmp/zen-mcp)
#   ZEN_BIN         explicit Zen executable to launch    (overrides the options below)
#   ZEN_SRC_APP     source Zen.app to launch/clone from  (default: /Applications/Zen.app)
#
#   App identity: by default the launcher runs a renamed COPY of Zen.app so the
#   automation instance is visually distinct from your daily Zen in the app
#   switcher / Dock (this is cosmetic — profile isolation above is what keeps it
#   safe). Config:
#     ZEN_APP_NAME  app name / copy filename (default: "Zen MCP";
#                   set empty — ZEN_APP_NAME= — to launch the system Zen, no copy)
#     ZEN_APP_DIR   where to keep the copy                (default: ~/Applications)
#   Only the bundle's FILENAME changes — which, since Zen ships no
#   CFBundleDisplayName, is what the switcher/Dock display. The Info.plist and
#   code signature are left untouched, so the copy stays validly signed and
#   launches normally (no re-sign, no AMFI kill). Built via an APFS clone
#   (cp -c, ~0 extra disk); rebuilt only when the source Zen version changes.

set -euo pipefail

PORT="${ZEN_DEBUG_PORT:-9222}"
PROFILE="${ZEN_PROFILE:-/tmp/zen-mcp}"
ZEN_SRC_APP="${ZEN_SRC_APP:-/Applications/Zen.app}"
ZEN_APP_NAME="${ZEN_APP_NAME-Zen MCP}"
ZEN_APP_DIR="${ZEN_APP_DIR:-$HOME/Applications}"

# Read an Info.plist key from an .app bundle (empty string if absent).
plist_get() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || true
}

# Build/refresh a renamed COPY of ZEN_SRC_APP so the throwaway instance appears
# under its own name in the app switcher / Dock. Only the bundle filename
# changes — the filename is not part of the code signature, so the copy stays
# validly signed (no Info.plist edits, no re-sign, no AMFI SIGKILL). Idempotent:
# rebuilds only when the copy is missing, the source version changed, or the copy
# no longer verifies. The caller points ZEN_BIN at "$MCP_APP/Contents/MacOS/zen".
ensure_renamed_app() {
  local src="$ZEN_SRC_APP" dst="$MCP_APP"
  if [ ! -d "$src" ]; then
    echo "Error: source app not found: $src (set ZEN_SRC_APP)." >&2
    exit 1
  fi

  # Reuse the copy only if it's current AND still validly signed, so a bundle
  # left broken by an earlier version of this script is rebuilt cleanly.
  local src_ver dst_ver
  src_ver="$(plist_get "$src" CFBundleShortVersionString)"
  dst_ver="$(plist_get "$dst" CFBundleShortVersionString)"
  if [ -d "$dst" ] && [ -n "$src_ver" ] && [ "$src_ver" = "$dst_ver" ] \
     && codesign --verify "$dst" 2>/dev/null; then
    return 0
  fi

  echo "Copying '$ZEN_APP_NAME' from $src (version ${src_ver:-unknown})..."
  mkdir -p "$ZEN_APP_DIR"
  rm -rf "$dst"
  # APFS clone: instant, ~0 extra disk. Fall back to a full copy off-APFS.
  # No Info.plist edits and no re-sign — only the .app filename differs.
  if ! cp -c -R "$src" "$dst" 2>/dev/null; then
    rm -rf "$dst"
    cp -R "$src" "$dst"
  fi
  # Defensive: ensure the copy carries no quarantine bit (cp shouldn't add one).
  xattr -dr com.apple.quarantine "$dst" 2>/dev/null || true

  # Fail closed: never launch a bundle whose signature doesn't verify (that is
  # what AMFI SIGKILLs). With a plain rename-copy this should always pass.
  if ! codesign --verify "$dst" 2>/dev/null; then
    rm -rf "$dst"
    echo "Error: copied app failed signature verification; refusing to launch it." >&2
    echo "Run without ZEN_APP_NAME to use the system Zen, or set ZEN_BIN." >&2
    exit 1
  fi
}

# If something is already serving the debug port, reuse it rather than launching
# a duplicate (avoids a profile-lock clash with a previous zen-mcp instance).
# Done first so we never build the clone needlessly.
if curl -s "http://127.0.0.1:${PORT}/json/version" > /dev/null 2>&1; then
    echo "Zen is already listening on port ${PORT}; reusing it."
    exit 0
fi

# Resolve which Zen binary to launch (may build/refresh the renamed clone).
if [ -n "${ZEN_BIN:-}" ]; then
    : # explicit override — use as-is
elif [ -n "$ZEN_APP_NAME" ]; then
    MCP_APP="$ZEN_APP_DIR/$ZEN_APP_NAME.app"
    ensure_renamed_app
    ZEN_BIN="$MCP_APP/Contents/MacOS/zen"
else
    ZEN_BIN="$ZEN_SRC_APP/Contents/MacOS/zen"
fi

if [ ! -x "$ZEN_BIN" ]; then
    echo "Error: Zen executable not found or not executable: $ZEN_BIN" >&2
    echo "Set ZEN_BIN to the Zen binary path and retry." >&2
    exit 1
fi

mkdir -p "$PROFILE"

echo "Launching Zen with remote debugging on an isolated profile:"
echo "  binary  : $ZEN_BIN"
echo "  profile : $PROFILE"
echo "  port    : $PORT"

# --profile <dir>          dedicated throwaway profile (no personal logins)
# --remote-debugging-port  enables the WebDriver BiDi WebSocket zen-mcp uses
# --no-remote              force a SEPARATE instance, so these flags are not
#                          handed to (and ignored by) your running daily Zen
nohup "$ZEN_BIN" \
    --profile "$PROFILE" \
    --remote-debugging-port "$PORT" \
    --no-remote \
    > /dev/null 2>&1 &
ZEN_PID=$!

echo "Zen launched (pid ${ZEN_PID}). Waiting for the debug port to come up..."

# Wait for the debugging port to become available
for _ in $(seq 1 30); do
    if curl -s "http://127.0.0.1:${PORT}/json/version" > /dev/null 2>&1; then
        echo "Zen is ready on port ${PORT}!"
        VERSION_JSON="$(curl -s "http://127.0.0.1:${PORT}/json/version" 2>/dev/null || true)"
        echo "$VERSION_JSON" | python3 -m json.tool 2>/dev/null || echo "$VERSION_JSON"
        exit 0
    fi
    # If Zen exited early (e.g. a profile lock), surface it instead of looping.
    if ! kill -0 "$ZEN_PID" 2>/dev/null; then
        echo "Error: Zen exited before the debug port came up." >&2
        echo "If a previous zen-mcp instance is using ${PROFILE}, close it or set" >&2
        echo "ZEN_PROFILE to a fresh directory and retry." >&2
        exit 1
    fi
    sleep 1
done

echo "Warning: Zen did not open the debug port on ${PORT} within 30s." >&2
echo "Check that ${ZEN_BIN##*/} supports --remote-debugging-port." >&2
exit 1
