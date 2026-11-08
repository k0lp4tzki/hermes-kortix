-- 007: VMware discovery sources and dependency suggestions (evidence-based, reviewed by a person)
ALTER TABLE discovery_sources DROP CONSTRAINT IF EXISTS discovery_sources_type_check;
ALTER TABLE discovery_sources ADD CONSTRAINT discovery_sources_type_check CHECK (type IN ('docker', 'host', 'network', 'vmware'));

CREATE TABLE dependency_suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- stable key: from + (to resource | unknown target) + type, so a rejected suggestion stays rejected
  key         text NOT NULL UNIQUE,
  from_id     uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  to_id       uuid REFERENCES resources(id) ON DELETE CASCADE,
  -- target not in the inventory yet (e.g. a gateway or DB server seen on the wire)
  target      jsonb,                       -- {host, port, kind, name}
  type        text NOT NULL,
  strength    text NOT NULL DEFAULT 'hard',
  source      text NOT NULL,               -- vmware, connections, routing, dns
  confidence  text NOT NULL CHECK (confidence IN ('sure', 'evidence', 'hint')),
  evidence    text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  observations integer NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text
);
CREATE INDEX dependency_suggestions_status_idx ON dependency_suggestions(status);
