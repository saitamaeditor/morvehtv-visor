#!/usr/bin/env bash
# Pasa MorvehTV (Emby, panel, app y Telegram) de la VPS antigua a ESTE servidor. Se lanza como root
# en el servidor NUEVO (te pedirá una vez la contraseña de root de la VPS antigua):
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/migrar.sh)
# Opcional: la IP de la antigua como primer argumento (por defecto 94.143.140.93).
# Copia Emby entero (usuarios, bibliotecas, metadatos), el montaje de e2, el certificado de Cloudflare,
# Caddy, las claves y los datos del panel. Al final para la antigua (sin borrar nada en ella).
set -euo pipefail
VIEJO=${1:-94.143.140.93}
SOCK=/tmp/migrar-ssh-$$
SSH="ssh -o ControlPath=$SOCK -o StrictHostKeyChecking=accept-new"
CUENTAS=https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/instalar.sh

[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
[[ -f /etc/debian_version ]] || { echo "Este script es para Ubuntu o Debian"; exit 1; }
# El «Rescue System» de Hetzner vive en la RAM: lo que se instale ahí se pierde al reiniciar
if [[ $(hostname) == rescue* ]] || grep -qs 'hetzner' /etc/motd && [[ ! -d /boot/grub ]]; then
  echo "Estás en el modo rescate (todo se pierde al reiniciar). Instala antes el sistema con «installimage»"
  echo "(Ubuntu 24.04), reinicia, entra de nuevo y vuelve a lanzar este script."; exit 1
fi
trap 'ssh -o ControlPath=$SOCK -O exit "root@$VIEJO" 2>/dev/null || true' EXIT
viejo() { $SSH "root@$VIEJO" "$@"; }
# Copia carpetas o archivos de la antigua al mismo sitio en esta (-x: sin meterse en montajes como /mnt/e2)
traer() {
  local x; for x in "$@"; do
    mkdir -p "$(dirname "$x")"
    rsync -aHx --numeric-ids --delete --exclude 'transcoding-temp/' -e "$SSH" "root@$VIEJO:$x" "$(dirname "$x")/"
  done
}

echo "== 1/7 Programas (Docker, Caddy, rclone)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git rsync fuse3 unzip ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh >/dev/null; }
command -v rclone >/dev/null || { curl -fsSL https://rclone.org/install.sh | bash >/dev/null; }
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || { echo "Docker no arranca en este servidor: no sigo (la antigua no se ha tocado)"; exit 1; }

echo "== 2/7 Conexión con la VPS antigua ($VIEJO). Escribe su contraseña de root (no se verá):"
ssh -o ControlPath="$SOCK" -o ControlMaster=yes -o ControlPersist=3h -o StrictHostKeyChecking=accept-new -fN "root@$VIEJO"
viejo 'test -d /opt/emby && test -f /var/lib/morvehtv-cuentas/datos.json && test -f /etc/caddy/cf-origen.pem' \
  || { echo "En la antigua no encuentro Emby (/opt/emby), los datos del panel o el certificado: no sigo"; exit 1; }
viejo 'command -v rsync >/dev/null || (apt-get update -qq && apt-get install -y -qq rsync >/dev/null)'
RCLONE_CONF=$(viejo 'rclone config file' | tail -n1)
UNIDAD=$(viejo 'systemctl show -p FragmentPath --value rclone-e2')
[[ -n $RCLONE_CONF && -n $UNIDAD ]] || { echo "En la antigua no encuentro la configuración de rclone o el servicio rclone-e2"; exit 1; }
echo "   Emby ocupa $(viejo 'du -shx /opt/emby | cut -f1') en la antigua"

echo "== 3/7 Primera copia (todo sigue funcionando en la antigua mientras tanto)"
traer /opt/emby /var/lib/morvehtv-cuentas /etc/morvehtv-cuentas /etc/caddy "$RCLONE_CONF" "$UNIDAD" /etc/fuse.conf

echo "== 4/7 Parando la antigua (para que no haya dos Emby ni dos bots de Telegram a la vez)"
viejo 'rm -f /etc/cron.d/morvehtv-cuentas
  cd /opt/emby && for c in $(docker compose ps -aq) $(docker ps -aq -f name=^morvehtv-cuentas$); do docker update --restart=no "$c" >/dev/null; docker stop "$c" >/dev/null; done; true'

echo "== 5/7 Copia final (solo lo que ha cambiado)"
traer /opt/emby /var/lib/morvehtv-cuentas

echo "== 6/7 Arrancando aquí"
mkdir -p /mnt/e2
systemctl daemon-reload
systemctl enable --now rclone-e2
for _ in $(seq 1 30); do mountpoint -q /mnt/e2 && break; sleep 2; done
mountpoint -q /mnt/e2 || { echo "e2 no se monta. Mira: journalctl -u rclone-e2 -n 30"; exit 1; }
echo "   e2 montado: $(ls /mnt/e2 | wc -l) carpetas"
(cd /opt/emby && docker compose up -d --quiet-pull)
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public && break; sleep 3; done
curl -fsS -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public || { echo "Emby no arranca. Mira: cd /opt/emby && docker compose logs --tail 50"; exit 1; }
echo "   Emby en marcha"
systemctl enable -q caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "El Caddyfile copiado no es válido"; exit 1; }
systemctl restart caddy
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
# Panel, app y actualizaciones automáticas: el instalador de siempre (ya tiene claves y administradores)
bash <(curl -fsSL "$CUENTAS")

echo "== 7/7 Comprobación"
ok() { if "${@:2}" >/dev/null 2>&1; then echo "   ✓ $1"; else echo "   ✗ $1"; FALLO=1; fi; }
FALLO=0
ok "e2 montado" mountpoint -q /mnt/e2
ok "Emby" curl -fsS http://127.0.0.1:8096/emby/System/Info/Public
ok "API del panel" curl -fsS http://127.0.0.1:10100/api/salud
ok "Caddy: panel.morvehtv.com" curl -fsSk --resolve panel.morvehtv.com:443:127.0.0.1 https://panel.morvehtv.com/api/salud
ok "Caddy: emby.morvehtv.com" curl -fsSk --resolve emby.morvehtv.com:443:127.0.0.1 https://emby.morvehtv.com/emby/System/Info/Public
ok "Caddy: morvehtv.com" curl -fsSk --resolve morvehtv.com:443:127.0.0.1 https://morvehtv.com/
IP=$(hostname -I | awk '{print $1}')
echo
if [[ $FALLO == 0 ]]; then echo "MIGRADO."; else echo "Hay algo con ✗: revísalo antes de cambiar el DNS."; fi
echo "Ahora en Cloudflare → DNS cambia a $IP (nube naranja) los registros A de:"
echo "   morvehtv.com · www · emby · panel"
echo "Si algo fuera mal, vuelve a encender la antigua con:"
echo "   ssh root@$VIEJO 'cd /opt/emby && docker compose start && docker update --restart=unless-stopped \$(docker compose ps -aq) morvehtv-cuentas; docker start morvehtv-cuentas'"
