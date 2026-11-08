-- 002: resource inventory, discovery (sources, candidates, rules), dependencies, events

CREATE TABLE discovery_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  type        text NOT NULL CHECK (type IN ('docker', 'host', 'network')),
  config      jsonb NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT true,
  interval_s  integer NOT NULL DEFAULT 60 CHECK (interval_s >= 10),
  orphan_after_s integer NOT NULL DEFAULT 86400,
  last_run_at timestamptz,
  last_duration_ms integer,
  last_error  text,
  last_item_count integer,
  run_requested_at timestamptz,
  system      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_key  text UNIQUE,
  kind          text NOT NULL,
  name          text NOT NULL,
  display_name  text,
  parent_id     uuid REFERENCES resources(id) ON DELETE SET NULL,
  environment   text,
  group_name    text,
  criticality   text NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
  owner         text,
  tags          text[] NOT NULL DEFAULT '{}',
  metadata      jsonb NOT NULL DEFAULT '{}',   -- user-defined key/values
  discovered    jsonb NOT NULL DEFAULT '{}',   -- attributes owned by discovery
  connection    jsonb NOT NULL DEFAULT '{}',   -- host/port/url used by checks
  notes         text,
  origin        text NOT NULL CHECK (origin IN ('auto', 'manual')),
  source_id     uuid REFERENCES discovery_sources(id) ON DELETE SET NULL,
  discovery_status text CHECK (discovery_status IN ('active', 'missing', 'orphaned', 'detached')),
  locked_fields text[] NOT NULL DEFAULT '{}',  -- fields a person edited; discovery never overwrites them
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  last_ok_at    timestamptz,                   -- last successful check
  monitoring_enabled boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'pending',
  status_since  timestamptz NOT NULL DEFAULT now(),
  status_message text,
  last_change_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  compose_project text GENERATED ALWAYS AS (discovered->>'compose_project') STORED
);
CREATE INDEX resources_parent_idx ON resources(parent_id);
CREATE INDEX resources_kind_idx ON resources(kind);
CREATE INDEX resources_status_idx ON resources(status);

-- identities of resources merged into another one, so discovery maps them to the survivor
CREATE TABLE resource_aliases (
  identity_key text PRIMARY KEY,
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery_candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES discovery_sources(id) ON DELETE CASCADE,
  identity_key text NOT NULL,
  kind         text NOT NULL,
  name         text NOT NULL,
  parent_identity_key text,
  proposed     jsonb NOT NULL,          -- the full DiscoveredItem
  status       text NOT NULL CHECK (status IN ('pending', 'ignored', 'accepted')),
  rule_id      uuid,
  resource_id  uuid REFERENCES resources(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  UNIQUE (source_id, identity_key)
);
CREATE INDEX discovery_candidates_status_idx ON discovery_candidates(status);

CREATE TABLE discovery_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  priority  integer NOT NULL DEFAULT 100,
  enabled   boolean NOT NULL DEFAULT true,
  match     jsonb NOT NULL DEFAULT '{}',
  action    text NOT NULL CHECK (action IN ('auto_accept', 'ignore', 'manual')),
  enable_monitoring boolean NOT NULL DEFAULT false,
  set       jsonb NOT NULL DEFAULT '{}',
  system    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "from" depends on "to": an outage of "to" can explain an outage of "from".
CREATE TABLE dependencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  to_id       uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  type        text NOT NULL,
  strength    text NOT NULL DEFAULT 'hard' CHECK (strength IN ('hard', 'soft')),
  origin      text NOT NULL DEFAULT 'manual' CHECK (origin IN ('auto', 'manual')),
  suppressed  boolean NOT NULL DEFAULT false,   -- auto edge a person removed; discovery keeps it removed
  attributes  jsonb NOT NULL DEFAULT '{}',      -- network, subnet, vlan, port, label
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, type),
  CHECK (from_id <> to_id)
);
CREATE INDEX dependencies_to_idx ON dependencies(to_id);

CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  time        timestamptz NOT NULL DEFAULT now(),
  resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
  check_id    uuid,
  incident_id uuid,
  kind        text NOT NULL,       -- state_change, discovery_new, discovery_change, recreated, missing, orphaned, config, incident_*, alert_*, ...
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'ok', 'warning', 'critical', 'unknown')),
  message     text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  actor       text
);
CREATE INDEX events_time_idx ON events(time DESC);
CREATE INDEX events_resource_idx ON events(resource_id, time DESC);
