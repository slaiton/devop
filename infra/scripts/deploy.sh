#!/usr/bin/env bash
# deploy.sh — despliega o actualiza DevSentinel AI en el servidor de producción
#
# Requisitos:
#   - Docker y Docker Compose instalados en el host
#   - Variables de entorno definidas (ver .env.example) o en un archivo .env.prod
#   - docker-compose.prod.yml en el directorio raíz del proyecto
#
# Uso:
#   ./infra/scripts/deploy.sh              # build local + up
#   ./infra/scripts/deploy.sh --no-build  # solo pull de imágenes pre-construidas

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
BUILD=true

for arg in "$@"; do
  case $arg in
    --no-build) BUILD=false ;;
  esac
done

echo "─────────────────────────────────────────"
echo "  DevSentinel AI — despliegue a producción"
echo "─────────────────────────────────────────"

# Verificar que las variables críticas estén definidas
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
  echo "Definelas en el entorno o copia .env.example → .env.prod y cárgalo con:"
  echo "  set -a && source .env.prod && set +a"
  exit 1
fi

# Construir imágenes (si no se pasó --no-build)
if [[ "$BUILD" == true ]]; then
  echo ""
  echo "[1/4] Construyendo imágenes..."
  $COMPOSE build --parallel
else
  echo ""
  echo "[1/4] Descargando imágenes pre-construidas..."
  $COMPOSE pull web api worker
fi

# Bajar imágenes de infraestructura
echo ""
echo "[2/4] Actualizando imágenes de postgres/redis/caddy..."
$COMPOSE pull postgres redis caddy

# Rolling restart: primero el API (ejecuta migraciones), luego worker, luego web
echo ""
echo "[3/4] Iniciando servicios..."
$COMPOSE up -d --remove-orphans postgres redis
echo "  → Esperando a postgres y redis..."
$COMPOSE wait postgres redis 2>/dev/null || sleep 15

$COMPOSE up -d api
echo "  → Esperando al API (puede tardar ~60s mientras corre migraciones)..."
for i in $(seq 1 24); do
  if $COMPOSE exec -T api wget -qO- http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "  → API lista."
    break
  fi
  sleep 5
done

$COMPOSE up -d worker
$COMPOSE up -d web caddy

# Limpiar imágenes viejas
echo ""
echo "[4/4] Limpiando imágenes obsoletas..."
docker image prune -f

echo ""
echo "✓ Despliegue completo."
$COMPOSE ps
