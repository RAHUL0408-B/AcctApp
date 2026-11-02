-- Phase 6: GST special cases (exports, SEZ, reverse charge, composition), foreign currency, approvals, expense claims,
-- inventory, tracking categories, budgets and year-end closing.

-- GST scheme of the organisation and its Letter of Undertaking (needed to export without paying IGST).
ALTER TABLE organizations ADD COLUMN gst_scheme TEXT NOT NULL DEFAULT 'regular' CHECK (gst_scheme IN ('regular','composition'));
ALTER TABLE organizations ADD COLUMN lut_number TEXT;
-- Staff must send invoices and bills for approval instead of posting them.
ALTER TABLE organizations ADD COLUMN require_approval BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE contacts ADD COLUMN country TEXT NOT NULL DEFAULT 'IN' CHECK (country ~ '^[A-Z]{2}$');
-- Place of supply for exports.
INSERT INTO gst_states(code,name) VALUES ('96','Other Countries') ON CONFLICT DO NOTHING;

-- How the supply is taxed. Reverse charge applies to bills only: the buyer pays the GST, not the supplier.
ALTER TABLE documents ADD COLUMN supply_type TEXT NOT NULL DEFAULT 'regular'
  CHECK (supply_type IN ('regular','export_lut','export_igst','sez_lut','sez_igst','reverse_charge'));
ALTER TABLE documents ADD COLUMN rcm_cgst BIGINT NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN rcm_sgst BIGINT NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN rcm_igst BIGINT NOT NULL DEFAULT 0;
-- Foreign currency: the ledger stays in rupees; the document keeps its own currency, rate and total.
ALTER TABLE documents ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE documents ADD COLUMN fx_rate NUMERIC(16,6) NOT NULL DEFAULT 1 CHECK (fx_rate > 0);
ALTER TABLE documents ADD COLUMN foreign_total BIGINT;
ALTER TABLE payments ADD COLUMN foreign_amount BIGINT;
ALTER TABLE payments ADD COLUMN bank_amount BIGINT;      -- rupees actually received or paid (differs from amount when exchange rates move)
ALTER TABLE payments ADD COLUMN fx_gain BIGINT NOT NULL DEFAULT 0;

-- Tracking categories (e.g. "Branch": Mumbai, Pune) tag income and expense lines for reporting.
CREATE TABLE tracking_categories (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, UNIQUE (org_id, name)
);
CREATE TABLE tracking_options (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  category_id BIGINT NOT NULL REFERENCES tracking_categories(id), name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (category_id, name)
);
ALTER TABLE document_lines ADD COLUMN tracking_option_id BIGINT REFERENCES tracking_options(id);
ALTER TABLE journal_lines ADD COLUMN tracking_option_id BIGINT REFERENCES tracking_options(id);

-- Closing entries move a year's profit to reserves. Reports of that year's profit ignore them.
ALTER TABLE journal_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','closing'));

-- Inventory: tracked goods keep a quantity and a weighted average cost.
ALTER TABLE items ADD COLUMN track_stock BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE document_lines ADD COLUMN item_id BIGINT REFERENCES items(id);
CREATE TABLE stock_moves (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  item_id BIGINT NOT NULL REFERENCES items(id), move_date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','adjustment','void')),
  qty_milli BIGINT NOT NULL CHECK (qty_milli <> 0),     -- positive in, negative out
  value BIGINT NOT NULL,                                -- cost in paise, same sign as qty
  doc_id BIGINT REFERENCES documents(id), entry_id BIGINT REFERENCES journal_entries(id), note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_moves_item ON stock_moves(item_id, id);

-- Invoices and bills waiting for approval. Approving one posts it as a normal document.
CREATE TABLE document_drafts (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  doc_type TEXT NOT NULL, contact_id BIGINT NOT NULL REFERENCES contacts(id), payload JSONB NOT NULL, total BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submitted_by BIGINT NOT NULL REFERENCES users(id), decided_by BIGINT REFERENCES users(id), decided_at TIMESTAMPTZ, reason TEXT,
  posted_doc_id BIGINT REFERENCES documents(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Expense claims: an employee spends their own money, a manager approves, the business repays.
CREATE TABLE expense_claims (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  claimant_id BIGINT NOT NULL REFERENCES users(id), claim_date DATE NOT NULL, title TEXT NOT NULL, lines JSONB NOT NULL,
  total BIGINT NOT NULL CHECK (total > 0),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
  decided_by BIGINT REFERENCES users(id), reason TEXT, approved_entry_id BIGINT REFERENCES journal_entries(id),
  paid_entry_id BIGINT REFERENCES journal_entries(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Budgets: an amount per account per month.
CREATE TABLE budgets (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, fy_start DATE NOT NULL,
  UNIQUE (org_id, name)
);
CREATE TABLE budget_lines (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id), budget_id BIGINT NOT NULL REFERENCES budgets(id),
  account_id BIGINT NOT NULL REFERENCES accounts(id), month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1), amount BIGINT NOT NULL,
  UNIQUE (budget_id, account_id, month)
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['tracking_categories','tracking_options','stock_moves','document_drafts','expense_claims','budgets','budget_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

-- Stock moves are history: never edited or deleted (a void adds an opposite move).
CREATE TRIGGER stock_moves_append_only BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
