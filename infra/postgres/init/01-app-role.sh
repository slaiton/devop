#!/bin/sh
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE devsentinel_app LOGIN PASSWORD '$APP_DB_PASSWORD';
EOSQL
