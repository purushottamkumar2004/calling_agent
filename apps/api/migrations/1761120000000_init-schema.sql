-- Up Migration
--
-- Core schema v1: tenants, users and auth, scheduling (locations, providers, slots,
-- contacts, appointments), calls (minimal, for call ownership checks), idempotency,
-- event outbox, audit log.
--
-- Security model
--   * This migration runs as the schema OWNER role. The running service connects as a
--     LOGIN role that is a member of `api_app`, which is NOT the owner, so row-level
--     security applies to it. RLS is ENABLEd (not FORCEd) so that SECURITY DEFINER
--     functions owned by the owner can do the few cross-tenant lookups we need
--     (login by email, refresh token lookup, resource ownership, outbox relay).
--   * Every request runs in a transaction with `SET LOCAL app.tenant_id`. With no
--     tenant set, every policy evaluates to false and no rows are visible.
--
-- Double-booking protection (defence in depth)
--   1. slots: unique (provider_id, starts_at) and an exclusion constraint so one
--      provider can never have overlapping slots.
--   2. booking claims a slot with `UPDATE ... WHERE status = 'open'`, which is atomic
--      under row locking.
--   3. appointments: partial unique index so a slot can hold at most one active
--      appointment, whatever the application does.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  CREATE ROLE api_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Tenants and users
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  plan        text NOT NULL DEFAULT 'pilot',
  region      text NOT NULL DEFAULT 'ap-south-1',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  email          text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  password_hash  text NOT NULL,
  name           text,
  role           text NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- MVP: one account per email across the platform (login does not ask for a tenant).
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid REFERENCES refresh_tokens (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (tenant_id, user_id);

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------

CREATE TABLE locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  name            text NOT NULL,
  address         text,
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  -- {"mon": [["09:00","13:00"],["16:00","20:00"]], ...} in the location timezone.
  hours           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(hours) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE providers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  name         text NOT NULL,
  specialty    text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX providers_location_idx ON providers (tenant_id, location_id);
CREATE INDEX providers_specialty_idx ON providers (tenant_id, lower(specialty));

-- The architecture data model lists Slot without tenant_id; it is added here to satisfy
-- the overriding rule "every business table carries tenant_id, enforced with RLS".
CREATE TABLE slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  provider_id  uuid NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'blocked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES providers (tenant_id, id),
  CONSTRAINT slots_time_order CHECK (ends_at > starts_at),
  CONSTRAINT slots_max_length CHECK (ends_at - starts_at <= interval '8 hours'),
  CONSTRAINT slots_provider_start_key UNIQUE (provider_id, starts_at),
  CONSTRAINT slots_no_overlap EXCLUDE USING gist (
    provider_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);
CREATE INDEX slots_open_idx ON slots (tenant_id, starts_at) WHERE status = 'open';

CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  -- AES-256-GCM, "<key_id>:<base64 iv|tag|ciphertext>". Never stored in plain text.
  phone_ciphertext   text NOT NULL,
  -- HMAC-SHA256(phone_hash_key, E.164) for exact-match lookup.
  phone_hash         bytea NOT NULL,
  name               text,
  language           text CHECK (language IN ('en-IN', 'hi-IN')),
  consent_outbound   boolean NOT NULL DEFAULT false,
  consent_whatsapp   boolean NOT NULL DEFAULT false,
  opted_out_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone_hash)
);

-- Minimal call row: enough for "tenant owns the call" checks and linking bookings.
-- The call-lifecycle task (POST /internal/v1/calls, call.ended ingestion) extends it.
CREATE TABLE calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  provider          text NOT NULL CHECK (provider IN ('exotel', 'plivo')),
  provider_call_id  text NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status            text NOT NULL DEFAULT 'in_progress'
                      CHECK (status IN ('in_progress', 'completed', 'failed')),
  agent_id          uuid,
  agent_version     integer,
  contact_id        uuid,
  campaign_id       uuid,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_call_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
);

