#!/usr/bin/env bash
# Pone la portada de cada biblioteca de Emby (una sola vez, nada automático). Como root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/portadas-bibliotecas/poner.sh)
# Cada biblioteca recibe la imagen según la carpeta de /mnt que usa: 03.PEL-FHD → pel-fhd.jpg, etc.
set -euo pipefail
ENV=/etc/morvehtv-cuentas/cuentas.env
EMBY=http://127.0.0.1:8096/emby
BASE=https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/portadas-bibliotecas
K=$(grep -s '^EMBY_API_KEY=' "$ENV" | cut -d= -f2- || true)
[[ -n $K ]] || { echo "No encuentro la clave de Emby en $ENV"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsS -H "X-Emby-Token: $K" "$EMBY/Library/VirtualFolders" |
  jq -r '.[] | select(.ItemId) | [.ItemId, .Name, ((.Locations // [])[0] // "")] | @tsv' |
while IFS=$'\t' read -r ID NOMBRE RUTA; do
  # /mnt/03.PEL-FHD2/lo-que-sea → pel-fhd
  C=${RUTA#/mnt/}; C=${C%%/*}; C=${C#*.}; C=${C%2}; C=${C,,}; C=${C/documentales/documental}
  if ! curl -fsSL "$BASE/$C.jpg" -o "$TMP/$C.jpg" 2>/dev/null; then echo "   · «$NOMBRE»: no hay portada para «$C»"; continue; fi
  if base64 -w0 "$TMP/$C.jpg" | curl -fsS -o /dev/null -X POST -H "X-Emby-Token: $K" -H 'Content-Type: image/jpeg' --data-binary @- "$EMBY/Items/$ID/Images/Primary"; then
    echo "   ✓ «$NOMBRE» → $C.jpg"
  else echo "   ✗ «$NOMBRE»: Emby no la aceptó"; fi
done
echo "Hecho. Si alguna no cambia en la app, recarga (Ctrl+F5 en el navegador)."
