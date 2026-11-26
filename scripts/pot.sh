#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tobias Eichert
# SPDX-License-Identifier: GPL-2.0-or-later
# Regenerate po/basedock.pot after changing translated strings in src/ or
# schema summaries and descriptions. Translators edit po/<language>.po, which
# npm run pack compiles.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
cd "$BASEDOCK_ROOT"

# Use --no-git to avoid gettext 1.0's Git history lookup and its distrobox
# warnings. Run extraction separately for each input language because
# --language applies to every file in a call. Merge the schema strings into the
# first result.
common=(--no-git --from-code=UTF-8 --add-comments=Translators --sort-by-file
  --package-name=baseDOCK --msgid-bugs-address=https://github.com/tobiaseichert/basedock/issues
  --output=po/basedock.pot)
xgettext "${common[@]}" --language=TypeScript --keyword=_ src/*.ts
xgettext "${common[@]}" --join-existing --language=GSettings schemas/*.gschema.xml
echo "Wrote po/basedock.pot"
