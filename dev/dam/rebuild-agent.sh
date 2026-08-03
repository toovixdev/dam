#!/usr/bin/env bash
# Rebuild + redeploy DAM agent(s) after an agent code change (run ON the DAM host, from anywhere).
# The agent image is compiled inside the build container, so no host Go toolchain is needed.
#
# Usage:  dam/rebuild-agent.sh [agent-service ...]      # default: dam-agent-mysql-proxy
# e.g.:   dam/rebuild-agent.sh dam-agent-mysql-proxy dam-agent-mysql-network
#
# After redeploy, a VA scan (CIS checks + CVE version report + entitlement collection) runs
# ~10s after the agent starts; this tails the relevant log lines.
set -euo pipefail
cd "$(dirname "$0")/.."                                  # -> dev/ (where docker-compose.yml lives)
AGENTS=("$@"); [ ${#AGENTS[@]} -eq 0 ] && AGENTS=(dam-agent-mysql-proxy)

echo "▶ Building: ${AGENTS[*]}"
docker compose build "${AGENTS[@]}"
echo "▶ Redeploying…"
docker compose up -d "${AGENTS[@]}"
echo "▶ Waiting for the startup VA scan…"; sleep 30
echo "▶ Recent VA / entitlement log lines:"
docker compose logs --since 90s "${AGENTS[@]}" 2>&1 | grep -iE "VA scan reported|VA entitlements|VA context" | tail -10 || true
