-- Phase 1 foundation schema. All money is BIGINT paise.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

CREATE TABLE firms (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  totp_secret    TEXT,
  totp_enabled   BOOLEAN NOT NULL DEFAULT false,
  recovery_codes TEXT[] NOT NULL DEFAULT '{}',
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id               BIGSERIAL PRIMARY KEY,
  firm_id          BIGINT NOT NULL REFERENCES firms(id),
  name             TEXT NOT NULL,
  gstin            TEXT,
  pan              TEXT,
  state_code       TEXT,
  fy_start_month   INT NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- role: owner/accountant/staff on a firm (org_id NULL) or on one org; client = view-only on one org
CREATE TABLE memberships (
  id       BIGSERIAL PRIMARY KEY,
  user_id  BIGINT NOT NULL REFERENCES users(id),
  firm_id  BIGINT NOT NULL REFERENCES firms(id),
  org_id   BIGINT REFERENCES organizations(id),
  role     TEXT NOT NULL CHECK (role IN ('owner','accountant','staff','client')),
  CHECK (role <> 'client' OR org_id IS NOT NULL),
  UNIQUE (user_id, firm_id, org_id)
);
CREATE UNIQUE INDEX memberships_firm_level ON memberships(user_id, firm_id) WHERE org_id IS NULL;

CREATE TABLE financial_years (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES organizations(id),
  label      TEXT NOT NULL,
  starts_on  DATE NOT NULL,
  ends_on    DATE NOT NULL,
  locked_through DATE,
  CHECK (ends_on > starts_on),
  UNIQUE (org_id, starts_on)
);

CREATE TABLE accounts (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organizations(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  group_name  TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (org_id, code)
);

CREATE TABLE journal_entries (
  id           BIGSERIAL PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organizations(id),
  entry_date   DATE NOT NULL,
  narration    TEXT NOT NULL,
  reference    TEXT,
  reverses_id  BIGINT REFERENCES journal_entries(id),
  created_by   BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX journal_one_reversal ON journal_entries(reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE journal_lines (
  id          BIGSERIAL PRIMARY KEY,
  entry_id    BIGINT NOT NULL REFERENCES journal_entries(id),
  org_id      BIGINT NOT NULL REFERENCES organizations(id),
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  debit       BIGINT NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo        TEXT,
  CHECK ((debit = 0) <> (credit = 0))   -- exactly one side per line
);
CREATE INDEX journal_lines_account ON journal_lines(account_id);
CREATE INDEX journal_lines_entry ON journal_lines(entry_id);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT,
  user_id     BIGINT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_data JSONB,
  after_data  JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutability: posted entries and audit rows can never be changed or deleted.
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only); use a reversal entry', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Balance check: at commit, every entry must have debits = credits and at least 2 lines.
CREATE FUNCTION check_entry_balanced() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT; n INT;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*) INTO d, c, n
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c OR n < 2 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced (debit %, credit %, lines %)', NEW.entry_id, d, c, n;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Reject postings into a locked period.
CREATE FUNCTION check_period_open() RETURNS trigger AS $$
DECLARE lock_date DATE;
BEGIN
  SELECT MAX(locked_through) INTO lock_date FROM financial_years WHERE org_id = NEW.org_id;
  IF lock_date IS NOT NULL AND NEW.entry_date <= lock_date THEN
    RAISE EXCEPTION 'Period is locked through %', lock_date;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_period_open();

-- Row-level security: tenant tables are visible only for the org set on the session.
CREATE FUNCTION current_org() RETURNS BIGINT AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::BIGINT
$$ LANGUAGE sql STABLE;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['financial_years','accounts','journal_entries','journal_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
  ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_read ON audit_log FOR SELECT USING (org_id = current_org());
  CREATE POLICY any_insert ON audit_log FOR INSERT WITH CHECK (true);
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
