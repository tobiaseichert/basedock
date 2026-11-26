#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
set -euo pipefail
source "$(dirname "$0")/../scripts/lib/common.sh"

tmp=$(mktemp -d -t basedock-isolation-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

# Record writes without touching an actual settings backend.
gsettings() {
  touch "$tmp/settings-called"
}

assert_rejected() {
  if (basedock_configure_session) >"$tmp/setup.log" 2>&1 ||
     [[ -e "$tmp/settings-called" ]] ||
     ! grep -q 'ABORT: run Shell settings setup inside the private test session' "$tmp/setup.log"; then
    echo "FAIL: $1" >&2
    cat "$tmp/setup.log" >&2
    exit 1
  fi
}

unset BASEDOCK_TMP XDG_CONFIG_HOME DBUS_SESSION_BUS_ADDRESS
assert_rejected 'settings setup without an isolated launch'

export BASEDOCK_TMP="$tmp" DBUS_SESSION_BUS_ADDRESS="unix:path=$tmp/bus"
export XDG_CONFIG_HOME="$tmp/wrong-config"
assert_rejected 'settings setup with a mismatched config directory'

export XDG_CONFIG_HOME="$tmp/config"
ln -s "$tmp/wrong-config" "$XDG_CONFIG_HOME"
assert_rejected 'settings setup with a symlinked config directory'
rm "$XDG_CONFIG_HOME"

unset DBUS_SESSION_BUS_ADDRESS
assert_rejected 'settings setup without a session bus'

echo 'PASS: invalid session setup is rejected before settings writes'
