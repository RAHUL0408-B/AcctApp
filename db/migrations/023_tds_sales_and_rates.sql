-- CA review 3: TDS that customers deduct on sales (TDS receivable), TDS carried on quotes and purchase orders,
-- "apply TDS irrespective of threshold", and the organisation's own TDS sections, rates and thresholds and GST rates.

-- A document can apply TDS even below the threshold (the person ticks "Apply TDS irrespective of threshold").
ALTER TABLE documents ADD COLUMN tds_forced BOOLEAN NOT NULL DEFAULT false;
-- Quotes carry TDS receivable and purchase orders TDS payable; it is copied on conversion.
ALTER TABLE pre_documents ADD COLUMN tds_section TEXT CHECK (length(tds_section) <= 20), ADD COLUMN tds_forced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recurring_invoices ADD COLUMN tds_forced BOOLEAN NOT NULL DEFAULT false;

-- The organisation's own TDS sections (custom) and its changes to the statutory rates and thresholds. The statutory
-- values stay in tds_sections; a row here for the same code overrides them for this organisation only.
CREATE TABLE org_tds_sections (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 20),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  rate_individual_bp INT NOT NULL CHECK (rate_individual_bp BETWEEN 0 AND 5000),
  rate_other_bp INT NOT NULL CHECK (rate_other_bp BETWEEN 0 AND 5000),
  single_threshold BIGINT NOT NULL DEFAULT 0 CHECK (single_threshold >= 0),
  annual_threshold BIGINT NOT NULL DEFAULT 0 CHECK (annual_threshold >= 0),
  custom BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX org_tds_sections_code ON org_tds_sections(org_id, code);
ALTER TABLE org_tds_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tds_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON org_tds_sections USING (org_id = current_org()) WITH CHECK (org_id = current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON org_tds_sections TO app_user;
GRANT USAGE, SELECT ON SEQUENCE org_tds_sections_id_seq TO app_user;

-- Extra GST rates the organisation uses (in basis points, for example 300 = 3% on gold), offered on every line.
ALTER TABLE organizations ADD COLUMN custom_gst_rates INT[] NOT NULL DEFAULT '{}';
