-- Managed Postgres (Render, RDS, ...) gives you a non-superuser. In PostgreSQL 16 a role created by such a user is not
-- automatically usable with SET ROLE, which the app relies on for row-level security. Grant it explicitly.
-- On a superuser connection this is a harmless no-op.
DO $$ BEGIN
  GRANT app_user TO CURRENT_USER;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not grant app_user to %: %', CURRENT_USER, SQLERRM;
END $$;
