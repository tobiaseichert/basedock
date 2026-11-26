#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Lint src/ and tests/. Pass extra arguments through to ESLint, including
# --fix.
#
# Keep ESLint in its own package so typescript-eslint can use the TypeScript 6
# compiler API alongside the TypeScript 7 build. Install the lint dependencies
# on first use.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
cd "$BASEDOCK_ROOT"

if [[ ! -x lint/node_modules/.bin/eslint ]]; then
  npm ci --prefix lint --no-audit --no-fund
fi
exec lint/node_modules/.bin/eslint --config lint/eslint.config.js "$@" .
