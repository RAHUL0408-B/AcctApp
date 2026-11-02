# Phase 1 ER diagram

Money columns are `BIGINT` paise. Tables marked (RLS) are row-level-security protected by `org_id`.

```mermaid
erDiagram
  firms ||--o{ organizations : "has clients"
  firms ||--o{ memberships : ""
  users ||--o{ memberships : ""
  organizations ||--o{ memberships : "client-only access"
  organizations ||--o{ accounts : "(RLS)"
  organizations ||--o{ financial_years : "(RLS) period lock"
  organizations ||--o{ journal_entries : "(RLS)"
  journal_entries ||--|{ journal_lines : "(RLS) >= 2, debits = credits"
  accounts ||--o{ journal_lines : ""
  journal_entries ||--o| journal_entries : "reverses_id (one reversal max)"
  users ||--o{ journal_entries : created_by
  organizations ||--o{ audit_log : "(RLS read)"

  firms { bigint id PK
    text name }
  users { bigint id PK
    text email UK
    text password_hash
    text totp_secret
    bool totp_enabled
    text[] recovery_codes
    int failed_logins
    timestamptz locked_until }
  organizations { bigint id PK
    bigint firm_id FK
    text name
    text gstin
    text pan
    text state_code
    int fy_start_month }
  memberships { bigint id PK
    bigint user_id FK
    bigint firm_id FK
    bigint org_id FK "NULL = whole firm"
    text role "owner|accountant|staff|client" }
  financial_years { bigint id PK
    bigint org_id FK
    date starts_on
    date ends_on
    date locked_through }
  accounts { bigint id PK
    bigint org_id FK
    text code
    text name
    text type "asset|liability|equity|income|expense"
    text group_name }
  journal_entries { bigint id PK
    bigint org_id FK
    date entry_date
    text narration
    bigint reverses_id FK
    bigint created_by FK }
  journal_lines { bigint id PK
    bigint entry_id FK
    bigint account_id FK
    bigint debit
    bigint credit }
  audit_log { bigint id PK
    bigint org_id
    bigint user_id
    text action
    text entity
    jsonb before_data
    jsonb after_data
    text ip }
```

## Database-enforced rules (see db/migrations/001_foundation.sql)
- `journal_entries`, `journal_lines`, `audit_log`: UPDATE and DELETE are blocked by triggers (append-only). Corrections are reversal entries.
- A deferred constraint trigger rejects any entry whose debits do not equal credits, or which has fewer than 2 lines.
- Each line has exactly one of debit/credit, both non-negative.
- Postings dated on or before `financial_years.locked_through` are rejected.
- Row-level security: the API runs tenant queries as role `app_user` with `app.org_id` set, so one client's rows are invisible to another.
