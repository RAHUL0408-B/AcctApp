-- CA review, chart of accounts: Financial Statement Line Item -> Group -> Sub-group -> Ledger. The account type stays
-- (the ledger and reports rely on it); the statement line and sub-group are added, and firms can add groups and sub-groups.
ALTER TABLE accounts
  ADD COLUMN fsli TEXT CHECK (fsli IN ('equity','ncl','cl','nca','ca','di','ii','de','ie')),
  ADD COLUMN sub_group TEXT CHECK (length(sub_group) <= 100);

-- Groups and sub-groups a firm created for a client, on top of the default ones. A sub-group names its group.
CREATE TABLE account_groups (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  fsli TEXT NOT NULL CHECK (fsli IN ('equity','ncl','cl','nca','ca','di','ii','de','ie')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  parent TEXT CHECK (length(parent) <= 100),
  code_from INT CHECK (code_from BETWEEN 1 AND 999999),
  code_to INT CHECK (code_to BETWEEN 1 AND 999999),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (code_from IS NULL OR code_to IS NULL OR code_to >= code_from)
);
CREATE UNIQUE INDEX account_groups_name ON account_groups(org_id, fsli, COALESCE(parent, ''), lower(name));
ALTER TABLE account_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON account_groups USING (org_id = current_org()) WITH CHECK (org_id = current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON account_groups TO app_user;
GRANT USAGE, SELECT ON SEQUENCE account_groups_id_seq TO app_user;

-- Existing accounts: the statement line from their type and number, and the GST and TDS sub-groups.
UPDATE accounts SET fsli = CASE
  WHEN type = 'equity' THEN 'equity'
  WHEN type = 'liability' AND code ~ '^\d+$' AND code::int BETWEEN 2400 AND 2999 THEN 'ncl'
  WHEN type = 'liability' THEN 'cl'
  WHEN type = 'asset' AND code ~ '^\d+$' AND code::int BETWEEN 1600 AND 1999 THEN 'nca'
  WHEN type = 'asset' THEN 'ca'
  WHEN type = 'income' AND code ~ '^\d+$' AND code::int BETWEEN 4000 AND 4099 THEN 'di'
  WHEN type = 'income' THEN 'ii'
  WHEN type = 'expense' AND code ~ '^\d+$' AND code::int BETWEEN 5000 AND 5399 THEN 'de'
  ELSE 'ie' END
WHERE fsli IS NULL;
UPDATE accounts SET sub_group = 'Output Tax Liability' WHERE sub_group IS NULL AND code IN ('2100','2110','2120','2160');
UPDATE accounts SET sub_group = 'Input Tax Credit' WHERE sub_group IS NULL AND code IN ('1300','1310','1320','1330','1340');
UPDATE accounts SET sub_group = 'TDS Payable' WHERE sub_group IS NULL AND code = '2200';
