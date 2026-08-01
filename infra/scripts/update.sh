#!/usr/bin/env bash
# update.sh — actualiza DevSentinel AI en producción: git pull + rebuild + rolling restart.
#
# Uso (desde /var/www/html/devop en el servidor):
#   ./infra/scripts/update.sh              # rama actual
#   ./infra/scripts/update.sh main         # fuerza una rama concreta
#
# Requiere que las variables de entorno (ver .env.example) ya estén cargadas
# en el shell, p. ej.:
#   set -a && source .env && set +a && ./infra/scripts/update.sh

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

echo "─────────────────────────────────────────"
echo "  DevSentinel AI — actualización a producción (rama: ${BRANCH})"
echo "─────────────────────────────────────────"

# Variables críticas — mismas que exige deploy.sh
REQUIRED_VARS=(
  POSTGRES_PASSWORD APP_DB_PASSWORD DATABASE_URL MIGRATIONS_DATABASE_URL
  JWT_SECRET GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_APP_WEBHOOK_SECRET
  GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET GITHUB_OAUTH_CALLBACK_URL
  GITHUB_APP_SLUG PUBLIC_DOMAIN PUBLIC_WEB_ORIGIN LLM_PROVIDER_API_KEY
)
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: Faltan variables de entorno:"
  printf '  - %s\n' "${MISSING[@]}"
  echo "Cárgalas con: set -a && source .env && set +a"
  exit 1
fi

# No pisar cambios locales sin querer
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: hay cambios locales sin commitear en el checkout de producción."
  echo "Revísalos (git status) antes de continuar — este script no descarta nada por ti."
  exit 1
fi

echo ""
echo "[1/5] git pull origin ${BRANCH}..."
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

REV="$(git rev-parse --short HEAD)"
echo "  → ahora en commit ${REV}"

echo ""
echo "[2/5] Construyendo imágenes (web, api, worker)..."
$COMPOSE build --parallel web api worker

echo ""
echo "[3/5] Actualizando postgres/redis primero (por si hay migraciones nuevas)..."
$COMPOSE up -d --remove-orphans postgres redis
$COMPOSE wait postgres redis 2>/dev/null || sleep 10

echo ""
echo "[4/5] Rolling restart: api (corre migraciones al iniciar) → worker → web..."
$COMPOSE up -d api
echo "  → esperando a que /api/health responda..."
for i in $(seq 1 24); do
  if $COMPOSE exec -T api wget -qO- http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "  → API lista."
    break
  fi
  sleep 5
done

$COMPOSE up -d worker web

echo ""
echo "[5/5] Limpiando imágenes obsoletas..."
docker image prune -f

echo ""
echo "✓ Actualización completa — commit ${REV} en producción."
$COMPOSE ps
