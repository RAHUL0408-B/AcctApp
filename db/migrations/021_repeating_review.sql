-- CA review, repeating invoices, bills and journals: wait for review instead of posting, supply type, archive and delete,
-- and a list of the ones due for posting (shown on the dashboard).
ALTER TABLE recurring_invoices
  ADD COLUMN post_mode TEXT NOT NULL DEFAULT 'auto' CHECK (post_mode IN ('auto', 'review')),
  ADD COLUMN supply_type TEXT NOT NULL DEFAULT 'regular' CHECK (supply_type IN ('regular','export_lut','export_igst','sez_lut','sez_igst','reverse_charge','unregistered')),
  ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE journal_rules
  ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- One row per run of a "review first" schedule that has fallen due: the person opens it, adds the supplier's bill
-- number or a copy, and posts it.
CREATE TABLE recurring_due (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  recurring_id BIGINT NOT NULL REFERENCES recurring_invoices(id),
  due_date DATE NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'skipped')),
  document_id BIGINT REFERENCES documents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recurring_id, due_date)
);
ALTER TABLE recurring_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_due FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON recurring_due USING (org_id = current_org()) WITH CHECK (org_id = current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_due TO app_user;
GRANT USAGE, SELECT ON SEQUENCE recurring_due_id_seq TO app_user;
