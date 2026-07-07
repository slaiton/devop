.PHONY: dev dev-build prod prod-build logs logs-api logs-worker ps down down-prod backup deploy

COMPOSE_DEV  = docker compose -f docker-compose.yml
COMPOSE_PROD = docker compose -f docker-compose.prod.yml

# ─── Desarrollo local ──────────────────────────────────────────────────────────

dev:
	$(COMPOSE_DEV) up -d

dev-build:
	$(COMPOSE_DEV) up -d --build

logs:
	$(COMPOSE_DEV) logs -f --tail=100

logs-api:
	$(COMPOSE_DEV) logs -f --tail=100 api

logs-worker:
	$(COMPOSE_DEV) logs -f --tail=100 worker

ps:
	$(COMPOSE_DEV) ps

down:
	$(COMPOSE_DEV) down

# ─── Producción ────────────────────────────────────────────────────────────────

prod:
	$(COMPOSE_PROD) up -d --build

prod-build:
	$(COMPOSE_PROD) build --parallel

prod-logs:
	$(COMPOSE_PROD) logs -f --tail=100

prod-ps:
	$(COMPOSE_PROD) ps

down-prod:
	$(COMPOSE_PROD) down

# ─── Operaciones ───────────────────────────────────────────────────────────────

backup:
	bash infra/scripts/backup.sh

deploy:
	bash infra/scripts/deploy.sh

deploy-no-build:
	bash infra/scripts/deploy.sh --no-build

# Restaurar un backup: make restore FILE=backups/devsentinel_2025-01-01_03-00-00.dump
restore:
	@test -n "$(FILE)" || (echo "ERROR: Especifica FILE=<ruta al .dump>"; exit 1)
	$(COMPOSE_PROD) exec -T postgres \
	  pg_restore -U devsentinel -d devsentinel --clean --if-exists < $(FILE)
	@echo "Restauración completada desde $(FILE)"
