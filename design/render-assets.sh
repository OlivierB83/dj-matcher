#!/bin/sh
# Régénère les PNG de public/ à partir des sources SVG de design/, sans dépendance npm.
# Rendu : Google Chrome headless (déjà installé sur le Mac) — QuickLook (qlmanage -t)
# force un canevas carré et aplatit la transparence sur du blanc, donc inutilisable.
# Vérification des tailles : sips.
#   sh design/render-assets.sh            (ou CHROME=/chemin/vers/chrome sh design/render-assets.sh)
# Produit : public/favicon.svg (copie du logo), public/og.png (1200×630),
#           public/icons/icon-192.png, icon-512.png, icon-512-maskable.png,
#           public/apple-touch-icon.png (180×180).
set -eu
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "Chrome introuvable : $CHROME (définir CHROME=…)" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

render() { # render <svg> <largeur px> <hauteur px> <png de sortie>
  svg="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  out="$(cd "$(dirname "$4")" && pwd)/$(basename "$4")"
  # Page minimale : <img> met le SVG exactement à la taille demandée (Chrome ne
  # redimensionne pas un document SVG ouvert directement).
  printf '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><img src="file://%s" style="display:block;width:%spx;height:%spx"></body>' \
    "$svg" "$2" "$3" > "$TMP/page.html"
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile" --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$2,$3" \
    --screenshot="$out" "file://$TMP/page.html" >/dev/null 2>&1
  printf '%-36s %s\n' "$4" "$(sips -g pixelWidth -g pixelHeight "$out" | awk '/pixel/ {printf "%s ", $2}')"
}

# Icônes plein cadre (fond opaque) composées à partir du logo : disques à l'échelle 1
# pour apple-touch-icon (iOS applique son propre masque arrondi), à 0,8 pour l'icône
# « maskable » (zone sûre = cercle central de 80 %).
DEFS=$(sed -n '/<!-- defs:start -->/,/<!-- defs:end -->/p' design/logo.svg)
DISCS=$(sed -n '/<!-- discs:start -->/,/<!-- discs:end -->/p' design/logo.svg)
wrap() { # wrap <échelle> → SVG sur stdout
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">%s<rect width="100" height="100" fill="url(#dm-bg)"/><g transform="translate(50 50) scale(%s) translate(-50 -50)">%s</g></svg>' \
    "$DEFS" "$1" "$DISCS"
}
wrap 1   > "$TMP/apple-touch-icon.svg"
wrap 0.8 > "$TMP/icon-maskable.svg"

mkdir -p public/icons
cp design/logo.svg public/favicon.svg
render design/og.svg                 1200 630 public/og.png
render design/logo.svg               192  192 public/icons/icon-192.png
render design/logo.svg               512  512 public/icons/icon-512.png
render "$TMP/icon-maskable.svg"      512  512 public/icons/icon-512-maskable.png
render "$TMP/apple-touch-icon.svg"   180  180 public/apple-touch-icon.png
