#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Capture dock and overview animations using the capture harness. If
# ImageMagick's montage is available, build contact sheets from every third
# frame.
#
# BASEDOCK_CAPTURE_SLOWDOWN (default 4) sets the animation slow-down factor.
set -euo pipefail
cd "$(dirname "$0")/.."

out=$(tests/run-headless.sh tests/harness/capture.js --window --timeout 150 | tee /dev/stderr \
  | sed -n 's/^output: //p')

if command -v montage >/dev/null && [[ -n "$out" ]]; then
  for tag in resize-drag ws-switch reorder drag-icon dock-hide dock-show exit-picker exit-appgrid enter-unmax exit-unmax; do
    mapfile -t frames < <(ls "$out"/"$tag"-*.png | awk 'NR % 3 == 1')
    [[ ${#frames[@]} -gt 0 ]] || continue
    montage "${frames[@]}" -tile 4x -geometry 480x270+4+4 "$out/sheet-$tag.png"
    echo "sheet: $out/sheet-$tag.png"
  done
fi
