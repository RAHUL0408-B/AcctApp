-- CA review: stop tax invoices that miss particulars Rule 46 of the CGST Rules asks for (off until the owner turns it on),
-- and customs duty on export invoices (off until the owner says it applies).
ALTER TABLE organizations
  ADD COLUMN strict_invoice_checks BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN customs_duty_applicable BOOLEAN NOT NULL DEFAULT false;
