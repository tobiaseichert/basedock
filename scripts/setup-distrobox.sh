#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Create the basedock-dev development container for Fedora Silverblue. Match
# the host Fedora release so headless tests and the nested shell run the same
# GNOME Shell version.
#
# Export node, npm and npx to ~/.local/bin so host commands run inside the
# container. The container shares the home directory, session bus and
# processes, so npm run deploy targets the real session.
#
# Run this script directly for setup. Run it again to install newly listed
# packages.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

release=$(. /etc/os-release && echo "$VERSION_ID")
# Point Shell's logind client (loginManager.js) at the host system bus.
# Distrobox mounts it under /run/host/run/dbus. Changing the bus address
# requires recreating the container.
if ! distrobox list --no-color | grep -q "| $BASEDOCK_DISTROBOX "; then
  distrobox create -Y -n "$BASEDOCK_DISTROBOX" -i "registry.fedoraproject.org/fedora-toolbox:$release" \
    --additional-flags "--env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/host/run/dbus/system_bus_socket"
fi

in_box() { distrobox enter -n "$BASEDOCK_DISTROBOX" -- "$@"; }

# gnome-shell: headless test shells, gnome-extensions (pack, deploy), gjs
#   with GTK 4 for the test window
# mutter-devkit: the window of `npm run nested`
# nodejs, npm: tsc and ESLint
# ImageMagick: contact sheets of `npm run capture` and style-variants
packages=(gnome-shell mutter-devkit dbus-daemon gtk4 glib2 nodejs nodejs-npm ImageMagick procps-ng zip)
# Container-incompatible package scriptlets can make dnf report failure after
# installing every requested package. Check the installed packages before
# treating setup as failed.
in_box sudo dnf install -y "${packages[@]}" || true
in_box rpm -q "${packages[@]}" >/dev/null

for bin in node npm npx; do
  in_box distrobox-export --bin "/usr/bin/$bin" --export-path "$HOME/.local/bin"
done

# Dependencies for the build. lint/ installs its own on first `npm run lint`.
in_box bash -c "cd '$BASEDOCK_ROOT' && npm ci --no-audit --no-fund"
echo "Ready: run npm commands as usual, e.g. npm run check"
