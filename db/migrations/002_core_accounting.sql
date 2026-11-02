-- Phase 2: contacts, GST/TDS configuration, documents, payments, bank. Money = BIGINT paise.
-- Tax rates and rules live in CONFIG TABLES (not code) so they can be updated when laws change.

CREATE TABLE gst_states (code TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO gst_states VALUES
('01','Jammu and Kashmir'),('02','Himachal Pradesh'),('03','Punjab'),('04','Chandigarh'),('05','Uttarakhand'),('06','Haryana'),
('07','Delhi'),('08','Rajasthan'),('09','Uttar Pradesh'),('10','Bihar'),('11','Sikkim'),('12','Arunachal Pradesh'),('13','Nagaland'),
('14','Manipur'),('15','Mizoram'),('16','Tripura'),('17','Meghalaya'),('18','Assam'),('19','West Bengal'),('20','Jharkhand'),
('21','Odisha'),('22','Chhattisgarh'),('23','Madhya Pradesh'),('24','Gujarat'),('26','Dadra and Nagar Haveli and Daman and Diu'),
('27','Maharashtra'),('29','Karnataka'),('30','Goa'),('31','Lakshadweep'),('32','Kerala'),('33','Tamil Nadu'),('34','Puducherry'),
('35','Andaman and Nicobar Islands'),('36','Telangana'),('37','Andhra Pradesh'),('38','Ladakh'),('97','Other Territory');

-- GST slabs in basis points (1800 = 18%). Valid-from/to lets a law change be a new row, not a code change.
CREATE TABLE gst_rates (
  id BIGSERIAL PRIMARY KEY, rate_bp INT NOT NULL, label TEXT NOT NULL,
  valid_from DATE NOT NULL DEFAULT '2017-07-01', valid_to DATE
);
INSERT INTO gst_rates(rate_bp,label) VALUES (0,'0% / Exempt / Nil'),(25,'0.25%'),(300,'3%'),(500,'5%'),(1200,'12%'),(1800,'18%'),(2800,'28%');

-- TDS sections. Rates in basis points. Verify against the current Finance Act with a CA before use.
CREATE TABLE tds_sections (
  id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL, description TEXT NOT NULL,
  rate_individual_bp INT NOT NULL, rate_other_bp INT NOT NULL,
  single_threshold BIGINT NOT NULL DEFAULT 0,   -- paise; applies per payment (0 = none)
  annual_threshold BIGINT NOT NULL DEFAULT 0,   -- paise; applies per year (0 = none)
  valid_from DATE NOT NULL DEFAULT '2024-04-01', valid_to DATE
);
INSERT INTO tds_sections(code,description,rate_individual_bp,rate_other_bp,single_threshold,annual_threshold) VALUES
('194C','Payment to contractors',100,200,3000000,10000000),
('194J','Professional / technical fees',1000,1000,0,5000000),
('194H','Commission or brokerage',200,200,0,2000000),
('194I(a)','Rent - plant and machinery',200,200,0,60000000),
('194I(b)','Rent - land, building, furniture',1000,1000,0,60000000),
('194A','Interest other than on securities',1000,1000,0,5000000),
('194Q','Purchase of goods (above Rs 50 lakh)',10,10,0,500000000);

-- Compliance calendar rules (Phase 3 reminders read these)
CREATE TABLE compliance_rules (
  id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly','quarterly')), due_day INT NOT NULL,
  due_month_offset INT NOT NULL DEFAULT 1, -- months after period end
  applies_when TEXT NOT NULL DEFAULT 'always'
);
INSERT INTO compliance_rules(code,title,frequency,due_day,due_month_offset,applies_when) VALUES
('GSTR1','GSTR-1 (outward supplies)','monthly',11,1,'gstin'),
('GSTR3B','GSTR-3B (summary return and tax payment)','monthly',20,1,'gstin'),
('TDS_PAY','TDS payment to government','monthly',7,1,'always'),
('TDS_RETURN','TDS return (24Q/26Q) - due on 31st of month after quarter end','quarterly',31,1,'always');

CREATE TABLE contacts (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('customer','supplier','both')),
  name TEXT NOT NULL, gstin TEXT, pan TEXT, state_code TEXT REFERENCES gst_states(code),
  email TEXT, phone TEXT, is_individual BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE doc_sequences (
  org_id BIGINT NOT NULL REFERENCES organizations(id), doc_type TEXT NOT NULL, fy_label TEXT NOT NULL,
  next_no INT NOT NULL DEFAULT 1, PRIMARY KEY (org_id, doc_type, fy_label)
);

-- One table for sales invoices, purchase bills, credit notes and debit notes.
CREATE TABLE documents (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice','bill','credit_note','debit_note')),
  number TEXT NOT NULL, contact_id BIGINT NOT NULL REFERENCES contacts(id),
  issue_date DATE NOT NULL, due_date DATE, place_of_supply TEXT REFERENCES gst_states(code),
  supplier_ref TEXT,                        -- the supplier's own bill number (for bills)
  original_doc_id BIGINT REFERENCES documents(id),  -- for credit/debit notes
  subtotal BIGINT NOT NULL, cgst BIGINT NOT NULL DEFAULT 0, sgst BIGINT NOT NULL DEFAULT 0, igst BIGINT NOT NULL DEFAULT 0,
  tds_section TEXT, tds_amount BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL,                    -- subtotal + GST
  net_payable BIGINT NOT NULL,              -- total - tds_amount
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  void_entry_id BIGINT REFERENCES journal_entries(id),
  notes TEXT, created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, doc_type, number),
  CHECK (total = subtotal + cgst + sgst + igst), CHECK (net_payable = total - tds_amount)
);
CREATE INDEX documents_contact ON documents(contact_id);

CREATE TABLE document_lines (
  id BIGSERIAL PRIMARY KEY, doc_id BIGINT NOT NULL REFERENCES documents(id), org_id BIGINT NOT NULL REFERENCES organizations(id),
  description TEXT NOT NULL, hsn_sac TEXT, qty_milli BIGINT NOT NULL, rate BIGINT NOT NULL,
  taxable BIGINT NOT NULL, gst_rate_bp INT NOT NULL DEFAULT 0,
  cgst BIGINT NOT NULL DEFAULT 0, sgst BIGINT NOT NULL DEFAULT 0, igst BIGINT NOT NULL DEFAULT 0,
  account_id BIGINT NOT NULL REFERENCES accounts(id)
);

CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  doc_id BIGINT NOT NULL REFERENCES documents(id), pay_date DATE NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0), account_id BIGINT NOT NULL REFERENCES accounts(id),
  journal_entry_id BIGINT NOT NULL REFERENCES journal_entries(id), reference TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_accounts (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, account_id BIGINT NOT NULL REFERENCES accounts(id), account_no_last4 TEXT,
  UNIQUE (org_id, account_id)
);

CREATE TABLE bank_transactions (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  bank_account_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  txn_date DATE NOT NULL, description TEXT NOT NULL, amount BIGINT NOT NULL,  -- +ve money in, -ve money out
  reference TEXT, import_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unreconciled' CHECK (status IN ('unreconciled','reconciled')),
  matched_entry_id BIGINT REFERENCES journal_entries(id),
  UNIQUE (bank_account_id, import_hash)
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','doc_sequences','documents','document_lines','payments','bank_accounts','bank_transactions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
