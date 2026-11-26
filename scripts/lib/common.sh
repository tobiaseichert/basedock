# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Source these helpers from build scripts and test runners.
#
# Set private XDG directories before dbus-run-session. D-Bus starts services
# such as dconf with the bus environment, so exporting XDG_CONFIG_HOME later
# can send test settings writes to the user's real dconf database.

BASEDOCK_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BASEDOCK_UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$BASEDOCK_ROOT/metadata.json")
BASEDOCK_DISTROBOX=basedock-dev
export BASEDOCK_ROOT BASEDOCK_UUID BASEDOCK_DISTROBOX

# Compile src/ and assemble an unpacked extension in dist/.
basedock_build() {
  (
    cd "$BASEDOCK_ROOT"
    rm -rf dist
    npx tsc
    cp -r metadata.json stylesheet.css icons dist/
    mkdir -p dist/schemas
    cp schemas/*.gschema.xml dist/schemas/
    glib-compile-schemas --strict dist/schemas
  )
}

# Copy dist/ to the given data home's extension directory and print the staged
# path.
basedock_stage() {
  local ext="$1/gnome-shell/extensions/$BASEDOCK_UUID"
  mkdir -p "$ext"
  cp -r "$BASEDOCK_ROOT/dist/." "$ext/"
  echo "$ext"
}

# Enable only baseDOCK and suppress first-run UI inside the private session.
# Require isolated dconf settings before writing them.
basedock_configure_session() {
  if [[ -z "${BASEDOCK_TMP:-}" || ! -d "$BASEDOCK_TMP" ||
        "${XDG_CONFIG_HOME:-}" != "$BASEDOCK_TMP/config" ||
        -L "$XDG_CONFIG_HOME" || -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    echo "ABORT: run Shell settings setup inside the private test session" >&2
    exit 1
  fi
  gsettings set org.gnome.shell enabled-extensions "['$BASEDOCK_UUID']"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
  sleep 0.5
  if [[ ! -f "$XDG_CONFIG_HOME/dconf/user" ]]; then
    echo "ABORT: dconf is not isolated (XDG_CONFIG_HOME=$XDG_CONFIG_HOME)" >&2
    exit 1
  fi
}

# Shell writes a startup crash marker and normally removes it on shutdown or
# after 60 seconds. In a shared runtime directory, a stale marker can disable
# the user's extensions. Remove the marker only when its timestamp shows it was
# created during this run.
basedock_remove_stale_marker() {
  local marker="$1/gnome-shell-disable-extensions"
  if [[ -e "$marker" && $(stat -c %Y "$marker") -ge $2 ]]; then
    rm -f "$marker"
  fi
}
