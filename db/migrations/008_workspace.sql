-- Sales and purchase defaults, and projects (time and costs that can be invoiced).

-- Defaults used when an invoice or bill is created without a due date or notes.
ALTER TABLE organizations
  ADD COLUMN invoice_due_days INT CHECK (invoice_due_days BETWEEN 0 AND 365),
  ADD COLUMN bill_due_days INT CHECK (bill_due_days BETWEEN 0 AND 365),
  ADD COLUMN invoice_terms TEXT;

CREATE TABLE projects (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, contact_id BIGINT NOT NULL REFERENCES contacts(id),
  estimate BIGINT NOT NULL DEFAULT 0 CHECK (estimate >= 0), deadline DATE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','closed')),
  created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- Time worked: value = minutes x hourly rate / 60, rounded to the paisa.
CREATE TABLE project_time (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id), project_id BIGINT NOT NULL REFERENCES projects(id),
  user_id BIGINT NOT NULL REFERENCES users(id), work_date DATE NOT NULL, description TEXT NOT NULL,
  minutes INT NOT NULL CHECK (minutes > 0), rate BIGINT NOT NULL CHECK (rate >= 0),
  invoiced_doc_id BIGINT REFERENCES documents(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Costs spent on the project; chargeable ones are passed on when the project is invoiced.
CREATE TABLE project_costs (
  id BIGSERIAL PRIMARY KEY, org_id BIGINT NOT NULL REFERENCES organizations(id), project_id BIGINT NOT NULL REFERENCES projects(id),
  cost_date DATE NOT NULL, description TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount > 0), chargeable BOOLEAN NOT NULL DEFAULT true,
  invoiced_doc_id BIGINT REFERENCES documents(id), created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['projects','project_time','project_costs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
