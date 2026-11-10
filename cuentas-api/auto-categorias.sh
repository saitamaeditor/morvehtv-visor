#!/usr/bin/env bash
# Categorías automáticas: cada carpeta nueva que aparezca en el remoto de rclone (junto a las que ya
# están montadas) se monta sola en /mnt y se crea su biblioteca en Emby (y con ella su tema en Telegram,
# que avisa de todo lo que trae). Como root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/auto-categorias.sh)
# Se instala en /usr/local/sbin/morvehtv-categorias, hace una pasada YA y luego una cada 5 minutos.
#   morvehtv-categorias ver   → solo dice lo que haría, sin tocar nada
#   journalctl -u morvehtv-categorias -n 50   → lo que ha ido haciendo
# Qué hace en cada pasada:
#  1. Mira los montajes rclone-mnt-*.service (los de rclone-servicios.sh): sus carpetas padre en el remoto
#     (p. ej. MorvehTV1:CASTELLANO) y el sufijo que llevan en /mnt (las de MorvehTV2 acaban en «2»).
#  2. Lista esas carpetas padre: lo que no esté montado se monta igual que las demás.
#  3. Todo montaje de /mnt que no esté en ninguna biblioteca de Emby: si su «gemela» del otro remoto ya
#     comparte biblioteca con otra carpeta, se añade a esa; si no, biblioteca nueva con el nombre de la
#     carpeta, del tipo que toque (SER/PROGRAMAS/TV → series; lo demás → películas) y con las mismas
#     opciones (idioma, imágenes…) que otra biblioteca de ese tipo.
set -euo pipefail
DESTINO=/usr/local/sbin/morvehtv-categorias
URL=https://raw.githubusercontent.com/saitamaeditor/morvehtv-visor/main/cuentas-api/auto-categorias.sh
ENV=/etc/morvehtv-cuentas/cuentas.env
EMBY=http://127.0.0.1:8096
[[ $EUID -eq 0 ]] || { echo "Lánzalo como root"; exit 1; }

# ---------- Instalación (al lanzarlo desde curl o sin argumentos fuera de /usr/local/sbin) ----------
if [[ ${1:-} != ciclo && ${1:-} != ver && $(readlink -f "$0") != "$DESTINO" ]]; then
  command -v jq >/dev/null || apt-get install -y -qq jq >/dev/null
  # (se descarga otra vez: con «bash <(curl …)» el propio script no se puede volver a leer)
  curl -fsSL "$URL" -o "$DESTINO.nuevo" && mv -f "$DESTINO.nuevo" "$DESTINO"; chmod 755 "$DESTINO"
  cat > /etc/systemd/system/morvehtv-categorias.service <<UNIT
[Unit]
Description=MorvehTV: montar carpetas nuevas y crear sus bibliotecas en Emby
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=$DESTINO ciclo
TimeoutStartSec=900
UNIT
  cat > /etc/systemd/system/morvehtv-categorias.timer <<'UNIT'
[Unit]
Description=MorvehTV: buscar categorías nuevas cada 5 minutos

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable -q --now morvehtv-categorias.timer
  echo "== Instalado: buscará categorías nuevas cada 5 minutos. Primera pasada ahora:"
  exec "$DESTINO" ciclo
fi

MODO=${1:-ciclo}
exec 9>/run/morvehtv-categorias.lock
flock -n 9 || { echo "Ya hay otra pasada en marcha"; exit 0; }
RCLONE=$(command -v rclone) || { echo "Falta rclone"; exit 1; }
CONF=$("$RCLONE" config file | tail -n1)
CLAVE=$(grep -s '^EMBY_API_KEY=' "$ENV" | cut -d= -f2- || true)
[[ -n $CLAVE ]] || { echo "No encuentro la clave de Emby en $ENV (¿está el panel instalado?)"; exit 1; }
emby() { local m=$1 r=$2; shift 2; curl -fsS -m 60 -X "$m" -H "X-Emby-Token: $CLAVE" -H 'Content-Type: application/json' "$EMBY/emby$r" "$@"; }
urlq() { jq -rn --arg v "$1" '$v|@uri'; }

