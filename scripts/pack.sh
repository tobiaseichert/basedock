#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Build and bundle the extension into <uuid>.shell-extension.zip.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
cd "$BASEDOCK_ROOT"

basedock_build
cp LICENSE dist/

# List compiled modules explicitly because gnome-extensions pack automatically
# includes only the standard entry points, metadata and stylesheet.
extra=()
while IFS= read -r f; do
  extra+=(--extra-source="$f")
done < <(cd dist && find . -name '*.js' ! -name extension.js ! -name prefs.js -printf '%P\n' | sort)

# Pass asset directories as a whole so their paths are preserved.
extra+=(--extra-source=icons --extra-source=LICENSE)

# Ship schema XML. The GNOME Shell installer compiles it.
for schema in dist/schemas/*.gschema.xml; do
  extra+=(--schema="schemas/$(basename "$schema")")
done

# Compile translations into locale/, using the gettext domain in metadata.json.
extra+=(--podir="$BASEDOCK_ROOT/po")

gnome-extensions pack dist --force --out-dir . "${extra[@]}"
echo "Packed $BASEDOCK_UUID.shell-extension.zip"
