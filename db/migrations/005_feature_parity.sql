-- Phase 5: items catalogue, quotes and purchase orders, repeating invoices, bank rules, fixed assets, email tracking.

CREATE TABLE items (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('goods','service')),
  hsn_sac TEXT, sale_rate BIGINT NOT NULL DEFAULT 0, purchase_rate BIGINT NOT NULL DEFAULT 0, gst_rate_bp INT NOT NULL DEFAULT 1800,
  sales_account_id BIGINT REFERENCES accounts(id), purchase_account_id BIGINT REFERENCES accounts(id),
  active BOOLEAN NOT NULL DEFAULT true, UNIQUE (org_id, code)
);

-- Quotes and purchase orders do not touch the ledger. Converting one posts a real invoice or bill.
CREATE TABLE pre_documents (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('quote','purchase_order')), number TEXT NOT NULL,
  contact_id BIGINT NOT NULL REFERENCES contacts(id), issue_date DATE NOT NULL, expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','converted')),
  lines JSONB NOT NULL, subtotal BIGINT NOT NULL, tax BIGINT NOT NULL, total BIGINT NOT NULL, notes TEXT,
  converted_doc_id BIGINT REFERENCES documents(id), created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (org_id, kind, number)
);

CREATE TABLE recurring_invoices (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  contact_id BIGINT NOT NULL REFERENCES contacts(id), lines JSONB NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_date DATE NOT NULL, end_date DATE, due_days INT NOT NULL DEFAULT 15, auto_email BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true, last_doc_id BIGINT REFERENCES documents(id), created_by BIGINT NOT NULL REFERENCES users(id)
);

CREATE TABLE bank_rules (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, match_text TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')),
  account_id BIGINT NOT NULL REFERENCES accounts(id), active BOOLEAN NOT NULL DEFAULT true
);
ALTER TABLE bank_transactions ADD COLUMN rule_account_id BIGINT REFERENCES accounts(id);

CREATE TABLE fixed_assets (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, purchase_date DATE NOT NULL, cost BIGINT NOT NULL CHECK (cost > 0), residual BIGINT NOT NULL DEFAULT 0,
  method TEXT NOT NULL CHECK (method IN ('slm','wdv')), rate_bp INT NOT NULL CHECK (rate_bp > 0 AND rate_bp <= 10000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed')), disposed_on DATE,
  created_by BIGINT NOT NULL REFERENCES users(id), CHECK (residual < cost)
);
CREATE TABLE asset_depreciation (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  asset_id BIGINT NOT NULL REFERENCES fixed_assets(id), period_end DATE NOT NULL, amount BIGINT NOT NULL CHECK (amount > 0),
  entry_id BIGINT NOT NULL REFERENCES journal_entries(id), UNIQUE (asset_id, period_end)
);

ALTER TABLE documents ADD COLUMN sent_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN reminder_sent_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN recurring_id BIGINT REFERENCES recurring_invoices(id);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['items','pre_documents','recurring_invoices','bank_rules','fixed_assets','asset_depreciation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
