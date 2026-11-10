#!/usr/bin/env bash
# Instala Emby y el montaje de iDrive e2 (rclone) DESDE CERO en un servidor Ubuntu/Debian, sin copiar
# nada de otro servidor. Como root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/instalar-emby.sh)
# - e2 se monta SOLO LECTURA en /mnt/e2 (servicio rclone-e2); Emby lo ve como /e2.
# - Emby escucha solo en 127.0.0.1:8096: para configurarlo, túnel SSH desde tu PC
#   (ssh -L 8096:127.0.0.1:8096 root@IP y abrir http://localhost:8096). Nadie de fuera puede
#   adelantarse y quedarse con el asistente de Emby.
# Se puede volver a lanzar: no pisa nada que ya funcione (para cambiar las claves de e2: rm el
# remoto con «rclone config delete e2» y relanzarlo).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
[[ -f /etc/debian_version ]] || { echo "Este script es para Ubuntu o Debian"; exit 1; }
if [[ $(hostname) == rescue* ]]; then
  echo "Estás en el modo rescate de Hetzner (todo se pierde al reiniciar). Instala antes Ubuntu con «installimage»."; exit 1
fi

echo "== 1/4 Programas (Docker, rclone)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl fuse3 unzip ca-certificates >/dev/null
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh >/dev/null; }
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || { echo "Docker no arranca"; exit 1; }
command -v rclone >/dev/null || { curl -fsSL https://rclone.org/install.sh | bash >/dev/null; }
grep -qs '^user_allow_other' /etc/fuse.conf || echo user_allow_other >> /etc/fuse.conf

echo "== 2/4 iDrive e2"
if ! rclone config show e2 >/dev/null 2>&1; then
  echo "Datos de tu iDrive e2 (en iDrive e2 → Access Keys y Buckets). Las claves no se verán al pegarlas."
  read -rp  "Endpoint (p. ej. abcd.par.idrivee2-26.com): " E2E </dev/tty
  E2E=${E2E#https://}; E2E=${E2E%/}
  read -rp  "Nombre del bucket [morvehtv]: " BUCKET </dev/tty
  read -rsp "Access Key ID: " E2K </dev/tty; echo
  read -rsp "Secret Access Key: " E2S </dev/tty; echo
  [[ -n $E2E && -n $E2K && -n $E2S ]] || { echo "Faltan datos: vuelve a lanzarlo"; exit 1; }
  rclone config create e2 s3 provider IDrive endpoint "$E2E" access_key_id "$E2K" secret_access_key "$E2S" >/dev/null
  unset E2K E2S
  chmod 600 "$(rclone config file | tail -n1)"
  echo "${BUCKET:-morvehtv}" > /root/.e2-bucket
fi
BUCKET=$(cat /root/.e2-bucket 2>/dev/null || echo morvehtv)
rclone lsd "e2:$BUCKET" >/dev/null 2>&1 || { echo "No puedo leer el bucket «$BUCKET» con esas claves. Bórralas con «rclone config delete e2» y relánzalo."; exit 1; }
mkdir -p /mnt/e2 /var/cache/rclone-e2
cat > /etc/systemd/system/rclone-e2.service <<UNIT
[Unit]
Description=iDrive e2 montado en /mnt/e2 (solo lectura)
After=network-online.target
Wants=network-online.target
Before=docker.service

[Service]
Type=notify
ExecStart=$(command -v rclone) mount e2:$BUCKET /mnt/e2 \\
  --read-only --allow-other --dir-cache-time 1m --poll-interval 0 \\
  --vfs-cache-mode full --vfs-cache-max-size 60G --vfs-cache-max-age 24h \\
  --vfs-read-chunk-size 32M --buffer-size 32M --cache-dir /var/cache/rclone-e2
ExecStop=/bin/fusermount3 -uz /mnt/e2
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q rclone-e2
systemctl restart rclone-e2
for _ in $(seq 1 30); do mountpoint -q /mnt/e2 && break; sleep 2; done
mountpoint -q /mnt/e2 || { echo "e2 no se monta. Mira: journalctl -u rclone-e2 -n 30"; exit 1; }
echo "   e2 montado en /mnt/e2: $(ls /mnt/e2 | wc -l) carpetas"

echo "== 3/4 Emby"
mkdir -p /opt/emby/config
chown -R 1000:1000 /opt/emby/config
cat > /opt/emby/docker-compose.yml <<'COMPOSE'
services:
  emby:
    image: emby/embyserver:latest
    container_name: emby
    restart: unless-stopped
    environment:
      UID: "1000"
      GID: "1000"
      TZ: Europe/Madrid
    ports:
      - "127.0.0.1:8096:8096"
    volumes:
      - /opt/emby/config:/config
      - /mnt/e2:/e2:ro,rslave
COMPOSE
(cd /opt/emby && docker compose up -d --quiet-pull)
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public && break; sleep 3; done
curl -fsS -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public || { echo "Emby no arranca. Mira: cd /opt/emby && docker compose logs --tail 50"; exit 1; }

echo "== 4/4 Listo"
IP=$(hostname -I | awk '{print $1}')
echo "Emby está en marcha (solo accesible desde este servidor). Para configurarlo, en tu PC:"
echo "   ssh -L 8096:127.0.0.1:8096 root@$IP"
echo "y con esa ventana abierta entra en el navegador a  http://localhost:8096"
echo "Al añadir bibliotecas, tus carpetas de e2 están en /e2"
