#!/usr/bin/env bash
#
# djay-import-all.sh — full one-shot pipeline for importing the djay
# library into knownTracks.json and deploying.
#
# Walks through:
#   1. visible 3-2-1 countdown so the user can flip to djay
#   2. AX extract from djay → /tmp/djay-rows.json
#   3. preview of what the import would change
#   4. user confirmation (Enter to proceed, Ctrl-C to abort)
#   5. djay-ax-import.js --commit (with API enrichment of new tracks)
#   6. dedup-versions.js --commit (merges multi-version duplicates)
#   7. git commit + push so Render + Vercel pick up the new catalog
#   8. final catalog count
#
# Run from the project root.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

EXTRACT_BIN="$ROOT/djay-ax-extract"
ROWS_JSON="/tmp/djay-rows.json"
EXTRACT_ERR="/tmp/djay-rows.err"

if [ ! -x "$EXTRACT_BIN" ]; then
  echo "❌ Binaire $EXTRACT_BIN absent ou non exécutable."
  echo "   Compile-le avec :"
  echo "   swiftc djay-ax-extract.swift -framework AppKit -framework ApplicationServices -O -o djay-ax-extract"
  exit 1
fi

# Print BEFORE the countdown so the user is already looking at the
# message when "passe sur djay" appears.
echo
echo "  📷 Bascule sur djay Pro dans :"
for n in 3 2 1; do
  printf "    %d…\n" "$n"
  sleep 1
done
echo "  (extraction en cours, ne bouge plus jusqu'au prochain message)"
echo

# Capture both stdout (JSON) and stderr (progress logs) — the JSON goes
# to a file, the progress is shown to the user as the extractor runs.
"$EXTRACT_BIN" >"$ROWS_JSON" 2> >(tee "$EXTRACT_ERR" >&2)

ROW_COUNT=$(grep -c '"cells"' "$ROWS_JSON" || true)
echo
echo "  ✓ ${ROW_COUNT} lignes extraites → $ROWS_JSON"
echo

echo "============================================================"
echo "  PREVIEW DE L'IMPORT (rien n'est encore appliqué)"
echo "============================================================"
node djay-ax-import.js "$ROWS_JSON"
echo

echo "============================================================"
echo "  Appuie sur ENTRÉE pour appliquer + enrichir + dédup + push."
echo "  Ctrl-C pour annuler."
echo "============================================================"
read -r _confirm

# Snapshot Songstats usage BEFORE the commit so we can show "this run
# burned N requests" at the end. Songstats is billed per call (~0.01 €).
SONGSTATS_BEFORE=$(node -e "
const fs = require('fs');
if (!fs.existsSync('./songstats-usage-log.json')) { console.log(0); process.exit(0); }
const c = fs.readFileSync('./songstats-usage-log.json', 'utf8').trim();
console.log(c ? JSON.parse(c).length : 0);
")

echo
echo "============================================================"
echo "  COMMIT 1/2 : djay-ax-import.js --commit (avec enrichment)"
echo "============================================================"
node djay-ax-import.js "$ROWS_JSON" --commit

echo
echo "============================================================"
echo "  COMMIT 2/2 : dédup des versions multiples"
echo "============================================================"
node dedup-versions.js --commit

CATALOG_COUNT=$(node -e "console.log(require('./knownTracks.json').length)")
SONGSTATS_AFTER=$(node -e "
const fs = require('fs');
if (!fs.existsSync('./songstats-usage-log.json')) { console.log(0); process.exit(0); }
const c = fs.readFileSync('./songstats-usage-log.json', 'utf8').trim();
console.log(c ? JSON.parse(c).length : 0);
")
SONGSTATS_DELTA=$((SONGSTATS_AFTER - SONGSTATS_BEFORE))
SONGSTATS_COST=$(node -e "console.log(($SONGSTATS_DELTA * 0.01).toFixed(2))")

echo
echo "============================================================"
echo "  📚 Catalogue : ${CATALOG_COUNT} titres"
echo "  💸 Songstats sur ce run : ${SONGSTATS_DELTA} requêtes (~${SONGSTATS_COST} €)"
echo "============================================================"
node songstats-usage-report.js
echo

# git: only commit + push if knownTracks.json actually changed.
if git diff --quiet -- knownTracks.json; then
  echo "  ✓ Aucun changement sur knownTracks.json — rien à pousser."
  exit 0
fi

echo "  git add + commit + push…"
git add knownTracks.json
git commit -m "djay AX import : catalogue à ${CATALOG_COUNT} titres"
git push origin main

echo
echo "  ✅ Push effectué. Render + Vercel vont se redéployer dans les minutes qui suivent."
