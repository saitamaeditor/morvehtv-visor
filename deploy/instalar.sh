#!/usr/bin/env bash
# Instala MorvehTV en una VPS con Ubuntu 22.04/24.04 (o Debian 12). Se ejecuta como root:
#
#   bash instalar.sh morvehtv.com               (DNS apuntando directo a la VPS)
#   bash instalar.sh morvehtv.com --cloudflare  (DNS en Cloudflare con la nube naranja)
#
# Se puede volver a ejecutar sin miedo: no borra nada y deja todo como debe estar.
# Lo que hace:
#   · Docker (para el servidor), Caddy (HTTPS automático) y el cortafuegos (solo SSH, 80 y 443;
#     con --cloudflare, 80 y 443 solo desde Cloudflare)
#   · Actualizaciones de seguridad automáticas de Ubuntu y 2 GB de memoria de intercambio
#   · Descarga el visor en /opt/morvehtv-visor y lo arranca
#   · Cada 2 minutos mira si hay cambios en GitHub y, si los hay, se actualiza solo (como Render)
set -euo pipefail

DOMINIO="${1:-}"
CLOUDFLARE=0
[[ "${2:-}" == "--cloudflare" ]] && CLOUDFLARE=1
REPO="https://github.com/saitamaeditor/morvehtv-visor.git"
DIR=/opt/morvehtv-visor
ENV=/etc/morvehtv/visor.env

if [[ $EUID -ne 0 ]]; then echo "Ejecútalo como root (o con sudo)"; exit 1; fi
if [[ ! "$DOMINIO" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
  echo "Uso: bash instalar.sh tudominio.com [--cloudflare]"; exit 1
fi
paso() { echo; echo "==> $*"; }

paso "Paquetes del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https
# Actualizaciones de seguridad solas
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null

paso "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

paso "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

paso "Memoria de intercambio (para que no se quede sin RAM al convertir vídeos)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

paso "Código del visor en $DIR"
if [[ -d "$DIR/.git" ]]; then git -C "$DIR" pull -q --ff-only; else git clone -q "$REPO" "$DIR"; fi
mkdir -p /var/lib/morvehtv/data /etc/morvehtv
chmod 700 /etc/morvehtv

paso "Claves ($ENV)"
if [[ ! -f "$ENV" ]]; then
  cat > "$ENV" <<EOF
# Claves de MorvehTV: copia aquí los valores que tienes en Render → Environment.
# Formato: NOMBRE=valor (sin comillas ni espacios alrededor del =). No lo subas a ningún sitio.
VISOR_URL=https://$DOMINIO
E2_ENDPOINT=
E2_REGION=
E2_BUCKET=
E2_ACCESS_KEY_ID=
E2_SECRET_ACCESS_KEY=
TMDB_KEY=
TMDB_IDIOMA=es-ES
TELEGRAM_TOKEN=
TELEGRAM_CHAT=
VISOR_ADMINS=
CRIPTO_DIRECCION=
LEGAL_TITULAR=
LEGAL_NIF=
LEGAL_DIRECCION=
LEGAL_EMAIL=
# Y cualquier otra que tengas en Render (ANUNCIOS_*, CRIPTO_PRECIOS, PANEL_ORIGENES…)
EOF
fi
chmod 600 "$ENV"

paso "Caddy: https://$DOMINIO → visor"
RANGOS=""
if [[ $CLOUDFLARE == 1 ]]; then
  RANGOS="$(curl -fsSL https://www.cloudflare.com/ips-v4) $(curl -fsSL https://www.cloudflare.com/ips-v6)"
  RANGOS="$(echo $RANGOS | tr -s ' \n' ' ')"
fi
{
  echo "# Generado por deploy/instalar.sh: se rehace cada vez que se ejecuta"
  if [[ -n "$RANGOS" ]]; then
    echo "{"
    echo "	servers {"
    echo "		# La IP real del visitante solo se cree si la manda Cloudflare"
    echo "		trusted_proxies static $RANGOS"
    echo "		client_ip_headers Cf-Connecting-Ip"
    echo "	}"
    echo "}"
  fi
  echo
  echo "$DOMINIO {"
  echo "	# Sin registro de visitas (no se guardan IPs)"
  echo "	reverse_proxy 127.0.0.1:10000 {"
  echo "		# El visor lee la IP de aquí: se sobrescribe para que nadie la pueda inventar"
  echo "		header_up Cf-Connecting-Ip {client_ip}"
  echo "		header_up X-Forwarded-For {client_ip}"
  echo "		flush_interval -1"
  echo "	}"
  echo "}"
  echo
  echo "www.$DOMINIO {"
  echo "	redir https://$DOMINIO{uri} permanent"
  echo "}"
} > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

paso "Cortafuegos"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit 22/tcp comment 'SSH' >/dev/null
if [[ $CLOUDFLARE == 1 ]]; then
  for r in $RANGOS; do
    ufw allow proto tcp from "$r" to any port 80,443 comment 'Cloudflare' >/dev/null
  done
else
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi
ufw --force enable >/dev/null

paso "Actualización automática desde GitHub (cada 2 minutos)"
chmod +x "$DIR/deploy/actualizar.sh"
cat > /etc/cron.d/morvehtv-visor <<EOF
*/2 * * * * root $DIR/deploy/actualizar.sh >> /var/log/morvehtv-actualizar.log 2>&1
EOF
cat > /etc/logrotate.d/morvehtv-visor <<EOF
/var/log/morvehtv-actualizar.log { weekly rotate 4 compress missingok notifempty }
EOF

if grep -qE '^E2_BUCKET=$' "$ENV"; then
  echo
  echo "Falta rellenar las claves. Abre el archivo con:"
  echo "    nano $ENV"
  echo "pega los valores de Render, guarda (Ctrl+O, Enter, Ctrl+X) y vuelve a ejecutar:"
  echo "    bash $DIR/deploy/instalar.sh $DOMINIO${2:+ $2}"
  exit 0
fi

paso "Arrancando el visor (la primera vez tarda unos minutos)"
"$DIR/deploy/actualizar.sh" --forzar

echo
echo "Listo. Comprueba: https://$DOMINIO/api/salud"
