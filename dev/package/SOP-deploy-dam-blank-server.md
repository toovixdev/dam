# SOP — Deploy TooVix DAM on a Blank Server (source-less)

**Purpose:** stand up a full TooVix DAM control plane on a fresh Linux server using **pre-built images
only** — no source code on the target. The server runs Docker + a production compose file + config + a
`.env`; nothing else.

**Audience:** an operator with `sudo` on a blank Linux VM and a machine that has the DAM source (to build
the bundle once). **Time:** ~30–45 min. **Result:** a live DAM at `https://<your-domain>`, TLS auto-provisioned.

**Legend:** ☐ = do it · **PASS** = condition required before moving on. Don't proceed past a failed gate.

---

## Part 0 — Build the deployment bundle (ONCE, on a host WITH the source)

Run on any machine that has the repo + Docker (not the target).

```bash
cd dev
./package/build-images.sh              # → images tarball + prod compose + config
#   air-gapped output: package/dist/dam-images-<TAG>.tar.gz  (+ docker-compose.prod.yml, config/)
#   OR push to a registry instead of a tarball:
#   REGISTRY=myreg.example/dam TAG=v1 PUSH=1 ./package/build-images.sh
```
**PASS:** `package/dist/dam-images-<TAG>.tar.gz`, `package/docker-compose.prod.yml`, and `package/config/`
all exist (or the images are pushed to your registry).

☐ **0.1 Ship the bundle to the target:**
```bash
ssh user@SERVER 'mkdir -p ~/dam'
scp package/docker-compose.prod.yml package/.env.example  user@SERVER:~/dam/
scp -r package/config                                     user@SERVER:~/dam/
scp package/dist/dam-images-<TAG>.tar.gz                  user@SERVER:~/dam/
```

---

## Part 1 — Pre-checks on the blank server (go/no-go)

### A. Host size & OS
```bash
uname -m            # PASS: x86_64
nproc               # PASS: >= 4
free -g             # PASS: >= 8 GB RAM (16 recommended)
df -h /             # PASS: >= 50 GB free (ClickHouse events grow)
```
Ubuntu 22.04 / Debian 12 / RHEL 9 (or similar). arm64 is not supported.

### B. DNS resolves to THIS server (required for Caddy TLS)
```bash
dig +short dam.example.com          # PASS: returns THIS server's public IP
curl -s ifconfig.me                 # confirm the server's own public IP matches
```
**PASS:** the domain's A record points to the server's public IP (ideally a reserved/static IP).

### C. Firewall / ports
```bash
# inbound 80 + 443 must be open (Caddy: ACME on 80, serves on 443); egress open.
sudo ss -tlnp | grep -E ':(80|443)\b' || echo "(nothing bound yet — expected before deploy)"
```
**PASS:** cloud/security-group allows inbound **80 and 443**, and outbound egress.

### D. Docker + compose
```bash
docker version >/dev/null 2>&1 && docker compose version || {
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"; newgrp docker
}
docker compose version              # PASS: v2.x
```

