-- 003: checks, check results and metrics (TimescaleDB hypertables)

CREATE TABLE checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id   uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  type          text NOT NULL,
  name          text NOT NULL,
  config        jsonb NOT NULL DEFAULT '{}',
  secret_id     uuid REFERENCES secrets(id) ON DELETE SET NULL,
  interval_s    integer NOT NULL DEFAULT 60 CHECK (interval_s >= 5),
  timeout_ms    integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 120000),
  enabled       boolean NOT NULL DEFAULT true,
  -- [{metric, op: '>'|'<'|'>='|'<='|'=='|'!=', warning?, critical?}]
  thresholds    jsonb NOT NULL DEFAULT '[]',
  fail_after    integer NOT NULL DEFAULT 2 CHECK (fail_after >= 1),     -- consecutive bad results before the state changes
  recover_after integer NOT NULL DEFAULT 2 CHECK (recover_after >= 1), -- consecutive good results before recovery
  hold_s        integer NOT NULL DEFAULT 0 CHECK (hold_s >= 0),         -- a bad streak must also last this long
  origin        text NOT NULL DEFAULT 'manual' CHECK (origin IN ('auto', 'manual')),
  template      text,
  -- state machine
  state         text NOT NULL DEFAULT 'pending',
  state_since   timestamptz NOT NULL DEFAULT now(),
  soft_state    text,
  soft_count    integer NOT NULL DEFAULT 0,
  streak_started_at timestamptz,
  recent_raw    text[] NOT NULL DEFAULT '{}',  -- last 21 raw states, for flap detection
  flapping      boolean NOT NULL DEFAULT false,
  flap_score    real NOT NULL DEFAULT 0,
  last_run      timestamptz,
  next_run      timestamptz NOT NULL DEFAULT now(),
  last_duration_ms real,
  last_message  text,
  last_raw_state text,
  last_metrics  jsonb NOT NULL DEFAULT '{}',
  last_ok_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_resource_idx ON checks(resource_id);
CREATE INDEX checks_due_idx ON checks(next_run) WHERE enabled;

CREATE TABLE check_results (
  time        timestamptz NOT NULL,
  check_id    uuid NOT NULL,
  resource_id uuid NOT NULL,
  raw_state   text NOT NULL,
  state       text NOT NULL,
  duration_ms real,
  message     text
);
SELECT create_hypertable('check_results', by_range('time', INTERVAL '1 day'));
CREATE INDEX check_results_check_idx ON check_results(check_id, time DESC);

CREATE TABLE metrics (
  time        timestamptz NOT NULL,
  resource_id uuid NOT NULL,
  check_id    uuid NOT NULL,
  metric      text NOT NULL,
  value       double precision NOT NULL
);
SELECT create_hypertable('metrics', by_range('time', INTERVAL '1 day'));
CREATE INDEX metrics_series_idx ON metrics(resource_id, metric, time DESC);
ALTER TABLE metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'resource_id, metric', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('metrics', INTERVAL '2 days');

-- catalog of series per resource: unit, label, latest value (drives the charts list)
CREATE TABLE metric_series (
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  metric      text NOT NULL,
  check_id    uuid REFERENCES checks(id) ON DELETE CASCADE,
  unit        text,
  label       text,
  last_value  double precision,
  last_time   timestamptz,
  PRIMARY KEY (resource_id, metric)
);
