-- 008: corrections after field feedback
-- 1. "same subnet as the gateway" was a wrong rule (same-subnet traffic does not pass the gateway).
--    Edges accepted from it no longer suppress alerts; the suggestion engine proposes removing them.
UPDATE dependencies SET strength = 'soft' WHERE description LIKE 'Vorschlag (routing):%selben Subnetz%';
DELETE FROM dependency_suggestions WHERE status = 'pending' AND evidence LIKE '%selben Subnetz%';
-- 2. automatic HTTP checks judge availability, not certificates (that is the TLS check's job):
--    a redirect to HTTPS with a self-signed certificate is not an outage.
UPDATE checks SET config = config || '{"tls_verify": false}'::jsonb
  WHERE type = 'http' AND origin = 'auto' AND NOT (config ? 'tls_verify');
-- 3. extra suggestion data (remove_edge, set_kind)
ALTER TABLE dependency_suggestions ALTER COLUMN strength SET DEFAULT 'hard';
