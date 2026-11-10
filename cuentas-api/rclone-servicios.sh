#!/usr/bin/env bash
# Pasa los montajes de rclone de /root/montar-rclone.sh (lanzado con @reboot) a servicios de systemd,
# uno por carpeta, con los MISMOS remotos y las MISMAS carpetas de /mnt (en Emby no cambia nada).
# Como root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/rclone-servicios.sh)
# Arregla los cuelgues:
#  · quita /root/limpiar_cache_rclone.sh del cron: borraba /CacheVOD cada 6 h con rclone en marcha
#    (rclone ya limpia su caché solo: --vfs-cache-max-age y el tamaño máximo)
#  · caché por carpeta de 10G y siempre 40G libres en el disco (--vfs-cache-min-free-space)
#  · lecturas por trozos de 32M que crecen hasta 512M (antes 512M de golpe en cada análisis de Emby)
#  · si un montaje se cae, systemd lo vuelve a montar; al arrancar el servidor se montan antes que Docker
# Los dos scripts antiguos no se borran (se quedan como .antes). Se puede volver a lanzar.
set -euo pipefail
ORIGEN=${1:-/root/montar-rclone.sh}
[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
[[ -f $ORIGEN ]] || { echo "No encuentro $ORIGEN"; exit 1; }
RCLONE=$(command -v rclone) || { echo "Falta rclone"; exit 1; }
CONF=$("$RCLONE" config file | tail -n1)
[[ -f $CONF ]] || { echo "No encuentro la configuración de rclone ($CONF)"; exit 1; }

# Remoto y carpeta de cada línea «rclone mount REMOTO PUNTO …» (las comillas del remoto fuera)
mapfile -t MONTAJES < <(awk '$2 == "mount" && $1 ~ /rclone$/ { r = $3; gsub(/"/, "", r); m = $4; gsub(/"/, "", m); print r "\t" m }' "$ORIGEN")
(( ${#MONTAJES[@]} )) || { echo "No hay ningún «rclone mount» en $ORIGEN"; exit 1; }
echo "== ${#MONTAJES[@]} montajes encontrados en $ORIGEN"

echo "== 1/4 Cron: fuera el borrado de caché y el @reboot"
crontab -l > /root/crontab.antes 2>/dev/null || true
grep -v -e 'limpiar_cache_rclone' -e 'montar-rclone' /root/crontab.antes | crontab - || true
[[ -f /root/limpiar_cache_rclone.sh ]] && mv /root/limpiar_cache_rclone.sh /root/limpiar_cache_rclone.sh.antes
cp -f "$ORIGEN" "$ORIGEN.antes"

echo "== 2/4 Parando Emby y los montajes viejos"
timeout 60 docker kill emby >/dev/null 2>&1 || true
for u in /etc/systemd/system/rclone-mnt-*.service; do [[ -e $u ]] && systemctl stop "$(basename "$u")" 2>/dev/null || true; done
awk '$3 ~ /rclone/ {print $2}' /proc/mounts | while read -r m; do fusermount3 -uz "$(printf '%b' "$m")" 2>/dev/null || umount -l "$(printf '%b' "$m")" 2>/dev/null || true; done
pkill -x rclone 2>/dev/null || true
for _ in $(seq 1 15); do pgrep -x rclone >/dev/null || break; sleep 1; done
pkill -9 -x rclone 2>/dev/null || true
# Nada usa ya la caché: se vacía UNA vez (los restos a medias del borrado de cada 6 h)
mkdir -p /CacheVOD /var/log/rclone
find /CacheVOD -mindepth 1 -delete 2>/dev/null || true

echo "== 3/4 Servicios de systemd"
cat > /etc/logrotate.d/rclone-mnt <<'ROT'
/var/log/rclone/*.log {
  weekly
  rotate 2
  compress
  missingok
  notifempty
  copytruncate
}
ROT
UNIDADES=()
for linea in "${MONTAJES[@]}"; do
  REMOTO=${linea%%$'\t'*}; PUNTO=${linea#*$'\t'}; NOMBRE=$(basename "$PUNTO")
  if [[ $NOMBRE =~ ^[A-Za-z0-9._-]+$ ]]; then U="rclone-mnt-$NOMBRE.service"; else U="rclone-mnt-$(systemd-escape "$NOMBRE").service"; fi
  mkdir -p "$PUNTO"
  cat > "/etc/systemd/system/$U" <<UNIT
[Unit]
Description=rclone $REMOTO en $PUNTO
After=network-online.target
Wants=network-online.target
Before=docker.service

[Service]
Type=notify
ExecStart=$RCLONE mount "$REMOTO" "$PUNTO" --config "$CONF" \\
  --allow-other --allow-non-empty --uid 1000 --gid 1000 --umask 002 \\
  --vfs-cache-mode full --cache-dir "/CacheVOD/$NOMBRE" \\
  --vfs-cache-max-size 10G --vfs-cache-max-age 12h --vfs-cache-min-free-space 40G \\
  --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 512M --buffer-size 32M \\
  --dir-cache-time 5m --attr-timeout 1m \\
  --log-file "/var/log/rclone/$NOMBRE.log" --log-level NOTICE
ExecStop=/bin/fusermount3 -uz "$PUNTO"
Restart=on-failure
RestartSec=15
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
UNIT
  UNIDADES+=("$U")
done
systemctl daemon-reload
for U in "${UNIDADES[@]}"; do systemctl enable -q "$U"; systemctl restart --no-block "$U"; done
sleep 20
MAL=0
for linea in "${MONTAJES[@]}"; do
  PUNTO=${linea#*$'\t'}
  if grep -q " $PUNTO fuse" /proc/mounts && timeout 20 ls "$PUNTO" >/dev/null 2>&1; then echo "   ✓ $PUNTO"
  else echo "   ✗ $PUNTO  (mira: tail /var/log/rclone/$(basename "$PUNTO").log)"; MAL=1; fi
done

echo "== 4/4 Emby"
emby_ok() { for _ in $(seq 1 "$1"); do curl -fs -m 5 -o /dev/null http://127.0.0.1:8096/emby/System/Info/Public && return 0; sleep 3; done; return 1; }
(cd /opt/emby && timeout 90 docker compose up -d >/dev/null 2>&1) || true
if ! emby_ok 30; then
  echo "   Emby sigue colgado: reinicio Docker (el panel se corta unos segundos)"
  systemctl restart docker
  (cd /opt/emby && docker compose up -d >/dev/null)
fi
emby_ok 40 && echo "   ✓ Emby en marcha" || { echo "   ✗ Emby no responde: cd /opt/emby && docker compose logs --tail 50"; MAL=1; }
echo
[[ $MAL == 0 ]] && echo "LISTO." || echo "Hay algo con ✗: mándalo."
echo "Ver un montaje: systemctl status rclone-mnt-<carpeta> · Reiniciarlos todos: systemctl restart 'rclone-mnt-*'"
