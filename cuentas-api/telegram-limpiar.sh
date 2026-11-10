#!/usr/bin/env bash
# Borra todos los anuncios del bot en el grupo de Telegram y para los avisos en marcha
# (p. ej. un «avisar-todo» de miles de títulos). Como root en el servidor:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/telegram-limpiar.sh)
# Los temas de las bibliotecas se borran con todos sus mensajes y el bot los vuelve a crear vacíos;
# desde entonces solo avisa de lo NUEVO. «Chat», «Avisos» y «General» no se tocan.
set -euo pipefail
APP=/opt/morvehtv-cuentas/cuentas-api
DATOS=/var/lib/morvehtv-cuentas/datos.json
URL=https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/telegram-limpiar.mjs
[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
[[ -f $DATOS ]] || { echo "No encuentro $DATOS"; exit 1; }
JS=$(mktemp /root/tg-limpiar.XXXX.mjs)
trap 'rm -f "$JS"' EXIT
curl -fsSL "$URL" -o "$JS"; chmod 644 "$JS"
cp -f "$DATOS" "$DATOS.antes-limpiar"
echo "== Parando el panel (copia de los datos en $DATOS.antes-limpiar)"
docker compose -f "$APP/docker-compose.yml" stop >/dev/null
ok=0
docker compose -f "$APP/docker-compose.yml" run --rm --no-deps -v "$JS:/app/limpiar.mjs:ro" cuentas node limpiar.mjs || ok=$?
echo "== Arrancando el panel"
docker compose -f "$APP/docker-compose.yml" up -d >/dev/null
(( ok == 0 )) || { echo "Algo falló (arriba el motivo); los datos no se han tocado si no llegó a «Hecho»"; exit 1; }
echo "En un minuto el bot vuelve a crear los temas de las bibliotecas, vacíos."
