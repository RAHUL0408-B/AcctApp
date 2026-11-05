-- Contacts: bank account details, default accounts for sales and purchases, and archiving.
ALTER TABLE contacts
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_name TEXT,
  ADD COLUMN bank_account_no TEXT,
  ADD COLUMN bank_ifsc TEXT CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  ADD COLUMN default_sales_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN default_purchase_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;
