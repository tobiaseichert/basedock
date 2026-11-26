#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Render style variants of the dock for comparison.
#
#   tests/style-variants.sh <dir-with-css-files> [--window] [--overview]
#
# Use --window to show blur and translucency against the test window. Use
# --overview to capture each style against the dark overview background as
# well.
#
# Layer each variant over stylesheet.css in a headless shell and capture the
# dock. Use ImageMagick to build a labeled sheet with the current style first
# and variants sorted by name.
set -euo pipefail
cd "$(dirname "$0")/.."

variants=$(cd "${1:?usage: tests/style-variants.sh <dir-with-css-files> [--window]}" && pwd)
extra=()
overview=0
for arg in "${@:2}"; do
  case "$arg" in
    --window) extra+=(--window) ;;
    --overview) overview=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
out=$(BASEDOCK_VARIANTS_DIR="$variants" BASEDOCK_VARIANTS_OVERVIEW="$overview" \
  tests/run-headless.sh tests/harness/style-variants.js --timeout 150 "${extra[@]}" | tee /dev/stderr \
  | sed -n 's/^output: //p')

if command -v montage >/dev/null && [[ -n "$out" ]]; then
  mapfile -t shots < <(ls "$out"/*.png | sort)
  # -label must precede the inputs it applies to.
  montage -label '%t' -pointsize 16 "${shots[@]}" -tile 1x -geometry +0+4 \
    -background '#888888' "$out/sheet.png"
  echo "sheet: $out/sheet.png"
fi
