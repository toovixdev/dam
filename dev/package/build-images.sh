#!/usr/bin/env bash
# Build the SOURCE-LESS DAM deployment bundle — self-contained images + a prod compose + config.
# Run on a host that HAS the source + Docker, from anywhere (the script cd's to dev/).
#
#   ./package/build-images.sh                                   # air-gapped: images -> package/dist/*.tar.gz
#   REGISTRY=myreg.example/dam TAG=v1 PUSH=1 ./package/build-images.sh   # push to a registry instead
#
# The target host then needs only: package/docker-compose.prod.yml + package/config/ + a .env
# + the images (docker load the tarball, or docker login the registry). No source. See DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."                       # -> dev/
: "${TAG:=prod}"; : "${REGISTRY:=}"; : "${PUSH:=0}"
# Target servers are x86_64 — force it so a build on an arm64 machine (e.g. Apple Silicon) still
# produces runnable images. Override with PLATFORM=linux/arm64 only for an arm target.
: "${PLATFORM:=linux/amd64}"
: "${CP:=https://dam.suchirasoistories.in}"   # where to fetch the pre-built agent artifacts
ref(){ if [ -n "$REGISTRY" ]; then echo "${REGISTRY%/}/$1:$TAG"; else echo "$1:$TAG"; fi; }

echo "== 1/4 gather pre-built agent artifacts (Dockerfile.prod copies the whole dir) =="
mkdir -p dam/prebuilt-artifacts
# Keep any artifact you pre-placed (e.g. a locally-built dam-agent.exe); otherwise fetch it from
# the control plane. A 404 is non-fatal — the download for that platform is simply unavailable.
for f in dam-agent-linux-amd64 dam-agent.exe dam-agent_amd64.deb dam-agent_amd64.rpm; do
  if [ -s "dam/prebuilt-artifacts/$f" ]; then
    printf '   %-26s %s (kept — pre-placed)\n' "$f" "$(du -h dam/prebuilt-artifacts/$f | cut -f1)"
  elif curl -fsSL "$CP/api/download/$f" -o "dam/prebuilt-artifacts/$f"; then
    printf '   %-26s %s\n' "$f" "$(du -h dam/prebuilt-artifacts/$f | cut -f1)"
  else
    rm -f "dam/prebuilt-artifacts/$f"
    printf '   %-26s !! not served by %s — SKIPPED (that download will be unavailable)\n' "$f" "$CP"
  fi
done

echo "== 2/4 build self-contained images (platform=$PLATFORM) =="
docker build --platform "$PLATFORM" -t "$(ref dam-api)"             -f dam/api/Dockerfile.prod            dam
docker build --platform "$PLATFORM" -t "$(ref dam-react)"           -f dam/frontend/Dockerfile.prod       dam/frontend
docker build --platform "$PLATFORM" -t "$(ref dam-admin-react)"     -f dam/admin-frontend/Dockerfile.prod dam/admin-frontend
docker build --platform "$PLATFORM" -t "$(ref dam-collector)"       dam/collector
docker build --platform "$PLATFORM" -t "$(ref dam-audit-consumer)"  dam/audit-consumer
docker build --platform "$PLATFORM" -t "$(ref dam-approval-signer)" dam/approval-signer
docker build --platform "$PLATFORM" -t "$(ref dam-discovery)"       dam/discovery

echo "== 3/4 generate the prod compose + bundle config files =="
docker compose -f docker-compose.yml config --no-interpolate --format json \
  | REGISTRY="$REGISTRY" TAG="$TAG" python3 package/gen-prod-compose.py > package/docker-compose.prod.yml
rm -rf package/config && mkdir -p package/config
while IFS=$'\t' read -r src rel; do d="package/${rel#./}"; mkdir -p "$(dirname "$d")"; cp "$src" "$d"; done < package/config-manifest.tsv
echo "   compose -> package/docker-compose.prod.yml ; config -> package/config/"

echo "== 4/4 publish =="
IMAGES="dam-api dam-react dam-admin-react dam-collector dam-audit-consumer dam-approval-signer dam-discovery"
if [ "$PUSH" = "1" ] && [ -n "$REGISTRY" ]; then
  for i in $IMAGES; do docker push "$(ref "$i")"; done
  echo "   pushed ${IMAGES// /, } to ${REGISTRY}"
else
  mkdir -p package/dist
  # shellcheck disable=SC2046
  docker save $(for i in $IMAGES; do ref "$i"; done) | gzip > "package/dist/dam-images-${TAG}.tar.gz"
  echo "   saved -> package/dist/dam-images-${TAG}.tar.gz ($(du -h package/dist/dam-images-${TAG}.tar.gz | cut -f1))"
fi
echo "== DONE. Ship to the target: package/docker-compose.prod.yml + package/config/ + a .env + the images. See package/DEPLOY.md =="
