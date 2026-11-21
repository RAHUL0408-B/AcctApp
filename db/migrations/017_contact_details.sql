-- CA review, contacts: billing and delivery address, constitution of the business (drives the TDS rate), India (SEZ),
-- default TDS section and a lower-deduction certificate rate, GST on reverse charge by default, and purchases from
-- unregistered dealers as a supply type. All additive: existing contacts and documents keep working.

ALTER TABLE contacts
  ADD COLUMN address_line1 TEXT CHECK (length(address_line1) <= 200),
  ADD COLUMN address_line2 TEXT CHECK (length(address_line2) <= 200),
  ADD COLUMN city TEXT CHECK (length(city) <= 100),
  ADD COLUMN pincode TEXT CHECK (length(pincode) <= 12),
  ADD COLUMN ship_line1 TEXT CHECK (length(ship_line1) <= 200),
  ADD COLUMN ship_line2 TEXT CHECK (length(ship_line2) <= 200),
  ADD COLUMN ship_city TEXT CHECK (length(ship_city) <= 100),
  ADD COLUMN ship_state_code TEXT REFERENCES gst_states(code),
  ADD COLUMN ship_pincode TEXT CHECK (length(ship_pincode) <= 12),
  ADD COLUMN constitution TEXT CHECK (constitution IN ('individual','huf','partnership','llp','private_company','public_company','opc',
    'aop','boi','trust','society','cooperative','government','local_authority','ajp','foreign_company','other')),
  ADD COLUMN is_sez BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN default_tds_section TEXT CHECK (length(default_tds_section) <= 20),
  ADD COLUMN lower_tds_rate_bp INT CHECK (lower_tds_rate_bp BETWEEN 0 AND 3000),
  ADD COLUMN lower_tds_cert TEXT CHECK (length(lower_tds_cert) <= 40),
  ADD COLUMN rcm_default BOOLEAN NOT NULL DEFAULT false;

-- People already marked "individual / HUF" become individuals; the rest are left for the user to choose.
UPDATE contacts SET constitution = 'individual' WHERE is_individual AND constitution IS NULL;

-- A purchase from a dealer who is not registered under GST: no GST is charged and no credit is claimed.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_supply_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_supply_type_check
  CHECK (supply_type IN ('regular','export_lut','export_igst','sez_lut','sez_igst','reverse_charge','unregistered'));

-- Duties and taxes settings: the Letter of Undertaking for exports without IGST.
ALTER TABLE organizations
  ADD COLUMN lut_from DATE,
  ADD COLUMN lut_to DATE;
