-- Fixed assets: code, group, depreciation basis, and what happened at disposal.
ALTER TABLE fixed_assets
  ADD COLUMN code TEXT,
  ADD COLUMN asset_group TEXT,
  ADD COLUMN useful_life_months INT CHECK (useful_life_months IS NULL OR useful_life_months BETWEEN 1 AND 1200),
  ADD COLUMN day_basis TEXT NOT NULL DEFAULT 'months' CHECK (day_basis IN ('months','actual_days')),
  ADD COLUMN disposal_proceeds BIGINT,
  ADD COLUMN disposal_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN disposal_gain BIGINT,            -- positive = gain, negative = loss
  ADD COLUMN disposal_entry_id BIGINT REFERENCES journal_entries(id);
ALTER TABLE fixed_assets DROP CONSTRAINT fixed_assets_method_check;
ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_method_check CHECK (method IN ('slm','wdv','slm_life'));
UPDATE fixed_assets SET code = 'FA-' || lpad(id::text, 4, '0') WHERE code IS NULL;
ALTER TABLE fixed_assets ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX fixed_assets_code ON fixed_assets(org_id, lower(code));

-- Saved invoice and bill templates: a starting point with contact, lines, terms and notes already filled in.
CREATE TABLE doc_templates (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice','bill')), payload JSONB NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, doc_type, name)
);

-- Journal rules: a manual journal that posts itself on a schedule (for example monthly insurance or prepaid expense write-off).
CREATE TABLE journal_rules (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, narration TEXT NOT NULL, lines JSONB NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_date DATE NOT NULL, end_date DATE, active BOOLEAN NOT NULL DEFAULT true, last_run DATE, runs INT NOT NULL DEFAULT 0,
  created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['doc_templates','journal_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Invoices and bills can be archived to hide them from the main list without cancelling them.
ALTER TABLE documents ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;
