-- Phase 4: DPDP consent/deletion, plans and billing, backup records.

CREATE TABLE consents (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('terms','privacy','marketing','analytics')),
  version TEXT NOT NULL, granted BOOLEAN NOT NULL, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consents_user ON consents(user_id, purpose, id);
-- Consent history is evidence: it can only be added to, never changed.
CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE TABLE deletion_requests (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
  note TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plans are configuration. Prices are placeholders: set real ones before launch.
CREATE TABLE plans (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, price_paise_monthly BIGINT NOT NULL, max_orgs INT NOT NULL, max_members INT NOT NULL,
  sort_order INT NOT NULL, active BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO plans VALUES
 ('free','Free',0,1,2,1,true),
 ('starter','Starter',99900,5,5,2,true),
 ('practice','Practice',299900,25,15,3,true),
 ('firm','Firm',799900,100,50,4,true);

CREATE TABLE subscriptions (
  firm_id BIGINT PRIMARY KEY REFERENCES firms(id), plan_code TEXT NOT NULL REFERENCES plans(code),
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled')),
  trial_ends DATE, current_period_end DATE, provider_ref TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_invoices (
  id BIGSERIAL PRIMARY KEY, firm_id BIGINT NOT NULL REFERENCES firms(id), number TEXT NOT NULL UNIQUE,
  plan_code TEXT NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL,
  amount BIGINT NOT NULL, gst BIGINT NOT NULL, total BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','failed')), paid_at TIMESTAMPTZ, provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK (total = amount + gst)
);

CREATE TABLE backups (
  id BIGSERIAL PRIMARY KEY, filename TEXT NOT NULL, size BIGINT NOT NULL, sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), verified_at TIMESTAMPTZ, verify_status TEXT, verify_detail TEXT
);

-- Existing firms start on the free plan.
INSERT INTO subscriptions(firm_id, plan_code, status) SELECT id, 'free', 'active' FROM firms;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
