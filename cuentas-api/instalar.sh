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
DOMINIO_APP=morvehtv.com
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

echo "== 2/6 Claves (Emby, Telegram y e2)"
install -d -m 700 /etc/morvehtv-cuentas
if ! grep -qs '^EMBY_API_KEY=.\+' "$ENV"; then
  echo "Pega la clave de API de Emby (Panel de Emby → Avanzado → Claves de API). No se verá al pegarla:"
  read -rs CLAVE </dev/tty; echo
  [[ $CLAVE =~ ^[A-Za-z0-9]{16,64}$ ]] || { echo "Esa clave no parece válida. Vuelve a lanzar el instalador."; exit 1; }
  umask 077
  printf 'EMBY_URL=http://127.0.0.1:8096\nEMBY_API_KEY=%s\nEMBY_PUBLICA=https://emby.morvehtv.com\n' "$CLAVE" > "$ENV"
  unset CLAVE
fi
# Telegram (opcional): avisos de lo nuevo de Emby en el grupo. Se pregunta una sola vez; para
# ponerlo después: sed -i '/^TELEGRAM_TOKEN=/d' $ENV y volver a lanzar el instalador.
if ! grep -qs '^TELEGRAM_TOKEN=' "$ENV"; then
  echo "Token del bot de Telegram para avisar de lo nuevo (@BotFather → /mybots → API Token)."
  echo "Pulsa Enter sin escribir nada para no activarlo. No se verá al pegarlo:"
  read -rs TG </dev/tty; echo
  if [[ -n $TG && ! $TG =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]]; then echo "Ese token no parece válido: Telegram queda sin activar."; TG=; fi
  printf 'TELEGRAM_TOKEN=%s\n' "$TG" >> "$ENV"
  unset TG
fi
# TMDB (opcional): lista de temporadas y episodios en «Subir» con títulos en español. Sin ella se
# usa TVmaze, que tiene poco contenido español. Para ponerla después: sed -i '/^TMDB_API_KEY=/d' $ENV
# y volver a lanzar el instalador.
if ! grep -qs '^TMDB_API_KEY=' "$ENV"; then
  echo "Clave de la API de TMDB para la lista de episodios (themoviedb.org → Ajustes → API: la «Clave de API»"
  echo "o el «Token de acceso de lectura»). Pulsa Enter sin escribir nada para no ponerla. No se verá al pegarla:"
  read -rs TK </dev/tty; echo
  if [[ -n $TK && ! $TK =~ ^[A-Za-z0-9._-]{32,400}$ ]]; then echo "Esa clave no parece válida: se queda sin TMDB."; TK=; fi
  printf 'TMDB_API_KEY=%s\n' "$TK" >> "$ENV"
  unset TK
fi
# e2 (para «Subir» en el panel, solo administradores): las claves se copian del montaje de rclone
# de esta VPS (el mismo bucket que ve Emby). Se vuelven a copiar cada vez: si cambias las claves en
# rclone, basta con relanzar el instalador.
MONTAJE=$(ps -eo args | awk '$1 ~ /rclone$/ && $2 == "mount" {print $3; exit}')
REMOTO=${MONTAJE%%:*}; REMOTO=${REMOTO:-e2}
BUCKET_E2=${MONTAJE#*:}; BUCKET_E2=${BUCKET_E2%%/*}; [[ -n $MONTAJE ]] || BUCKET_E2=morvehtv
if command -v rclone >/dev/null && RC=$(rclone config show "$REMOTO" 2>/dev/null) && [[ -n $RC ]]; then
  val() { awk -F' = ' -v k="$1" '$1 == k {print $2; exit}' <<<"$RC"; }
  E2K=$(val access_key_id); E2S=$(val secret_access_key); E2E=$(val endpoint); E2R=$(val region)
  if [[ -n $E2K && -n $E2S && -n $E2E && -n $BUCKET_E2 ]]; then
    sed -i '/^E2_/d' "$ENV"
    printf 'E2_ENDPOINT=%s\nE2_REGION=%s\nE2_BUCKET=%s\nE2_ACCESS_KEY_ID=%s\nE2_SECRET_ACCESS_KEY=%s\n' "$E2E" "$E2R" "$BUCKET_E2" "$E2K" "$E2S" >> "$ENV"
    echo "   Subida a e2 activada (bucket $BUCKET_E2, claves del montaje de rclone)"
  else
    echo "   AVISO: no encuentro las claves de e2 en rclone («$REMOTO»): la subida desde el panel queda desactivada"
  fi
  unset RC E2K E2S
else
  echo "   AVISO: no encuentro el remoto «$REMOTO» de rclone: la subida desde el panel queda desactivada"
fi
chmod 600 "$ENV"

echo "== 3/6 Datos"
install -d -m 700 -o 1000 -g 1000 "$DATOS"
if [[ -r /mnt/e2/_morvehtv/usuarios.json ]] && { [[ ! -f $DATOS/datos.json ]] || ! grep -q '"telegram"' "$DATOS/datos.json"; }; then
  # Solo se copia para sacar lo de Emby, revendedores y el grupo de Telegram (lo que aún no esté);
  # el servidor lo borra al importarlo
  install -m 600 -o 1000 -g 1000 /mnt/e2/_morvehtv/usuarios.json "$DATOS/importar.json"
  echo "   Se importará lo que había de Emby, revendedores y Telegram"
fi

echo "== 4/6 Servidor"
docker compose -f "$APP/docker-compose.yml" up -d --build --quiet-pull >/dev/null
for _ in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:10100/api/salud && break; sleep 2; done
curl -fsS http://127.0.0.1:10100/api/salud >/dev/null || { echo "No arranca. Mira: docker logs --tail 50 morvehtv-cuentas"; exit 1; }
docker logs morvehtv-cuentas 2>&1 | tail -n 4 | sed 's/^/   /'

echo "== 5/6 Panel en https://$DOMINIO, Caddy y actualizaciones"
# La web del panel (los archivos de morvehtv-gestor) se sirve desde la propia VPS
if [[ ! -d $WEB/.git ]]; then git clone -q --depth 1 "$REPO_WEB" "$WEB"
else git -C "$WEB" fetch -q --depth 1 origin main && git -C "$WEB" reset -q --hard origin/main; fi
# Los bloques de $DOMINIO y de $DOMINIO_APP se reescriben siempre (así se arreglan instalaciones anteriores)
cp "$CADDY" /tmp/Caddyfile.prev
awk -v d="$DOMINIO {" -v a="$DOMINIO_APP, www.$DOMINIO_APP {" '$0==d||$0==a{s=1} !s{print} s&&/^}/{s=0}' /tmp/Caddyfile.prev > "$CADDY"
# La app MorvehTV (interfaz propia sobre Emby) en https://$DOMINIO_APP: los archivos de cuentas-api/app
# y la API de Emby en /emby/… (mismo dominio: sin problemas de CORS, y Emby ya entiende ese prefijo)
cat >> "$CADDY" <<CADDY

$DOMINIO_APP, www.$DOMINIO_APP {
	tls /etc/caddy/cf-origen.pem /etc/caddy/cf-origen.key
	@www host www.$DOMINIO_APP
	redir @www https://$DOMINIO_APP{uri} 308
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	handle /emby/* {
		reverse_proxy 127.0.0.1:8096
	}
	handle {
		root * $APP/app
		header Cache-Control no-cache
		file_server
	}
}
CADDY
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
echo "LISTO. Panel: https://$DOMINIO · App: https://$DOMINIO_APP"
echo "(Si es la primera vez: en Cloudflare → DNS, registro A «panel» → 94.143.140.93, nube naranja.)"
