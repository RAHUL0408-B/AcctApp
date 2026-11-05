-- Files can be attached to an invoice, bill, journal entry or fixed asset when it is created.
ALTER TABLE files
  ADD COLUMN link_type TEXT CHECK (link_type IN ('document','journal','asset')),
  ADD COLUMN link_id BIGINT,
  ADD CONSTRAINT files_link_both CHECK ((link_type IS NULL) = (link_id IS NULL));
CREATE INDEX files_link ON files(link_type, link_id) WHERE link_type IS NOT NULL;

-- When an invoice or bill is edited, the old version is voided and replaced. This points from the old one to its replacement.
ALTER TABLE documents ADD COLUMN replaced_by BIGINT REFERENCES documents(id);

-- A payment that was recorded against the wrong invoice can be unlinked: the payment row is removed and a reversing entry is posted.
