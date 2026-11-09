#!/usr/bin/env bash
# Pone la última versión de cuentas-api si hay cambios en GitHub (cron, cada 5 minutos).
#   actualizar.sh --forzar → reconstruye de todas formas
set -euo pipefail
main() {
  DIR=/opt/morvehtv-cuentas
  APP=$DIR/cuentas-api
  exec 9>/run/morvehtv-cuentas.lock
  flock -n 9 || exit 0
  cd "$DIR"
  git fetch -q --depth 1 origin main
  if [[ "${1:-}" != "--forzar" && "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]; then exit 0; fi
  # Solo se reconstruye si ha cambiado algo de cuentas-api
  CAMBIA=$(git diff --name-only HEAD origin/main -- cuentas-api | wc -l)
  git reset -q --hard origin/main
  chmod +x "$APP"/*.sh
  [[ "${1:-}" == "--forzar" || $CAMBIA -gt 0 ]] || exit 0
  echo "$(date -Is) actualizando a $(git rev-parse --short HEAD)"
  docker compose -f "$APP/docker-compose.yml" build -q
  docker compose -f "$APP/docker-compose.yml" up -d
  docker image prune -f >/dev/null
  for _ in $(seq 1 20); do
    if curl -fsS -o /dev/null http://127.0.0.1:10100/api/salud; then echo "$(date -Is) en línea"; exit 0; fi
    sleep 3
  done
  echo "$(date -Is) AVISO: no responde. Mira: docker logs --tail 50 morvehtv-cuentas"
  exit 1
}
main "$@"
