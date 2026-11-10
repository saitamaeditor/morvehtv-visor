#!/usr/bin/env bash
# Instala Emby DESDE CERO en un servidor Ubuntu/Debian, sin nada de iDrive ni de otro servidor. Como root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/instalar-emby.sh)
# - El contenido va en los discos del propio servidor: /srv/media (Emby lo ve como /media).
#   Se sube por SFTP (WinSCP) a /srv/media/PELICULAS, /srv/media/SERIES, etc.
# - Emby escucha solo en 127.0.0.1:8096: para configurarlo, túnel SSH desde tu PC
#   (ssh -L 8096:127.0.0.1:8096 root@IP y abrir http://localhost:8096). Nadie de fuera puede
#   adelantarse y quedarse con el asistente de Emby.
# Se puede volver a lanzar sin perder nada.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
[[ -f /etc/debian_version ]] || { echo "Este script es para Ubuntu o Debian"; exit 1; }
if [[ $(hostname) == rescue* ]]; then
  echo "Estás en el modo rescate de Hetzner (todo se pierde al reiniciar). Instala antes Ubuntu con «installimage»."; exit 1
fi

echo "== 1/3 Docker"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates >/dev/null
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh >/dev/null; }
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || { echo "Docker no arranca"; exit 1; }

echo "== 2/3 Emby"
mkdir -p /opt/emby/config /srv/media/PELICULAS /srv/media/SERIES
chown -R 1000:1000 /opt/emby/config /srv/media
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
      - /srv/media:/media
COMPOSE
(cd /opt/emby && docker compose up -d --quiet-pull)
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public && break; sleep 3; done
curl -fsS -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public || { echo "Emby no arranca. Mira: cd /opt/emby && docker compose logs --tail 50"; exit 1; }

echo "== 3/3 Listo"
IP=$(hostname -I | awk '{print $1}')
echo "Emby está en marcha (solo accesible desde este servidor). Espacio libre para contenido: $(df -h --output=avail /srv/media | tail -n1 | tr -d ' ')"
echo "Para configurarlo, en tu PC:"
echo "   ssh -L 8096:127.0.0.1:8096 root@$IP"
echo "y con esa ventana abierta entra en el navegador a  http://localhost:8096"
echo "Sube el contenido por WinSCP a /srv/media/PELICULAS, /srv/media/SERIES…; en Emby esas carpetas son /media/…"
