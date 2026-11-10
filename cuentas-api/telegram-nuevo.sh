#!/usr/bin/env bash
# Pasa el bot de Telegram al Emby de ESTE servidor. Se lanza como root en el servidor nuevo:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/telegram-nuevo.sh)
# 1. Para el panel de la VPS antigua (si no, habría dos bots con el mismo token).
# 2. Borra del grupo los temas que creó el bot antiguo (uno por biblioteca, Chat y Avisos); «General» se queda.
# 3. Conecta el bot a este servidor: crea un tema por cada biblioteca del Emby nuevo y avisa de lo nuevo.
# Opcional: la IP de la antigua como primer argumento (por defecto 94.143.140.93).
set -euo pipefail
VIEJO=${1:-94.143.140.93}
ENV=/etc/morvehtv-cuentas/cuentas.env
APP=/opt/morvehtv-cuentas/cuentas-api
TG=${TELEGRAM_API:-https://api.telegram.org}
SOCK=/tmp/tg-ssh-$$
[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
[[ -f $ENV ]] || { echo "Falta el panel en este servidor: lanza antes instalar.sh"; exit 1; }
command -v jq >/dev/null || apt-get install -y -qq jq >/dev/null
trap 'ssh -o ControlPath=$SOCK -O exit "root@$VIEJO" 2>/dev/null || true' EXIT
viejo() { ssh -o ControlPath="$SOCK" "root@$VIEJO" "$@"; }

echo "== 1/4 VPS antigua ($VIEJO). Escribe su contraseña de root (no se verá):"
ssh -o ControlPath="$SOCK" -o ControlMaster=yes -o ControlPersist=30m -o StrictHostKeyChecking=accept-new -fN "root@$VIEJO"
VIEJOS=$(viejo 'cat /var/lib/morvehtv-cuentas/datos.json 2>/dev/null' | jq -c '.telegram // {}' || echo '{}')
TOKEN=$(grep -s '^TELEGRAM_TOKEN=' "$ENV" | cut -d= -f2- || true)
[[ -n $TOKEN ]] || TOKEN=$(viejo "grep -s '^TELEGRAM_TOKEN=' /etc/morvehtv-cuentas/cuentas.env | cut -d= -f2-" || true)
[[ -n $TOKEN ]] || { read -rsp "Token del bot de Telegram (@BotFather). No se verá: " TOKEN </dev/tty; echo; }
[[ $TOKEN =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || { echo "Ese token no parece válido"; exit 1; }
viejo 'rm -f /etc/cron.d/morvehtv-cuentas; if docker ps -aq -f name=^morvehtv-cuentas$ | grep -q .; then docker update --restart=no morvehtv-cuentas >/dev/null; docker stop morvehtv-cuentas >/dev/null; fi; true'
echo "   Panel de la antigua parado (su Emby sigue como estaba)"

echo "== 2/4 Borrando los temas viejos del grupo"
CHAT=$(jq -r '.chat // empty' <<<"$VIEJOS")
llamar() { curl -s -X POST -H 'Content-Type: application/json' -d "$2" "$TG/bot$TOKEN/$1"; }
if [[ -z $CHAT ]]; then
  echo "   La antigua no sabía qué grupo era: no hay temas que borrar"
else
  # Temas de bibliotecas y carpetas, más Chat y Avisos
  jq -r '[(.temas // {})[] | {id, nombre}] + ([.charla, .avisos] | map(select(.id?)) | map({id, nombre: (.nombre // "Chat/Avisos")})) | unique_by(.id)[] | "\(.id)\t\(.nombre)"' <<<"$VIEJOS" |
  while IFS=$'\t' read -r ID NOMBRE; do
    R=$(llamar deleteForumTopic "{\"chat_id\":$(jq -Rn --arg c "$CHAT" '$c'),\"message_thread_id\":$ID}")
    if jq -e .ok <<<"$R" >/dev/null; then echo "   ✓ borrado «$NOMBRE»"
    else echo "   · «$NOMBRE»: $(jq -r '.description // "error"' <<<"$R")"; fi
    sleep 1
  done
fi

echo "== 3/4 Conectando el bot a este Emby"
sed -i '/^TELEGRAM_TOKEN=/d;/^TELEGRAM_CHAT=/d' "$ENV"
printf 'TELEGRAM_TOKEN=%s\n' "$TOKEN" >> "$ENV"
[[ -n $CHAT ]] && printf 'TELEGRAM_CHAT=%s\n' "$CHAT" >> "$ENV"
chmod 600 "$ENV"; unset TOKEN
# Lo que este panel recordaba de Telegram se olvida: empieza de cero con el grupo de siempre
docker compose -f "$APP/docker-compose.yml" stop >/dev/null
jq 'del(.telegram)' /var/lib/morvehtv-cuentas/datos.json > /tmp/datos.$$ && cat /tmp/datos.$$ > /var/lib/morvehtv-cuentas/datos.json && rm -f /tmp/datos.$$
docker compose -f "$APP/docker-compose.yml" up -d --force-recreate >/dev/null
for _ in $(seq 1 30); do docker logs morvehtv-cuentas 2>&1 | grep -q '^Telegram: bot' && break; sleep 2; done
docker logs morvehtv-cuentas 2>&1 | grep '^Telegram' | tail -n 3 | sed 's/^/   /'
[[ -n $CHAT ]] || echo "   Escribe cualquier cosa en el grupo para que el bot lo encuentre"

echo "== 4/4 Listo"
echo "En unos minutos el bot crea un tema por cada biblioteca del Emby nuevo y desde entonces avisa"
echo "de todo lo que se añada. Para anunciar también TODO lo que ya hay (un mensaje por película o serie):"
echo "   docker exec morvehtv-cuentas node admin.mjs avisar-todo"
