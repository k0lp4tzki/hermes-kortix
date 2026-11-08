-- hermes:no-transaction
-- 004: downsampling (continuous aggregates); retention policies are applied by the worker from env settings
CREATE MATERIALIZED VIEW metrics_5m WITH (timescaledb.continuous) AS
  SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket, resource_id, metric,
         avg(value) AS avg, min(value) AS min, max(value) AS max, count(*) AS n
  FROM metrics GROUP BY bucket, resource_id, metric WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_5m', start_offset => INTERVAL '1 day', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes');

CREATE MATERIALIZED VIEW metrics_1h WITH (timescaledb.continuous) AS
  SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket, resource_id, metric,
         sum(avg * n) / NULLIF(sum(n), 0) AS avg, min(min) AS min, max(max) AS max, sum(n) AS n
  FROM metrics_5m GROUP BY 1, resource_id, metric WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1h', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes');

-- real-time aggregation: rollups include not-yet-materialized recent data
ALTER MATERIALIZED VIEW metrics_5m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW metrics_1h SET (timescaledb.materialized_only = false);
