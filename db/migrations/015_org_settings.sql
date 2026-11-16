-- Settings like Xero's: organisation details, branding (logo, address) on invoices, payment details with a UPI QR,
-- document number prefixes, email templates and reply-to, automatic payment reminders, a lock date for staff,
-- and currencies with default exchange rates. Every column is optional, so existing organisations work unchanged.

ALTER TABLE organizations
  ADD COLUMN legal_name TEXT CHECK (legal_name IS NULL OR length(legal_name) <= 200),
  ADD COLUMN business_type TEXT CHECK (business_type IS NULL OR business_type IN
    ('proprietorship','partnership','llp','private_limited','public_limited','opc','huf','trust','society','other')),
  ADD COLUMN industry TEXT CHECK (industry IS NULL OR length(industry) <= 100),
  ADD COLUMN cin TEXT CHECK (cin IS NULL OR length(cin) <= 30),
  ADD COLUMN tan TEXT CHECK (tan IS NULL OR tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 500),
  ADD COLUMN address_line1 TEXT, ADD COLUMN address_line2 TEXT, ADD COLUMN city TEXT,
  ADD COLUMN pincode TEXT CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  ADD COLUMN phone TEXT, ADD COLUMN email TEXT, ADD COLUMN website TEXT,
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Logo as a PNG or JPEG data URL (at most about 300 KB), printed on invoices.
  ADD COLUMN logo TEXT CHECK (logo IS NULL OR (length(logo) <= 420000 AND logo ~ '^data:image/(png|jpeg);base64,')),
  -- Payment details printed on sales invoices.
  ADD COLUMN bank_name TEXT, ADD COLUMN bank_account_name TEXT, ADD COLUMN bank_account_no TEXT,
  ADD COLUMN bank_ifsc TEXT CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  ADD COLUMN upi_id TEXT CHECK (upi_id IS NULL OR (length(upi_id) <= 100 AND upi_id ~ '^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,64}$')),
  ADD COLUMN show_payment_on_invoice BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN show_upi_qr BOOLEAN NOT NULL DEFAULT false,
  -- Number prefixes per document type, e.g. {"invoice":"SI","quote":"EST"}. Missing types keep the built-in prefix.
  ADD COLUMN doc_prefixes JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Email: reply-to address and message templates ({contact} {number} {amount} {due} {org} are filled in).
  ADD COLUMN email_reply_to TEXT, ADD COLUMN email_sender_name TEXT,
  ADD COLUMN email_invoice_subject TEXT, ADD COLUMN email_invoice_body TEXT,
  ADD COLUMN email_reminder_subject TEXT, ADD COLUMN email_reminder_body TEXT,
  -- Payment reminders: sent at most once every remind_every_days; auto_remind sends them daily without a click.
  ADD COLUMN auto_remind BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN remind_every_days INT NOT NULL DEFAULT 7 CHECK (remind_every_days BETWEEN 1 AND 90),
  -- Lock date for everyone except owners and accountants ("stop all users except advisers" in Xero).
  ADD COLUMN staff_lock_through DATE;

ALTER TABLE email_outbox ADD COLUMN reply_to TEXT, ADD COLUMN from_name TEXT;

-- Foreign currencies the organisation deals in, with the rate new documents start from (rupees per unit).
CREATE TABLE org_currencies (
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL CHECK (code ~ '^[A-Z]{3}$' AND code <> 'INR'),
  rate NUMERIC(14,6) NOT NULL CHECK (rate > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, code)
);
ALTER TABLE org_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_currencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON org_currencies USING (org_id = current_org()) WITH CHECK (org_id = current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
