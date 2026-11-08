-- 005: incidents, notification channels, routing, notifications log, maintenance windows

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id      uuid REFERENCES resources(id) ON DELETE CASCADE,   -- the root cause resource
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  severity         text NOT NULL CHECK (severity IN ('warning', 'critical', 'unknown')),
  peak_severity    text NOT NULL,
  title            text NOT NULL,
  summary          text,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  last_change_at   timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  affected_ids     uuid[] NOT NULL DEFAULT '{}',  -- downstream resources impacted by this root cause
  suppressed_ids   uuid[] NOT NULL DEFAULT '{}',  -- failing dependents whose alerts were suppressed
  check_ids        uuid[] NOT NULL DEFAULT '{}',
  flapping         boolean NOT NULL DEFAULT false,
  in_maintenance   boolean NOT NULL DEFAULT false,
  occurrences_7d   integer NOT NULL DEFAULT 1,
  notified_state   text,                          -- last severity a notification went out for (dedup)
  last_notified_at timestamptz
);
CREATE INDEX incidents_open_idx ON incidents(status) WHERE status = 'open';
CREATE UNIQUE INDEX incidents_one_open_per_resource ON incidents(resource_id) WHERE status = 'open';
CREATE INDEX incidents_resource_idx ON incidents(resource_id, opened_at DESC);

CREATE TABLE notification_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  type       text NOT NULL DEFAULT 'webhook' CHECK (type IN ('webhook')),
  config     jsonb NOT NULL DEFAULT '{}',   -- {url, method, headers, hmac_secret_id, timeout_ms}
  enabled    boolean NOT NULL DEFAULT true,
  last_status text,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routing_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  priority    integer NOT NULL DEFAULT 100,
  enabled     boolean NOT NULL DEFAULT true,
  match       jsonb NOT NULL DEFAULT '{}',   -- {min_severity, kinds, tags, environments, criticalities, groups, resource_ids}
  channel_ids uuid[] NOT NULL DEFAULT '{}',
  on_warning  boolean NOT NULL DEFAULT true,
  on_critical boolean NOT NULL DEFAULT true,
  on_recovery boolean NOT NULL DEFAULT true,
  repeat_interval_s integer NOT NULL DEFAULT 0,
  stop        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  time        timestamptz NOT NULL DEFAULT now(),
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  channel_id  uuid REFERENCES notification_channels(id) ON DELETE SET NULL,
  rule_id     uuid REFERENCES routing_rules(id) ON DELETE SET NULL,
  event       text NOT NULL,      -- warning, critical, recovery, reminder, test
  status      text NOT NULL,      -- sent, failed, suppressed
  reason      text,
  http_status integer,
  duration_ms real,
  dedup_key   text,
  payload     jsonb
);
CREATE INDEX notifications_time_idx ON notifications(time DESC);
CREATE INDEX notifications_incident_idx ON notifications(incident_id);

CREATE TABLE maintenance_windows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  reason       text,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  resource_ids uuid[] NOT NULL DEFAULT '{}',
  match_tags   text[] NOT NULL DEFAULT '{}',
  include_dependents boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- dependency analysis output per resource (written by the worker's evaluation loop)
ALTER TABLE resources
  ADD COLUMN own_status text NOT NULL DEFAULT 'pending',      -- status from its own checks only
  ADD COLUMN root_cause_ids uuid[] NOT NULL DEFAULT '{}',     -- failing upstream resources explaining this one
  ADD COLUMN impacted_by uuid[] NOT NULL DEFAULT '{}',        -- failing upstream resources (even if this one is OK)
  ADD COLUMN in_maintenance boolean NOT NULL DEFAULT false;
