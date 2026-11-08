-- 001: base platform tables (users, sessions, encrypted secrets, settings, platform heartbeats)
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  display_name  text,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE user_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent  text,
  ip          text
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id);

-- Credentials for authenticated checks / webhooks. Values are AES-256-GCM encrypted
-- with a key derived from HERMES_SECRET_KEY; the API never returns plaintext.
CREATE TABLE secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  kind        text NOT NULL DEFAULT 'generic',
  ciphertext  bytea NOT NULL,
  iv          bytea NOT NULL,
  auth_tag    bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Liveness of the platform's own components (api, worker loops).
CREATE TABLE platform_heartbeats (
  component  text PRIMARY KEY,
  instance   text NOT NULL,
  started_at timestamptz NOT NULL,
  last_beat  timestamptz NOT NULL,
  info       jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE audit_log (
  id       bigserial PRIMARY KEY,
  time     timestamptz NOT NULL DEFAULT now(),
  user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  username text,
  action   text NOT NULL,
  target   text,
  details  jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_time_idx ON audit_log(time DESC);
