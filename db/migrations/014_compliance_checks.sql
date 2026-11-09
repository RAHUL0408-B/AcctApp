-- Checks a CA runs every month and at year-end, built from the books:
--   MSME payments under section 43B(h) of the Income Tax Act, the 180-day rule for input tax credit (Rule 37),
--   and matching purchase bills against GSTR-2B downloaded from the GST portal.

-- MSME (Udyam) status of a supplier. A micro or small enterprise must be paid within 15 days, or within the agreed
-- period if there is a written agreement (never more than 45 days); otherwise the expense is allowed only when paid.
ALTER TABLE contacts ADD COLUMN msme_type TEXT CHECK (msme_type IN ('micro','small','medium'));
ALTER TABLE contacts ADD COLUMN udyam_no TEXT CHECK (udyam_no IS NULL OR udyam_no ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$');
ALTER TABLE contacts ADD COLUMN msme_agreed_days INT CHECK (msme_agreed_days IS NULL OR msme_agreed_days BETWEEN 1 AND 365);

-- A GSTR-2B file as uploaded, and its invoice lines. Amounts in paise.
CREATE TABLE gstr2b_imports (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'), file_name TEXT NOT NULL, line_count INT NOT NULL,
  uploaded_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE gstr2b_lines (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  import_id BIGINT NOT NULL REFERENCES gstr2b_imports(id) ON DELETE CASCADE,
  gstin TEXT NOT NULL, supplier_name TEXT, invoice_no TEXT NOT NULL, invoice_key TEXT NOT NULL, invoice_date DATE,
  taxable BIGINT NOT NULL DEFAULT 0, igst BIGINT NOT NULL DEFAULT 0, cgst BIGINT NOT NULL DEFAULT 0, sgst BIGINT NOT NULL DEFAULT 0, cess BIGINT NOT NULL DEFAULT 0,
  itc_available BOOLEAN NOT NULL DEFAULT true, reverse_charge BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX gstr2b_lines_match ON gstr2b_lines(org_id, gstin, invoice_key);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['gstr2b_imports','gstr2b_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
