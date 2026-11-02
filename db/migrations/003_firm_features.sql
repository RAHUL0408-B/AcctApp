-- Phase 3: tasks/deadlines, client documents, email outbox, scheduled reports.

CREATE TABLE tasks (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL, description TEXT, due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  assigned_to BIGINT REFERENCES users(id),
  rule_code TEXT, period TEXT,                   -- set for auto-generated compliance tasks
  reminded_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, rule_code, period)
);

CREATE TABLE files (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general', uploaded_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_reports (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  report TEXT NOT NULL, format TEXT NOT NULL CHECK (format IN ('pdf','xlsx')),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly')), recipients TEXT[] NOT NULL,
  next_run DATE NOT NULL, last_run TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT NOT NULL REFERENCES users(id)
);

-- Outgoing mail queue. A worker sends pending rows; failures are retried then marked failed.
CREATE TABLE email_outbox (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  attachment_name TEXT, attachment_mime TEXT, attachment BYTEA,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INT NOT NULL DEFAULT 0, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ
);
CREATE INDEX email_outbox_pending ON email_outbox(status) WHERE status = 'pending';

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','files','scheduled_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
