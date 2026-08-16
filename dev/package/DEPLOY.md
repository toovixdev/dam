# Deploy DAM without the codebase (images + compose only)

DAM is a multi-container stack, so the "no source" unit is a **set of pre-built images** run by a
**production compose file** — not a single executable. You build the bundle **once** on a host that has
the source, then the target host needs only Docker + three things: the compose file, a `config/` folder,
and a `.env`.

---

## A. Build the bundle (once, on a host WITH the source)

```bash
cd dev
./package/build-images.sh                       # → images tarball in package/dist/ (air-gapped)
# or push to a registry instead of a tarball:
REGISTRY=myreg.example/dam TAG=v1 PUSH=1 ./package/build-images.sh
```

This produces:
- **7 self-contained images** — `dam-api`, `dam-react`, `dam-admin-react`, `dam-collector`,
  `dam-audit-consumer`, `dam-approval-signer`, `dam-discovery`
  (everything else is an off-the-shelf image: postgres, clickhouse, redis, nats, minio, vault, caddy, registry).
- `package/docker-compose.prod.yml` — source-less compose (custom services reference the images above;
  no `build:` contexts, no source bind-mounts; env stays as `${VAR}`).
- `package/config/` — the only config files the stack bind-mounts (Caddyfile, DB init scripts, vault bootstrap).
- `package/dist/dam-images-<TAG>.tar.gz` — all 7 images (skipped if you used a registry).

> **What makes the images self-contained (the fix vs. today's source-based prod):**
> `dam-api` bakes `main.js` + its 4 modules + `node_modules` + all agent artifacts (Linux binary, `.deb`,
> `.rpm`, **and the Windows `.exe`**) — the eBPF `go generate` step is skipped by fetching the **pre-built**
> agent binaries. The frontends are `vite build` static assets served by nginx (no Vite dev server).

---

## B. Deploy on the target (no source)

Copy `docker-compose.prod.yml`, `config/`, the images tarball (if used), and your `.env` to the host, then:

```bash
# 1. install Docker + the compose plugin
# 2. load the images  (skip if you pushed to a registry + `docker login`)
gunzip -c dam-images-<TAG>.tar.gz | docker load
# 3. bring it up (auto-runs schema migrations on first boot)
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

Point DNS at the host's (reserved, static) IP; Caddy provisions TLS for the domain. `dam-api` creates the
`dam_control` schema, ClickHouse planes, etc. on first boot.

---

## C. What you MUST supply (not code, but mandatory)

**`.env`** — every `${VAR}` the compose references. The critical ones:
- **`CREDENTIAL_ENCRYPTION_KEY`** — 64-hex/256-bit. **Lose it and every encrypted connector credential/secret
  is unrecoverable.** Reuse the existing key to keep existing data; generate a new one only for a brand-new deploy.
- `DAM_JWT_SECRET`, `DAM_PG_PASSWORD`, `DAM_CLICKHOUSE_PASSWORD`
- `APP_BASE_URL`, `API_PUBLIC_URL`, `PUBLIC_CONTROL_PLANE` (your domain)
- SSO / SMTP / KMS / payment vars as needed (all optional, default blank)

**`config/`** — shipped by the build (Caddyfile, `dam-postgres/init.sql`, `dam-clickhouse/init.sql`,
`dam-vault-init/bootstrap.sh`). Edit the Caddyfile's domain for your host.

**Data** — a fresh deploy comes up **empty** (migrations build the schema; no tenants). To carry existing
tenants, restore the named volumes from backup **before** `up`:
`dam-pg-data` (Postgres control plane), `dam-ch-data` (ClickHouse events), `dam-minio-data` (branding),
plus the vault data. Otherwise you start clean.

**Infra** — a reserved static IP + DNS, inbound 443, outbound egress.

---

## D. Notes & excluded services

- **Excluded from the prod bundle** (they're demo/test, not the platform): `client-postgres`, `client-mysql*`,
  `client-mongo`, `traffic-gen`, the bundled Meridian demo agents (`dam-agent-*`), and the marketing-mockup
  nginx services (`dam-frontend`, `dam-admin-frontend`). Add them back only if you want the demo environment.
- **Agents** are deployed per-database by customers (they `curl` the binaries from `/api/download`), so they
  aren't part of the server bundle.
- **Vault** runs in `-dev` mode in the base compose; for production, front DAM's secrets with a real Vault or
  a cloud KMS (see the BYOK work) rather than the dev-mode server.
- Regenerate the compose any time the base changes: re-run `build-images.sh` (step 3 does it).
