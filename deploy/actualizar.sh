#!/usr/bin/env bash
# Pone en marcha la última versión de GitHub si hay cambios (lo llama cron cada 2 minutos).
#   actualizar.sh            → solo si hay commits nuevos
#   actualizar.sh --forzar   → reconstruye y reinicia de todas formas
set -euo pipefail
# Todo dentro de una función: así bash lo lee entero antes de que git cambie este archivo
main() {
  DIR=/opt/morvehtv-visor
  cd "$DIR"

  # Una sola actualización a la vez
  exec 9>/run/morvehtv-actualizar.lock
  flock -n 9 || exit 0

  git fetch -q origin main
  if [[ "${1:-}" != "--forzar" && "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]; then
    exit 0
  fi

  echo "$(date -Is) actualizando a $(git rev-parse --short origin/main)"
  git reset -q --hard origin/main
  chmod +x deploy/*.sh
  # Primero se construye (la web sigue funcionando) y luego se cambia: solo unos segundos sin servicio
  docker compose -f deploy/docker-compose.yml build -q
  docker compose -f deploy/docker-compose.yml up -d
  docker image prune -f >/dev/null

  # Espera a que responda
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:10000/api/salud; then
      echo "$(date -Is) en línea"; exit 0
    fi
    sleep 3
  done
  echo "$(date -Is) AVISO: no responde. Mira: docker logs --tail 50 morvehtv-visor"
  exit 1
}
main "$@"
