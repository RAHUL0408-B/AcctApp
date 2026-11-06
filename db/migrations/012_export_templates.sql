-- Export templates: how an organisation's PDF and Excel files look. The five built-in templates need no rows;
-- these tables hold templates an owner designs, and which template is used for reports and for invoices and bills.
CREATE TABLE export_templates (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, config JSONB NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- report_ref and document_ref are a built-in name ('classic', 'modern', ...) or 'custom:<export_templates.id>'.
CREATE TABLE export_defaults (
  org_id BIGINT PRIMARY KEY REFERENCES organizations(id),
  report_ref TEXT NOT NULL DEFAULT 'classic', document_ref TEXT NOT NULL DEFAULT 'classic',
  updated_by BIGINT REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['export_templates','export_defaults'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
