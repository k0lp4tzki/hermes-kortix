-- 006: push (heartbeat) checks: external jobs report in via /api/push/<token>
ALTER TABLE checks
  ADD COLUMN push_token text UNIQUE,
  ADD COLUMN push_last_at timestamptz,
  ADD COLUMN push_last_status text,
  ADD COLUMN push_last_message text;