CREATE TABLE appointments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  contact_id           uuid NOT NULL,
  slot_id              uuid NOT NULL,
  status               text NOT NULL
                         CHECK (status IN ('booked', 'rescheduled', 'cancelled', 'completed', 'no_show')),
  source               text NOT NULL CHECK (source IN ('call', 'dashboard', 'import')),
  reason               text CHECK (length(reason) <= 300),
  call_id              uuid,
  created_by_user_id   uuid,
  cancelled_at         timestamptz,
  cancel_reason        text CHECK (length(cancel_reason) <= 300),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES slots (tenant_id, id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT appointments_cancel_consistency
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- A slot holds at most one active appointment. Last line of defence against double-booking.
CREATE UNIQUE INDEX appointments_one_active_per_slot
  ON appointments (slot_id) WHERE status IN ('booked', 'rescheduled');
CREATE INDEX appointments_contact_idx ON appointments (tenant_id, contact_id);
CREATE INDEX appointments_slot_idx ON appointments (tenant_id, slot_id);

-- ---------------------------------------------------------------------------
-- Idempotency, outbox, audit
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  key              text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  operation        text NOT NULL,
  request_hash     bytea NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Transactional outbox. Rows are written in the same transaction as the business change
-- and relayed to Redis Streams by the API's outbox relay. Not tenant-scoped for reading:
-- the service role can only INSERT; the relay reads through SECURITY DEFINER functions.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  event_id      uuid NOT NULL UNIQUE,
  tenant_id     uuid NOT NULL,
  stream        text NOT NULL,
  envelope      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
  actor_id     text NOT NULL,
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text,
  call_id      uuid,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locations_updated_at BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER providers_updated_at BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER slots_updated_at BEFORE UPDATE ON slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'refresh_tokens', 'locations', 'providers', 'slots', 'contacts',
    'calls', 'appointments', 'idempotency_keys', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers (the only cross-tenant reads the service can make)
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth_find_user_by_email(p_email text)
  RETURNS TABLE (id uuid, tenant_id uuid, password_hash text, role text, status text, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.role, u.status, t.status
  FROM users u JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = lower(p_email)
$$;

CREATE FUNCTION auth_find_refresh_token(p_hash bytea)
  RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.tenant_id, r.user_id, r.expires_at, r.revoked_at
  FROM refresh_tokens r WHERE r.token_hash = p_hash
$$;

-- Owner tenant of a resource, or NULL if it does not exist. Lets the internal API
-- distinguish NOT_FOUND from TENANT_MISMATCH as the contract requires.
CREATE FUNCTION resource_tenant(p_kind text, p_id uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE result uuid;
BEGIN
  CASE p_kind
    WHEN 'call' THEN SELECT tenant_id INTO result FROM calls WHERE id = p_id;
    WHEN 'slot' THEN SELECT tenant_id INTO result FROM slots WHERE id = p_id;
    WHEN 'contact' THEN SELECT tenant_id INTO result FROM contacts WHERE id = p_id;
    WHEN 'appointment' THEN SELECT tenant_id INTO result FROM appointments WHERE id = p_id;
    WHEN 'provider' THEN SELECT tenant_id INTO result FROM providers WHERE id = p_id;
    WHEN 'location' THEN SELECT tenant_id INTO result FROM locations WHERE id = p_id;
    ELSE RAISE EXCEPTION 'unknown resource kind %', p_kind USING ERRCODE = '22023';
  END CASE;
  RETURN result;
END
$$;

-- Claims a batch of unpublished outbox rows. Row locks are held by the CALLER's
-- transaction, so concurrent relays (several API replicas) never publish the same row
-- at the same time.
CREATE FUNCTION outbox_claim(p_limit integer)
  RETURNS TABLE (id bigint, event_id uuid, stream text, envelope jsonb, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.event_id, o.stream, o.envelope, o.attempts
  FROM outbox o
  WHERE o.published_at IS NULL
  ORDER BY o.id
  LIMIT least(greatest(p_limit, 1), 500)
  FOR UPDATE SKIP LOCKED
$$;

CREATE FUNCTION outbox_mark_published(p_ids bigint[]) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ANY (p_ids) $$;

CREATE FUNCTION outbox_mark_failed(p_id bigint, p_error text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE outbox SET attempts = attempts + 1, last_error = left(p_error, 1000) WHERE id = p_id $$;

-- ---------------------------------------------------------------------------
-- Grants for the service role
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  auth_find_user_by_email(text), auth_find_refresh_token(bytea), resource_tenant(text, uuid),
  outbox_claim(integer), outbox_mark_published(bigint[]), outbox_mark_failed(bigint, text)
  FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO api_app;
GRANT SELECT, UPDATE ON tenants TO api_app;
GRANT SELECT, INSERT, UPDATE ON users, locations, providers, contacts, calls, appointments TO api_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens, slots, idempotency_keys TO api_app;
GRANT SELECT, INSERT ON audit_log TO api_app;
GRANT INSERT ON outbox TO api_app;
GRANT USAGE ON SEQUENCE outbox_id_seq, audit_log_id_seq TO api_app;
GRANT EXECUTE ON FUNCTION
  app_current_tenant(), auth_find_user_by_email(text), auth_find_refresh_token(bytea),
  resource_tenant(text, uuid), outbox_claim(integer), outbox_mark_published(bigint[]),
  outbox_mark_failed(bigint, text)
  TO api_app;

-- Down Migration

DROP TABLE IF EXISTS audit_log, outbox, idempotency_keys, appointments, calls, contacts,
  slots, providers, locations, refresh_tokens, users, tenants CASCADE;
DROP FUNCTION IF EXISTS outbox_mark_failed(bigint, text), outbox_mark_published(bigint[]),
  outbox_claim(integer), resource_tenant(text, uuid), auth_find_refresh_token(bytea),
  auth_find_user_by_email(text), set_updated_at(), app_current_tenant();
-- The api_app role is cluster-wide and may be shared with other databases; it is left in place.