### E. Bundle present
```bash
cd ~/dam && ls docker-compose.prod.yml .env.example config/ dam-images-*.tar.gz
```
**PASS:** all present (skip the tarball if you're pulling from a registry).

---

## Part 2 — Configure secrets & domain

☐ **2.1 Create `.env` from the template:**
```bash
cd ~/dam
cp .env.example .env
```

☐ **2.2 Generate strong secrets:**
```bash
openssl rand -hex 32       # CREDENTIAL_ENCRYPTION_KEY   (also use for DAM_JWT_SECRET)
openssl rand -hex 32       # DAM_JWT_SECRET
openssl rand -base64 24    # DAM_PG_PASSWORD
openssl rand -base64 24    # DAM_CLICKHOUSE_PASSWORD
```

☐ **2.3 Fill in `.env`** (`nano .env`) — set at minimum:
| Key | Value |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | the 64-hex value ⚠ **back this up — losing it makes encrypted secrets unrecoverable** |
| `DAM_JWT_SECRET` | the second hex value |
| `DAM_PG_PASSWORD` / `DAM_CLICKHOUSE_PASSWORD` | the two base64 values |
| `APP_BASE_URL` / `API_PUBLIC_URL` | `https://dam.example.com` |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | your super-admin login (seeded on first boot) |

*(SSO / SMTP / KMS / payment vars stay blank unless used.)*

☐ **2.4 Point Caddy at your domain** (so it auto-provisions TLS):
```bash
sed -i 's/dam\.suchirasoistories\.in/dam.example.com/g' config/dam-caddy/Caddyfile
grep -n 'dam.example.com' config/dam-caddy/Caddyfile     # PASS: your domain appears
```
**PASS:** `.env` has the 6 required keys set; the Caddyfile names your domain.

---

## Part 3 — Deploy

☐ **3.1 Load the images** (skip if pulling from a registry — then `docker login <registry>` instead):
```bash
gunzip -c dam-images-*.tar.gz | docker load
docker image ls | grep -E 'dam-api|dam-react|dam-collector'   # PASS: the :TAG images are present
```

☐ **3.2 Bring the stack up:**
```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d
docker compose -f docker-compose.prod.yml ps               # PASS: all services "running"/"healthy"
```

☐ **3.3 Watch first boot** (schema migrations + super-admin seed):
```bash
docker compose -f docker-compose.prod.yml logs -f dam-api
#   PASS lines:  "[Auth] Migration complete"  and  "[Admin] Seeded platform super-admin: <you>"
```

---

## Part 4 — Verify

☐ **4.1 Health (allow ~30s for Caddy to obtain the cert):**
```bash
curl -sS -o /dev/null -w "health=%{http_code}\n" https://dam.example.com/api/health   # PASS: 200
```

☐ **4.2 First login:**
- Open `https://dam.example.com` → sign in to the **super-admin** console with `PLATFORM_ADMIN_EMAIL`/`PASSWORD`.
- **Create your first tenant/workspace**, then log into that workspace.
- Onboard databases per the SOP guide (`/guides/sop.html`).

**PASS:** health `200`, super-admin login works, a tenant can be created.

---

## Part 5 — Post-deploy hardening (do immediately)

☐ **5.1** Change the super-admin password + **enroll MFA** (the seed password is bootstrap-only).
☐ **5.2** Store `CREDENTIAL_ENCRYPTION_KEY` (and `.env`) in your secret manager — off the server.
☐ **5.3** Restrict the server: SSH from admin IPs only; keep only 80/443 public.
☐ **5.4** Replace the base **dev-mode Vault** with a real Vault / cloud KMS for production secret custody.
☐ **5.5** Confirm the external IP is **reserved/static** (a reboot must not change it — DNS + agents depend on it).

---

## Part 6 — Backups & ops

**Back up these named volumes** (stateful data):
| Volume | Holds |
|---|---|
| `dam-pg-data` | control plane (`dam_control`) — tenants, users, policies, config |
| `dam-ch-data` | ClickHouse events (activity) |
| `dam-minio-data` | branding / object store |
| `dam-signer-keys` | evidence/pack signing keys |
| `dam-vault-bootstrap` | JIT broker bootstrap identity |

Example dump: `docker run --rm -v dam-pg-data:/v -v "$PWD":/b alpine tar czf /b/dam-pg-data.tgz -C /v .`

**Update the deployment:** rebuild the bundle on the source host (`build-images.sh`), copy the new
tarball + compose, `docker load`, then `docker compose -f docker-compose.prod.yml up -d` (pulls the new
images; volumes/data persist).

---

## Rollback / troubleshooting

| Symptom | Fix |
|---|---|
| `dam-api` crash-loops on boot | Check `.env` — missing `CREDENTIAL_ENCRYPTION_KEY` / DB passwords, or Postgres not ready. `docker compose logs dam-api`. |
| `health` never 200 / no TLS cert | DNS not pointing here yet, or 80/443 blocked (Caddy can't complete ACME). Recheck Part 1 B & C. |
| `docker load` fails / images missing | Wrong/partial tarball; re-scp. Or you meant to pull from a registry (`docker login` + set `REGISTRY`/`TAG`). |
| Everything up but blank dashboard | Expected on a fresh deploy — no tenants yet. Create one as super-admin (Part 4.2). |
| Need to start over | `docker compose -f docker-compose.prod.yml down -v` **wipes all volumes/data** — only for a clean redo. |

---

## One-page quick gate
| Gate | Command | PASS |
|---|---|---|
| Bundle built | `ls package/dist/*.tar.gz` | exists |
| Arch/size | `uname -m; nproc; free -g` | x86_64, ≥4, ≥8 |
| DNS | `dig +short dam.example.com` | this server's IP |
| Docker | `docker compose version` | v2.x |
| Secrets set | `grep -c '=.\+' .env` | 6 required filled |
| Images loaded | `docker image ls \| grep dam-api` | present |
| Stack up | `docker compose ... ps` | all running |
| Migrations | `logs dam-api` | "Migration complete" |
| Health | `curl .../api/health` | 200 |
| Login | super-admin | works |

*Bundle build + full reference: `package/DEPLOY.md`. Deploying without source = Docker + `docker-compose.prod.yml` + `config/` + `.env` + the images.*
