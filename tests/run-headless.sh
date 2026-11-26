#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Build and stage baseDOCK in a private headless GNOME Shell, then run a
# harness.
#
#   tests/run-headless.sh <harness.js> [--window] [--timeout SECONDS]
#
# Set BASEDOCK_MONITOR to change the virtual monitor size from 1600x900. Set
# BASEDOCK_SECOND_MONITOR to add a monitor for the cross-monitor drag check.
#
# Import the harness from the staged extension so it runs inside Shell. Read
# its results using the protocol in tests/harness/lib.js. Pass --window to
# launch a maximized GTK test window.
#
# Succeed when the harness reports DONE without FAIL and the shell log has no
# JavaScript errors or criticals.
#
# Set private XDG config, data, cache and runtime directories before starting
# the session bus.
set -euo pipefail
source "$(dirname "$0")/../scripts/lib/common.sh"

if [[ "${1:-}" == --inner ]]; then
  basedock_configure_session
  # Screen-edge triggers would react to synthetic pointer input.
  gsettings set org.gnome.desktop.interface enable-hot-corners false
  # Pin fixture apps because the default favorites may be unavailable inside
  # the container, including host Flatpaks.
  gsettings set org.gnome.shell favorite-apps "$BASEDOCK_FAVORITES"
  monitors=(--virtual-monitor "$BASEDOCK_MONITOR")
  if [[ -n "${BASEDOCK_SECOND_MONITOR:-}" ]]; then
    monitors+=(--virtual-monitor "$BASEDOCK_SECOND_MONITOR")
  fi
  gnome-shell --headless --wayland --no-x11 "${monitors[@]}" \
    --wayland-display=basedock-test-0 > "$BASEDOCK_TMP/shell.log" 2>&1 &
  pid=$!
  trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null || true' EXIT

  if [[ "$BASEDOCK_WINDOW" == 1 ]]; then
    for _ in $(seq 1 50); do
      [[ -S "$XDG_RUNTIME_DIR/basedock-test-0" ]] && break
      sleep 0.2
    done
    WAYLAND_DISPLAY=basedock-test-0 gjs -m "$BASEDOCK_ROOT/tests/harness/test-window.js" \
      >/dev/null 2>&1 &
  fi

  for _ in $(seq 1 "$BASEDOCK_TIMEOUT"); do
    grep -q "BASEDOCK-HARNESS DONE\|JS ERROR" "$BASEDOCK_TMP/shell.log" && break
    kill -0 $pid 2>/dev/null || break
    sleep 1
  done
  exit 0
fi

harness=${1:?usage: tests/run-headless.sh <harness.js> [--window] [--timeout SECONDS]}
shift
window=0
timeout=60
while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) window=1 ;;
    --timeout) timeout=$2; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

basedock_build
tmp=$(mktemp -d -t basedock-test.XXXXXX)
mkdir -p "$tmp/runtime" "$tmp/out" && chmod 700 "$tmp/runtime"
ext=$(basedock_stage "$tmp/data")
mkdir -p "$ext/harness"
cp "$BASEDOCK_ROOT/tests/harness/lib.js" "$harness" "$ext/harness/"
sed -i "1i import './harness/$(basename "$harness")';" "$ext/extension.js"

# Fixture apps to pin to the dock (see --inner). Launching one does nothing.
mkdir -p "$tmp/data/applications"
favorites=()
for icon in folder user-home text-x-generic application-x-executable; do
  id="basedock-fixture-$icon.desktop"
  printf '[Desktop Entry]\nType=Application\nName=Fixture %s\nExec=true\nIcon=%s\n' \
    "$icon" "$icon" > "$tmp/data/applications/$id"
  favorites+=("'$id'")
done
favorites=$(IFS=,; echo "[${favorites[*]}]")

launcher_status=0
env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  XDG_RUNTIME_DIR="$tmp/runtime" XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_CACHE_HOME="$tmp/cache" \
  BASEDOCK_TMP="$tmp" BASEDOCK_OUT="$tmp/out" BASEDOCK_WINDOW="$window" BASEDOCK_TIMEOUT="$timeout" \
  BASEDOCK_FAVORITES="$favorites" BASEDOCK_MONITOR="${BASEDOCK_MONITOR:-1600x900}" \
  timeout $((timeout + 30)) dbus-run-session "$0" --inner 2>"$tmp/session.stderr" || launcher_status=$?

log="$tmp/shell.log"
if [[ $launcher_status != 0 || ! -f "$log" ]]; then
  cat "$tmp/session.stderr" >&2
  echo "FAIL: headless session failed (status $launcher_status)" >&2
  echo "diagnostics: $tmp" >&2
  exit 1
fi
sed -n 's/.*BASEDOCK-HARNESS //p' "$log"
status=0
if grep -E "JS ERROR|JS WARNING|Gjs-CRITICAL|St-CRITICAL|Clutter-CRITICAL" "$log"; then
  echo "FAIL: errors in shell log"; status=1
fi
grep -q "BASEDOCK-HARNESS FAIL" "$log" && status=1
if ! grep -q "BASEDOCK-HARNESS DONE" "$log"; then
  echo "FAIL: harness did not finish within ${timeout}s"; status=1
fi
echo "log: $log"
echo "output: $tmp/out"
[[ $status == 0 ]] && echo "PASSED" || echo "FAILED"
exit $status
