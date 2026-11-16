-- Repeating bills, batch payments, access per person, and GST details: cess, blocked credits (section 17(5)),
-- ITC reversals under Rule 37, and amended invoices and credit/debit notes in GSTR-2B. All additive: existing data keeps working.

-- ---------- repeating bills: the repeating schedule can make bills as well as invoices
ALTER TABLE recurring_invoices
  ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'invoice' CHECK (doc_type IN ('invoice','bill')),
  ADD COLUMN tds_section TEXT,
  ADD COLUMN reference_note TEXT CHECK (reference_note IS NULL OR length(reference_note) <= 200);

-- ---------- batch payments: several invoices or bills settled by one bank payment (one journal entry)
CREATE TABLE payment_batches (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  side TEXT NOT NULL CHECK (side IN ('receive','pay')),
  pay_date DATE NOT NULL, account_id BIGINT NOT NULL REFERENCES accounts(id), reference TEXT,
  total BIGINT NOT NULL CHECK (total > 0), journal_entry_id BIGINT NOT NULL REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','undone')), undo_entry_id BIGINT REFERENCES journal_entries(id),
  created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payments ADD COLUMN batch_id BIGINT REFERENCES payment_batches(id);

-- ---------- access per person: per area, 'none', 'view' or 'edit'. NULL means the role decides everything (as before).
ALTER TABLE memberships ADD COLUMN access JSONB;

-- ---------- GST: compensation cess and blocked credits
ALTER TABLE document_lines
  ADD COLUMN cess_rate_bp INT NOT NULL DEFAULT 0 CHECK (cess_rate_bp BETWEEN 0 AND 30000),
  ADD COLUMN cess BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN itc_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN cess BIGINT NOT NULL DEFAULT 0;
-- An account whose purchases never give input credit (section 17(5): motor cars, food, club fees, personal use...).
ALTER TABLE accounts ADD COLUMN itc_blocked BOOLEAN NOT NULL DEFAULT false;

-- Input credit reversed because a bill stayed unpaid for 180 days (Rule 37), and reclaimed once it is paid.
CREATE TABLE itc_reversals (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  doc_id BIGINT NOT NULL REFERENCES documents(id), reversed_on DATE NOT NULL,
  cgst BIGINT NOT NULL DEFAULT 0, sgst BIGINT NOT NULL DEFAULT 0, igst BIGINT NOT NULL DEFAULT 0,
  entry_id BIGINT NOT NULL REFERENCES journal_entries(id),
  reclaimed_on DATE, reclaim_entry_id BIGINT REFERENCES journal_entries(id),
  created_by BIGINT NOT NULL REFERENCES users(id)
);
CREATE UNIQUE INDEX itc_reversals_open ON itc_reversals(doc_id) WHERE reclaimed_on IS NULL;

-- GSTR-2B: amended invoices (B2BA) and supplier credit/debit notes (CDNR).
ALTER TABLE gstr2b_lines
  ADD COLUMN doc_kind TEXT NOT NULL DEFAULT 'invoice' CHECK (doc_kind IN ('invoice','credit_note','debit_note')),
  ADD COLUMN amended BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN original_no TEXT, ADD COLUMN original_key TEXT;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['payment_batches','itc_reversals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- A document's total now includes cess.
DO $$ DECLARE n TEXT; BEGIN
  SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'documents'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%total = (((subtotal + cgst) + sgst) + igst)%';
  IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', n); END IF;
END $$;
ALTER TABLE documents ADD CONSTRAINT documents_total_includes_cess CHECK (total = subtotal + cgst + sgst + igst + cess);
