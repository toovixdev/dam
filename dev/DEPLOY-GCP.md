# TooVix DAM — GCP single-VM test deploy (HTTPS on 443)

Runs the whole dev stack on one Compute Engine VM, fronted by **Caddy** for automatic
HTTPS on port 443 (`https://dam.suchirasoistories.in`). Caddy terminates TLS and proxies
to the Vite servers, which already proxy `/api` `/auth` `/ws` to `dam-api` internally.

## 0. Prerequisites
- A GCP project + `gcloud` access.
- Domain **suchirasoistories.in** with DNS you can edit.
- A fresh GitHub token / deploy key (do NOT reuse the PAT embedded in the old git remote — rotate it).

## 1. VM
`e2-standard-4` (4 vCPU / 16 GB) min, Ubuntu 22.04, 100 GB SSD, network tag `dam-test`.
```bash
gcloud compute addresses create dam-test-ip --region=<region>
gcloud compute instances create dam-test \
  --machine-type=e2-standard-4 --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB --boot-disk-type=pd-ssd --tags=dam-test \
  --address=dam-test-ip --zone=<zone>
```

## 2. DNS — point the names at the static IP
Create **A records** at your DNS host:
- `dam.suchirasoistories.in`        → `<STATIC_IP>`
- `admin-dam.suchirasoistories.in`  → `<STATIC_IP>`   (optional; admin console)
Verify: `dig +short dam.suchirasoistories.in` returns the IP.

## 3. Firewall — only 80 + 443 (Caddy). Never expose DB/Redis/Vault.
```bash
gcloud compute firewall-rules create dam-test-https \
  --allow=tcp:80,tcp:443 --target-tags=dam-test --source-ranges=0.0.0.0/0
```
80 is required for Let's Encrypt's HTTP-01 challenge + the http→https redirect. You do NOT
need to open 5173/5174/3000 publicly anymore — Caddy reaches them over the internal network.

## 4. Docker + code
```bash
gcloud compute ssh dam-test --zone=<zone>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/toovixdev/dam.git && cd dam
```

## 5. `dev/.env` — copy your secrets up, then set the public URLs
Recreate `dev/.env` with the existing passwords/JWT/Azure creds, and set:
```
APP_BASE_URL=https://dam.suchirasoistories.in
API_PUBLIC_URL=https://dam.suchirasoistories.in
SIGNER_PUBLIC_URL=https://dam.suchirasoistories.in
AZURE_REDIRECT_URI=https://dam.suchirasoistories.in/auth/callback
OKTA_REDIRECT_URI=https://dam.suchirasoistories.in/auth/okta/callback
GOOGLE_REDIRECT_URI=https://dam.suchirasoistories.in/auth/google/callback
```
(Okta/Google client creds are stored per-tenant in the DB via the Integrations GUI; only the
redirect URI needs to match here.)

## 6. Bring it up
```bash
cd dev
docker compose up -d --build      # first build is large; a few minutes
docker compose ps                 # everything running; dam-caddy on 80/443
docker compose logs -f dam-caddy  # watch the cert get issued on first request
```
Open **https://dam.suchirasoistories.in** → valid Let's Encrypt cert, no port in the URL.

## 7. Register the HTTPS redirect URIs in each IdP
Add these to each app's allowed redirect URIs:
- **Azure / Entra** app → `https://dam.suchirasoistories.in/auth/callback`
- **Okta** app        → `https://dam.suchirasoistories.in/auth/okta/callback`
- **Google** OAuth client → `https://dam.suchirasoistories.in/auth/google/callback`
  (Google now accepts it because it's HTTPS on a real domain — the whole reason for this.)

## Notes
- Certs + ACME account persist in the `caddy-data` volume, so restarts don't re-issue.
- `allowedHosts` for the domain is already set in both `vite.config.js` files.
- This is the **dev** stack (Vite HMR, Vault dev mode, demo client DBs + traffic-gen). Great for
  a test env; not production-hardened — don't put real customer data on it.
- Local dev is unaffected: don't open 80/443 locally and Caddy just sits idle (or omit it with
  `docker compose up <services…>`).
