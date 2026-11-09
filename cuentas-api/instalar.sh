#!/usr/bin/env bash
# Instala (o repara) MorvehTV Cuentas en la VPS. Se lanza como root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/instalar.sh)
# Solo descarga la carpeta cuentas-api del repositorio (nada de la web antigua).
set -euo pipefail
REPO=https://github.com/saitamaeditor/morvehtv-visor.git
DIR=/opt/morvehtv-cuentas
APP=$DIR/cuentas-api
ENV=/etc/morvehtv-cuentas/cuentas.env
DATOS=/var/lib/morvehtv-cuentas
DOMINIO=panel.morvehtv.com
CADDY=/etc/caddy/Caddyfile
REPO_WEB=https://github.com/saitamaeditor/morvehtv-gestor.git
WEB=/opt/morvehtv-cuentas-web

[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }
command -v docker >/dev/null || { echo "Falta Docker"; exit 1; }

echo "== 1/6 Código (solo cuentas-api)"
if [[ ! -d $DIR/.git ]]; then
  git clone -q --filter=blob:none --no-checkout --depth 1 "$REPO" "$DIR"
  git -C "$DIR" sparse-checkout set --no-cone /cuentas-api/
  git -C "$DIR" checkout -q main
else
  git -C "$DIR" fetch -q --depth 1 origin main && git -C "$DIR" reset -q --hard origin/main
fi
chmod +x "$APP"/*.sh

echo "== 2/6 Clave de Emby"
install -d -m 700 /etc/morvehtv-cuentas
if ! grep -qs '^EMBY_API_KEY=.\+' "$ENV"; then
  echo "Pega la clave de API de Emby (Panel de Emby → Avanzado → Claves de API). No se verá al pegarla:"
  read -rs CLAVE </dev/tty; echo
  [[ $CLAVE =~ ^[A-Za-z0-9]{16,64}$ ]] || { echo "Esa clave no parece válida. Vuelve a lanzar el instalador."; exit 1; }
  umask 077
  printf 'EMBY_URL=http://127.0.0.1:8096\nEMBY_API_KEY=%s\nEMBY_PUBLICA=https://emby.morvehtv.com\n' "$CLAVE" > "$ENV"
  unset CLAVE
fi
chmod 600 "$ENV"

echo "== 3/6 Datos"
install -d -m 700 -o 1000 -g 1000 "$DATOS"
if [[ ! -f $DATOS/datos.json && -r /mnt/e2/_morvehtv/usuarios.json ]]; then
  # Solo se copia para sacar lo de Emby y revendedores; el servidor lo borra al importarlo
  install -m 600 -o 1000 -g 1000 /mnt/e2/_morvehtv/usuarios.json "$DATOS/importar.json"
  echo "   Se importarán las cuentas de Emby y los revendedores que había"
fi

echo "== 4/6 Servidor"
docker compose -f "$APP/docker-compose.yml" up -d --build --quiet-pull >/dev/null
for _ in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:10100/api/salud && break; sleep 2; done
curl -fsS http://127.0.0.1:10100/api/salud >/dev/null || { echo "No arranca. Mira: docker logs --tail 50 morvehtv-cuentas"; exit 1; }
docker logs morvehtv-cuentas 2>&1 | tail -n 3 | sed 's/^/   /'

echo "== 5/6 Panel en https://$DOMINIO, Caddy y actualizaciones"
# La web del panel (los archivos de morvehtv-gestor) se sirve desde la propia VPS
if [[ ! -d $WEB/.git ]]; then git clone -q --depth 1 "$REPO_WEB" "$WEB"
else git -C "$WEB" fetch -q --depth 1 origin main && git -C "$WEB" reset -q --hard origin/main; fi
# El bloque de $DOMINIO se reescribe siempre (así se arreglan instalaciones anteriores)
cp "$CADDY" /tmp/Caddyfile.prev
awk -v d="$DOMINIO {" '$0==d{s=1} !s{print} s&&/^}/{s=0}' /tmp/Caddyfile.prev > "$CADDY"
cat >> "$CADDY" <<CADDY

$DOMINIO {
	tls /etc/caddy/cf-origen.pem /etc/caddy/cf-origen.key
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:10100
	}
	handle {
		root * $WEB
		@ocultos path /.git* /README.md /publicar.sh /version.txt
		respond @ocultos 404
		@pagina path / /index.html
		header @pagina Cache-Control no-cache
		file_server
	}
}
CADDY
if caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1; then systemctl reload caddy; rm -f /tmp/Caddyfile.prev
else cp /tmp/Caddyfile.prev "$CADDY"; echo "ERROR en Caddy: dejado como estaba"; exit 1; fi
cat > /etc/cron.d/morvehtv-cuentas <<CRON
*/5 * * * * root $APP/actualizar.sh >> /var/log/morvehtv-cuentas.log 2>&1
CRON
cat > /etc/logrotate.d/morvehtv-cuentas <<'ROT'
/var/log/morvehtv-cuentas.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
}
ROT

echo "== 6/6 Cuenta de administrador"
if docker exec morvehtv-cuentas node admin.mjs lista | grep -q '^(ningún'; then
  read -rp "Usuario para entrar al panel (3-20: letras, números, . _ -): " U </dev/tty
  docker exec -it morvehtv-cuentas node admin.mjs crear "$U" </dev/tty
else
  echo "   Ya hay administradores: $(docker exec morvehtv-cuentas node admin.mjs lista | paste -sd, -)"
fi

echo
echo "LISTO. Panel: https://$DOMINIO"
echo "(Si es la primera vez: en Cloudflare → DNS, registro A «panel» → 94.143.140.93, nube naranja.)"
