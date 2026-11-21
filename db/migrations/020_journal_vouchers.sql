-- CA review, manual journals: a voucher number (JV series with its own prefix) and journals sent for an accountant's review.
ALTER TABLE journal_entries ADD COLUMN voucher_no TEXT CHECK (length(voucher_no) <= 40);
CREATE UNIQUE INDEX journal_entries_voucher ON journal_entries(org_id, lower(voucher_no)) WHERE voucher_no IS NOT NULL;

CREATE TABLE journal_drafts (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  entry_date DATE NOT NULL,
  narration TEXT NOT NULL CHECK (length(narration) BETWEEN 1 AND 500),
  reference TEXT CHECK (length(reference) <= 100),
  voucher_no TEXT CHECK (length(voucher_no) <= 40),
  lines JSONB NOT NULL,
  total BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  reason TEXT CHECK (length(reason) <= 300),
  submitted_by BIGINT NOT NULL REFERENCES users(id),
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  posted_entry_id BIGINT REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE journal_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON journal_drafts USING (org_id = current_org()) WITH CHECK (org_id = current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_drafts TO app_user;
GRANT USAGE, SELECT ON SEQUENCE journal_drafts_id_seq TO app_user;
