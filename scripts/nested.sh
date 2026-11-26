#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Stage a fresh build and run it in a nested GNOME Shell window using
# mutter-devkit.
#
# On Fedora Silverblue, setup-distrobox.sh supplies /usr/libexec/mutter-devkit
# inside basedock-dev.
#
# Use private XDG paths for settings, the extension and caches. Keep the
# runtime directory shared for the host Wayland socket and clean up the nested
# shell's crash marker on exit.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

if [[ "${1:-}" == --inner ]]; then
  basedock_configure_session
  export MUTTER_DEBUG_DUMMY_MODE_SPECS=${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1600x900}
  exec gnome-shell --devkit --wayland
fi

basedock_build
tmp=$(mktemp -d -t basedock-nested.XXXXXX)
basedock_stage "$tmp/data" >/dev/null
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
start=$(date +%s)
trap 'basedock_remove_stale_marker "$runtime_dir" "$start"; rm -rf "$tmp"' EXIT

cmd=(env BASEDOCK_TMP="$tmp" XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_CACHE_HOME="$tmp/cache"
     dbus-run-session "$BASEDOCK_ROOT/scripts/nested.sh" --inner)

if [[ ! -x /usr/libexec/mutter-devkit ]]; then
  echo "mutter-devkit is missing: sudo dnf install mutter-devkit (on Silverblue, run scripts/setup-distrobox.sh)" >&2
  exit 1
fi
"${cmd[@]}"
