-- ─────────────────────────────────────────────────────────────────────────────
-- delete-tenant.sql — hard-delete a DAM tenant and ALL its data.
--
-- WHY THIS EXISTS: tenant_id foreign keys are NOT declared ON DELETE CASCADE, and
-- there is no delete-tenant API endpoint, so a plain `DELETE FROM tenants` fails on
-- FK violations. This removes every child row in FK-safe order, then the tenant,
-- inside a single transaction (any error rolls the whole thing back).
--
-- USAGE:
--   psql "<connection-string>" -v tenant_name=awstest -f delete-tenant.sql
--
-- Safe to dry-run first: run the SELECT counts block by hand before executing.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP on
BEGIN;

-- Resolve the tenant id from its name; abort loudly if it doesn't exist.
SELECT id AS tid FROM tenants WHERE name = :'tenant_name' \gset
\if :{?tid}
\else
  \echo '>>> No tenant named' :'tenant_name' '— nothing to delete. Rolling back.'
  ROLLBACK;
  \quit
\endif
\echo '>>> Deleting tenant' :'tenant_name' 'id=' :'tid'

-- 1) Indirect children (tables that reference a tenant-scoped row but carry NO tenant_id).
DELETE FROM policy_versions WHERE policy_id IN (SELECT id FROM policies      WHERE tenant_id = :'tid');
DELETE FROM dsar_data_hits  WHERE dsar_id   IN (SELECT id FROM dsar_requests WHERE tenant_id = :'tid');

-- 2) Rows that FK to databases / policies — delete before their parents.
DELETE FROM classified_columns WHERE tenant_id = :'tid';
DELETE FROM classified_objects WHERE tenant_id = :'tid';
DELETE FROM alert_notes        WHERE tenant_id = :'tid';
DELETE FROM alerts             WHERE tenant_id = :'tid';
DELETE FROM agents             WHERE tenant_id = :'tid';

-- 3) The parents referenced above.
DELETE FROM databases          WHERE tenant_id = :'tid';
DELETE FROM policies           WHERE tenant_id = :'tid';
DELETE FROM dsar_requests      WHERE tenant_id = :'tid';

-- 4) Remaining tenant-scoped tables (each references only tenants).
DELETE FROM admin_access_sessions    WHERE tenant_id = :'tid';
DELETE FROM alert_suppressions       WHERE tenant_id = :'tid';
DELETE FROM approval_requests        WHERE tenant_id = :'tid';
DELETE FROM audit_trail              WHERE tenant_id = :'tid';
DELETE FROM billing_invoices         WHERE tenant_id = :'tid';
DELETE FROM classification_rules     WHERE tenant_id = :'tid';
DELETE FROM db_instances             WHERE tenant_id = :'tid';
DELETE FROM decoys                   WHERE tenant_id = :'tid';
DELETE FROM discovery_candidates     WHERE tenant_id = :'tid';
DELETE FROM discovery_jobs           WHERE tenant_id = :'tid';
DELETE FROM exec_credentials         WHERE tenant_id = :'tid';
DELETE FROM feature_overrides        WHERE tenant_id = :'tid';
DELETE FROM gateway_config           WHERE tenant_id = :'tid';
DELETE FROM integrations             WHERE tenant_id = :'tid';
DELETE FROM jit_grants               WHERE tenant_id = :'tid';
DELETE FROM jit_brokers              WHERE tenant_id = :'tid';
DELETE FROM payment_methods          WHERE tenant_id = :'tid';
DELETE FROM platform_audit           WHERE tenant_id = :'tid';
DELETE FROM quarantine_sessions      WHERE tenant_id = :'tid';
DELETE FROM quota_overrides          WHERE tenant_id = :'tid';
DELETE FROM report_schedules         WHERE tenant_id = :'tid';
DELETE FROM tenant_billing_overrides WHERE tenant_id = :'tid';
DELETE FROM tenant_branding          WHERE tenant_id = :'tid';
DELETE FROM users                    WHERE tenant_id = :'tid';

-- 5) Finally the tenant itself.
DELETE FROM tenants WHERE id = :'tid';

\echo '>>> Done. Review the row above, then:  COMMIT;  (or ROLLBACK; to undo)'
-- Auto-commit. Comment out the next line if you prefer to inspect before committing.
COMMIT;
