#!/bin/sh
# Mirrors RDS: the schema owner is NOT a superuser (it has CREATEROLE, like the RDS
# master user), so Core API migrations and RLS behave locally exactly as on AWS.
#
# Runs as the container superuser on first start with an empty volume
# (docker-entrypoint-initdb.d). CI runs the same script against its Postgres service.
#
# Env: POSTGRES_USER (superuser), APP_DB_OWNER, APP_DB_OWNER_PASSWORD, APP_DB, APP_TEST_DB
set -e

OWNER="${APP_DB_OWNER:-calling_agent}"
OWNER_PASSWORD="${APP_DB_OWNER_PASSWORD:-change_me}"
DB="${APP_DB:-calling_agent}"
TEST_DB="${APP_TEST_DB:-calling_agent_test}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v owner="$OWNER" -v owner_password="$OWNER_PASSWORD" -v db="$DB" -v test_db="$TEST_DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER CREATEROLE PASSWORD %L', :'owner', :'owner_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'owner')\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db')\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'test_db', :'owner')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'test_db')\gexec
SQL

# pgvector needs a superuser to install; done here so migrations can rely on it.
for d in "$DB" "$TEST_DB"; do
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$d" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"
done

echo "Postgres ready: owner role '$OWNER' (non-superuser), databases '$DB' and '$TEST_DB'"
