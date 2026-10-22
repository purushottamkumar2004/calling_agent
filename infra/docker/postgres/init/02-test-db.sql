-- Integration-test database for the Core API, with pgvector enabled.
SELECT 'CREATE DATABASE calling_agent_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'calling_agent_test')\gexec

\connect calling_agent_test
CREATE EXTENSION IF NOT EXISTS vector;
