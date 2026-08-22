#!/usr/bin/env python3
# Generate a source-less production compose from the base docker-compose.yml.
# Usage:  docker compose -f docker-compose.yml config --no-interpolate --format json \
#           | python3 package/gen-prod-compose.py > package/docker-compose.prod.json
#
# Transforms:
#   * drop demo / client / bundled-agent services (not part of the platform)
#   * swap the custom services from build: -> image: <REGISTRY>/<name>:<TAG>
#   * strip the dev-only source bind mounts + `command` overrides on those (the prod image is self-contained)
#   * keep infra services (postgres/clickhouse/redis/vault/caddy/...) as-is
#   * prune depends_on / config references to dropped services
# Env stays as ${VAR} (no secrets baked). REGISTRY/TAG come from the environment.
import json, os, sys

REGISTRY = os.environ.get("REGISTRY", "").rstrip("/")
TAG      = os.environ.get("TAG", "prod")
def imgref(name): return f"{REGISTRY}/{name}:{TAG}" if REGISTRY else f"{name}:{TAG}"

DROP = {
    "client-postgres", "client-mysql", "client-mysql-2", "client-mongo", "traffic-gen",
    "dam-agent-mongo", "dam-agent-mysql-proxy", "dam-agent-mysql2-proxy",
    "dam-frontend", "dam-admin-frontend",          # marketing mockups (nginx over ../mockups)
}
# Custom services we build into self-contained images:
IMG = {"dam-api", "dam-react", "dam-admin-react", "dam-collector",
       "dam-audit-consumer", "dam-approval-signer", "dam-discovery"}

d = json.load(sys.stdin)
svcs = d.get("services", {})
manifest = []   # (original_abs_source, relative_target) — build-images.sh copies these into the bundle

# 1) drop demo services
for n in list(svcs):
    if n in DROP:
        del svcs[n]

# 2) transform the rest
for n, s in svcs.items():
    # prune depends_on -> only kept services
    dep = s.get("depends_on")
    if isinstance(dep, dict):
        s["depends_on"] = {k: v for k, v in dep.items() if k in svcs} or None
        if s["depends_on"] is None: del s["depends_on"]
    elif isinstance(dep, list):
        s["depends_on"] = [k for k in dep if k in svcs]
        if not s["depends_on"]: del s["depends_on"]
    if n in IMG:
        s["image"] = imgref(n)
        s.pop("build", None)
        s.pop("command", None)          # dev servers ran `npm run dev`; prod image has its own CMD
        # keep only NAMED-volume mounts; drop dev source bind mounts (image is self-contained)
        vols = s.get("volumes")
        if isinstance(vols, list):
            kept = [v for v in vols if isinstance(v, dict) and v.get("type") == "volume"]
            if kept: s["volumes"] = kept
            else: s.pop("volumes", None)
    else:
        # infra service: relativize any absolute bind-mount source under the compose dir to ./config/<base>
        vols = s.get("volumes")
        if isinstance(vols, list):
            for v in vols:
                if isinstance(v, dict) and v.get("type") == "bind":
                    src = v.get("source", "")
                    base = os.path.basename(src.rstrip("/"))
                    # Caddy: bundle the DOMAIN-PARAMETERIZED package Caddyfile instead of the
                    # hard-coded dev one, so the installer's domain drives TLS (no per-deploy edit).
                    if n == "dam-caddy" and base == "Caddyfile":
                        src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config-src", "Caddyfile")
                    rel = f"./config/{n}/" + base   # namespaced → no collisions
                    manifest.append((src, rel))
                    v["source"] = rel
        # Caddy resolves {$DOMAIN}/{$ADMIN_DOMAIN} from its container env; compose passes them
        # from .env at deploy (tenant console + super-admin console on separate subdomains).
        if n == "dam-caddy":
            env = s.get("environment")
            if isinstance(env, list):
                env = dict((e.split("=", 1) + [""])[:2] for e in env)
            elif not isinstance(env, dict):
                env = {}
            env["DOMAIN"] = "${DOMAIN}"
            env["ADMIN_DOMAIN"] = "${ADMIN_DOMAIN}"
            s["environment"] = env

d.pop("name", None)   # let the deploy set the project name
json.dump(d, sys.stdout, indent=2)

# side-channel: tell build-images.sh which config files to bundle
with open(os.environ.get("MANIFEST", "package/config-manifest.tsv"), "w") as f:
    for src, rel in manifest:
        f.write(f"{src}\t{rel}\n")
