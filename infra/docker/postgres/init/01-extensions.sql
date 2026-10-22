-- Runs once, on first start with an empty volume (docker-entrypoint-initdb.d).
-- Schema, roles and RLS policies are owned by the Core API migrations (apps/api), not here.

CREATE EXTENSION IF NOT EXISTS vector;