# ---------- 1. Montajes que ya hay ----------
declare -A REMOTOS=() PUNTOS=() SUFIJO=()
for u in /etc/systemd/system/rclone-mnt-*.service; do
  [[ -e $u ]] || continue
  IFS=$'\t' read -r REM PT < <(awk -F'"' '/^ExecStart=/ {print $2 "\t" $4; exit}' "$u")
  [[ -n ${REM:-} && -n ${PT:-} ]] || continue
  REMOTOS[$REM]=1; PUNTOS[$PT]=1
  PADRE=${REM%/*}; [[ $PADRE == "$REM" ]] && PADRE=${REM%%:*}:
  BASE=${REM##*/}; BASE=${BASE##*:}; PB=$(basename "$PT")
  [[ $PB == "$BASE"* ]] && SUFIJO[$PADRE]=${PB#"$BASE"}
done
(( ${#REMOTOS[@]} )) || { echo "No hay montajes rclone-mnt-*.service: lanza antes rclone-servicios.sh"; exit 1; }

# ---------- 2. Carpetas nuevas en el remoto → montaje ----------
NUEVOS=()
for PADRE in "${!SUFIJO[@]}"; do
  if ! LISTA=$(timeout 120 "$RCLONE" lsf --dirs-only --config "$CONF" "$PADRE" 2>/dev/null); then
    echo "   ✗ no se pudo listar $PADRE"; continue
  fi
  while IFS= read -r D; do
    D=${D%/}; [[ -n $D ]] || continue
    case $PADRE in *:) REM="$PADRE$D" ;; *) REM="$PADRE/$D" ;; esac
    [[ -n ${REMOTOS[$REM]:-} ]] && continue
    [[ $D =~ ^[[:alnum:]][[:alnum:]\ ._()+\&-]*$ ]] || { echo "   · «$D» tiene caracteres raros: no lo monto"; continue; }
    PT="/mnt/$D${SUFIJO[$PADRE]}"
    if [[ -n ${PUNTOS[$PT]:-} ]]; then echo "   · $REM: $PT ya lo usa otro montaje"; continue; fi
    NOMBRE=$(basename "$PT")
    if [[ $NOMBRE =~ ^[A-Za-z0-9._-]+$ ]]; then U="rclone-mnt-$NOMBRE.service"; else U="rclone-mnt-$(systemd-escape "$NOMBRE").service"; fi
    echo "== Carpeta nueva: $REM → $PT"
    REMOTOS[$REM]=1; PUNTOS[$PT]=1
    [[ $MODO == ver ]] && { echo "   (haría) montarla con $U"; continue; }
    mkdir -p "$PT" /var/log/rclone
    cat > "/etc/systemd/system/$U" <<UNIT
[Unit]
Description=rclone $REM en $PT
After=network-online.target
Wants=network-online.target
Before=docker.service

[Service]
Type=notify
ExecStart=$RCLONE mount "$REM" "$PT" --config "$CONF" \\
  --allow-other --allow-non-empty --uid 1000 --gid 1000 --umask 002 \\
  --vfs-cache-mode full --cache-dir "/CacheVOD/$NOMBRE" \\
  --vfs-cache-max-size 10G --vfs-cache-max-age 12h --vfs-cache-min-free-space 40G \\
  --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 512M --buffer-size 32M \\
  --dir-cache-time 5m --attr-timeout 1m \\
  --log-file "/var/log/rclone/$NOMBRE.log" --log-level NOTICE
ExecStop=/bin/fusermount3 -uz "$PT"
Restart=on-failure
RestartSec=15
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable -q "$U"
    if systemctl start "$U" && timeout 20 ls "$PT" >/dev/null 2>&1; then echo "   ✓ montada"; NUEVOS+=("$PT")
    else echo "   ✗ no se montó: tail /var/log/rclone/$NOMBRE.log"; fi
  done <<<"$LISTA"
done
# Emby ve /mnt con «rslave»: los montajes nuevos le llegan solos, sin reiniciarlo

# ---------- 3. Montajes sin biblioteca en Emby → biblioteca ----------
LIBS=$(emby GET /Library/VirtualFolders) || { echo "   ✗ Emby no responde"; exit 1; }
declare -A HECHO=()
# Un montaje ya está en Emby si una biblioteca usa esa carpeta O ALGUNA SUBCARPETA suya
# (p. ej. «01.Peliculas FHD» usa /mnt/03.PEL-FHD/03.PEL-FHD [0-B], [C-D]…)
mapfile -t EN_EMBY < <(jq -r '.[].Locations[]?' <<<"$LIBS")
for PT in "${!PUNTOS[@]}"; do
  for P in "${EN_EMBY[@]}"; do [[ $P == "$PT" || $P == "$PT"/* ]] && { HECHO[$PT]=1; break; }; done
done
tipo_de() { if [[ ${1^^} =~ (^|[^A-Z])(SER|SERIES|PROGRAMAS|TV|REALITIES|REALITY|ANIME-SER)([^A-Z]|$) ]]; then echo tvshows; else echo movies; fi; }
# Gemelas: la misma carpeta en el otro remoto (con o sin el sufijo, p. ej. 00.PEL-4K y 00.PEL-4K2)
gemelas() {
  local n g gb s; n=$(basename "$1")
  for g in "${!PUNTOS[@]}"; do
    [[ $g != "$1" ]] || continue; gb=$(basename "$g")
    for s in "${SUFIJO[@]}"; do [[ -n $s && ( $n == "$gb$s" || $gb == "$n$s" ) ]] && { echo "$g"; break; }; done
  done
}
# Si ya hay bibliotecas con más de una carpeta (las gemelas juntas), las nuevas también van juntas
JUNTAR=$(jq -r '[.[] | select((.Locations | length) > 1)] | length' <<<"$LIBS")
mapfile -t TODOS < <(printf '%s\n' "${!PUNTOS[@]}" | sort)
for PT in "${TODOS[@]}"; do
  [[ -z ${HECHO[$PT]:-} ]] || continue
  NOMBRE=$(basename "$PT")
  mapfile -t GEM < <(gemelas "$PT")
  # ¿Alguna gemela ya está en una biblioteca con varias carpetas? → a esa
  DESTLIB=""
  for G in "${GEM[@]}"; do
    L=$(jq -r --arg g "$G" '[.[] | select((.Locations // []) | index($g)) | select((.Locations | length) > 1)][0].Name // empty' <<<"$LIBS")
    [[ -n $L ]] && { DESTLIB=$L; break; }
  done
  if [[ -n $DESTLIB ]]; then
    echo "== $PT → se añade a la biblioteca «$DESTLIB» (donde está su gemela)"
    HECHO[$PT]=1
    CUERPO=$(jq -cn --arg n "$DESTLIB" --arg p "$PT" '{Name: $n, PathInfo: {Path: $p}}')
    if [[ $MODO == ver ]]; then echo "   (haría) añadirla"
    elif emby POST "/Library/VirtualFolders/Paths?refreshLibrary=true" -d "$CUERPO" -o /dev/null; then echo "   ✓ añadida"
    else echo "   ✗ Emby no la aceptó"; fi
    continue
  fi
  CARPETAS=("$PT")
  if (( JUNTAR > 0 )); then for G in "${GEM[@]}"; do [[ -z ${HECHO[$G]:-} ]] && CARPETAS+=("$G"); done; fi
  for C in "${CARPETAS[@]}"; do HECHO[$C]=1; done
  TIPO=$(tipo_de "$NOMBRE")
  echo "== Biblioteca nueva «$NOMBRE» ($([[ $TIPO == tvshows ]] && echo series || echo películas)): ${CARPETAS[*]}"
  # Mismas opciones que otra biblioteca del mismo tipo (idioma, país, imágenes, descargadores…)
  OPC=$(jq -c --arg t "$TIPO" '[.[] | select(.CollectionType == $t) | .LibraryOptions][0] // {}' <<<"$LIBS")
  CUERPO=$(printf '%s\n' "${CARPETAS[@]}" | jq -cRn --argjson o "$OPC" '{LibraryOptions: ($o + {PathInfos: [inputs | {Path: .}]})}')
  RUTAS=$(IFS=,; echo "${CARPETAS[*]}")
  if [[ $MODO == ver ]]; then echo "   (haría) crearla"
  elif emby POST "/Library/VirtualFolders?name=$(urlq "$NOMBRE")&collectionType=$TIPO&paths=$(urlq "$RUTAS")&refreshLibrary=true" -d "$CUERPO" -o /dev/null; then
    echo "   ✓ creada (Emby la está escaneando; Telegram creará su tema y avisará de lo que trae)"
  else echo "   ✗ Emby no la aceptó"; fi
done
[[ $MODO == ver ]] && echo "(modo ver: no se ha tocado nada)"
exit 0
