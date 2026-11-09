-- Password reset and email verification, sessions that end when the password changes, email invitations,
-- and two narrower roles: sales (invoices and customers only) and employee (own expense claims only).

ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0;     -- raised on a password change; older sessions stop working
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

-- One-time links sent by email. Only a hash of the token is stored.
CREATE TABLE auth_tokens (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('reset','verify')),
  token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose);

-- Roles. sales, employee and client always belong to one organisation.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'memberships'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner','accountant','staff','client','sales','employee'));
ALTER TABLE memberships ADD CONSTRAINT memberships_org_roles CHECK (role NOT IN ('client','sales','employee') OR org_id IS NOT NULL);

-- An owner invites someone by email. They accept by registering or by logging in with the same address.
CREATE TABLE invitations (
  id BIGSERIAL PRIMARY KEY, firm_id BIGINT NOT NULL REFERENCES firms(id), org_id BIGINT REFERENCES organizations(id),
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','accountant','staff','client','sales','employee')),
  token_hash TEXT NOT NULL UNIQUE, invited_by BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role NOT IN ('client','sales','employee') OR org_id IS NOT NULL)
);
CREATE INDEX invitations_firm ON invitations(firm_id);

-- 194J has two rates: 10% for professional fees and 2% for technical services (and some call-centre payments). Verify with your CA.
INSERT INTO tds_sections(code,description,rate_individual_bp,rate_other_bp,single_threshold,annual_threshold)
SELECT '194J(a)', 'Technical services / call centre (2%)', 200, 200, 0, 5000000
WHERE NOT EXISTS (SELECT 1 FROM tds_sections WHERE code = '194J(a)');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
