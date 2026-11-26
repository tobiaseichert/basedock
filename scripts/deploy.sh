#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Pack and install baseDOCK for the current user.
#
# GNOME Shell reloads CSS on enable (extensionSystem.js) and caches JavaScript
# for the session. Toggle the extension to apply styles when the session
# already has the current code. A new login loads updated modules and styles
# together.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
cd "$BASEDOCK_ROOT"

scripts/pack.sh

# Packing rewrites every built file. Use a hash stamp to track changes to
# compiled JavaScript, including comments preserved by the build. On the
# first run, fall back to the last commit touching src/.
stamp="${XDG_CACHE_HOME:-$HOME/.cache}/basedock/deployed-code.sha256"
hash=$(cd "$BASEDOCK_ROOT/dist" && find . -name '*.js' -print0 | sort -z | xargs -0 cat | sha256sum | cut -d' ' -f1)
if [[ ! -f "$stamp" || "$(cat "$stamp")" != "$hash" ]]; then
  mkdir -p "$(dirname "$stamp")"
  first_run=0
  [[ -f "$stamp" ]] || first_run=1
  echo "$hash" > "$stamp"
  if [[ $first_run == 1 ]] && last=$(git -C "$BASEDOCK_ROOT" log -1 --format=%ct -- src 2>/dev/null) && [[ -n "$last" ]]; then
    touch -d "@$last" "$stamp"
  fi
fi

gnome-extensions install --force "$BASEDOCK_UUID.shell-extension.zip"

# Compare the shell's start time with the last code change to decide whether
# toggling can apply the update.
shell_pid=$(pgrep -u "$(id -u)" -x gnome-shell | head -1 || true)
code_stale=1
if [[ -n "$shell_pid" ]]; then
  shell_start=$(( $(date +%s) - $(ps -o etimes= -p "$shell_pid") ))
  [[ $(stat -c %Y "$stamp") -lt $shell_start ]] && code_stale=0
fi

state=$(gnome-extensions info "$BASEDOCK_UUID" 2>/dev/null | sed -n 's/^ *State: //p' || true)
if [[ "$state" != ACTIVE ]]; then
  echo "Installed. Log out and back in to load it in your session."
elif [[ $code_stale == 1 ]]; then
  echo "Installed. The code is newer than your session: log out and back in to"
  echo "load it. (Styles aren't reloaded live either, so the running dock stays"
  echo "consistent until then.)"
else
  gnome-extensions disable "$BASEDOCK_UUID"
  gnome-extensions enable "$BASEDOCK_UUID"
  echo "Installed and restarted: style changes are live."
fi
