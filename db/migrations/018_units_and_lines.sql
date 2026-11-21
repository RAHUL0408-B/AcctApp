-- CA review, invoices and bills: unit of measurement (GST UQC, Rule 46) on products and on every line.
ALTER TABLE items ADD COLUMN unit TEXT CHECK (unit ~ '^[A-Z]{2,8}$');
ALTER TABLE document_lines ADD COLUMN unit TEXT CHECK (unit ~ '^[A-Z]{2,8}$');
