#!/usr/bin/env bash
# backup.sh — copia de seguridad de PostgreSQL para DevSentinel AI
#
# Genera un dump comprimido en ./backups/YYYY-MM-DD_HH-MM-SS.dump
# Retiene los últimos 7 backups (elimina los más antiguos).
#
# Uso manual:  ./infra/scripts/backup.sh
# Cron diario: 0 3 * * * /opt/devsentinel/infra/scripts/backup.sh >> /var/log/devsentinel-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="$(cd "$(dirname "$0")/../.." && pwd)/backups"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
FILENAME="devsentinel_${TIMESTAMP}.dump"
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

echo "[backup] $(date) — iniciando backup de PostgreSQL..."

# pg_dump en formato custom (-Fc) dentro del contenedor postgres
docker compose -f "$(cd "$(dirname "$0")/../.." && pwd)/docker-compose.prod.yml" \
  exec -T postgres \
  pg_dump -U devsentinel -Fc devsentinel > "${BACKUP_DIR}/${FILENAME}"

SIZE=$(du -sh "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "[backup] Guardado: ${BACKUP_DIR}/${FILENAME} (${SIZE})"

# Eliminar backups más antiguos que RETENTION_DAYS días
find "$BACKUP_DIR" -name "devsentinel_*.dump" -mtime +${RETENTION_DAYS} -delete
echo "[backup] Backups retenidos (últimos ${RETENTION_DAYS} días):"
ls -lh "$BACKUP_DIR"/*.dump 2>/dev/null || echo "  (ninguno)"

echo "[backup] $(date) — finalizado."
