# SOP — Create the read-only `dam_svc` role (PostgreSQL)

**Purpose:** a least-privilege PostgreSQL login for SecurEra DAM **classification** and **VA scanning**.
**Not needed for capture** — host/network/AgentLite capture never logs in as this user. `dam_svc` is strictly
read-only and can never modify data.

---

## 1. Create the login role (as a superuser / rds_superuser / cloudsqlsuperuser)
```sql
CREATE ROLE dam_svc LOGIN PASSWORD 'REPLACE_WITH_STRONG_SECRET';
GRANT pg_monitor TO dam_svc;   -- read settings + stats for VA/monitoring; grants NO write
```
`pg_monitor` is a built-in composite role (`pg_read_all_settings`, `pg_read_all_stats`,
`pg_stat_scan_tables`) — lets the VA scanner read `pg_settings`/stats without superuser.

## 2. Grant read on each target database (connected to that DB: `\c yourdb`)
```sql
GRANT CONNECT ON DATABASE yourdb TO dam_svc;

-- read on every non-system schema, plus FUTURE tables
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
           WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO dam_svc', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO dam_svc', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO dam_svc', s);
  END LOOP;
END $$;
```
> **Caveat on `ALTER DEFAULT PRIVILEGES`:** it only auto-grants for tables created **by the role that ran
> it**. If your app creates tables as another owner, also run (as that owner or a superuser):
> ```sql
> ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT SELECT ON TABLES TO dam_svc;
> ```

## 3. Allow the agent host to connect (`pg_hba.conf`)
```
# TYPE     DATABASE  USER      ADDRESS          METHOD
hostssl    all       dam_svc   10.0.0.20/32     scram-sha-256
```
```sql
SELECT pg_reload_conf();   -- no restart needed
```
If the server enforces SSL, the agent connects with `sslmode=require`.

## 4. Verify (read yes, write no)
```sql
SELECT has_table_privilege('dam_svc','public.your_table','SELECT');  -- expect t
SELECT has_table_privilege('dam_svc','public.your_table','INSERT');  -- expect f
SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname='dam_svc';  -- t, f
```
From the agent host:
```bash
psql "host=DB_HOST port=5432 dbname=yourdb user=dam_svc sslmode=require" \
  -c "SELECT count(*) FROM information_schema.columns;"
```

## 5. Point the agent at it
```
CLASSIFY=true
DB_USER=dam_svc
DB_PASSWORD=REPLACE_WITH_STRONG_SECRET
DB_NAME=yourdb
TARGET_PORT=5432
# VA_SCAN=true   # if you also want vulnerability assessment
```

## Managed-service notes
- **RDS/Aurora:** connect as the master user (`CREATE ROLE` + `GRANT pg_monitor` work). No `pg_hba` access —
  allow the agent host on 5432 via the **security group**.
- **Cloud SQL:** connect as `postgres`; grants work. Control access via **authorized networks / private IP**.
- **Azure Database for PostgreSQL (Flexible Server):** connect as admin; `pg_monitor` available; use
  **firewall rules** for the agent host.

## Security
- Strong, unique password stored in your secret manager; rotate per policy.
- `dam_svc` is read-only — no INSERT/UPDATE/DELETE/DDL, no superuser. It can never change anything.
