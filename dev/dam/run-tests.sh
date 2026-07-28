#!/usr/bin/env bash
# TooVix DAM test runner. Runs every layer that needs no live infrastructure:
#   • API unit tests        (secrets encryption, compliance catalog)        — node
#   • Consumer unit tests    (Cloud SQL / Azure / AgentLite normalizers)     — node
#   • Agent Go unit tests    (masked-at-rest detection, identifier quoting)  — go
# Plus, when TEST_API_URL is set, the HTTP functional/regression suite.
#
# Auto-detects the toolchain: uses host `node` / `go` if installed, otherwise falls back to
# Docker (node:20-alpine / golang:1.22) — so a plain `./run-tests.sh` works on the server too.
#
# Usage:
#   ./run-tests.sh
#   TEST_API_URL=http://localhost:3000 TEST_TOKEN=<jwt> ./run-tests.sh   # + functional suite
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
NODE_IMG=node:20-alpine
GO_IMG=golang:1.22
fail=0
hr()   { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# node_test <subdir> <test-arg-string>  — host node if present, else Docker.
node_test() {
  local dir="$1" cmd="$2"
  if have node; then
    ( cd "$ROOT/$dir" && sh -c "node --test $cmd" )
  elif have docker; then
    echo "(via Docker: $NODE_IMG)"
    docker run --rm -v "$ROOT/$dir":/app -w /app "$NODE_IMG" sh -c "node --test $cmd"
  else
    echo "SKIP: neither node nor docker available"; return 0
  fi
}

hr "API unit tests"
node_test api "test/secrets.test.js test/compliance-catalog.test.js" || fail=1

hr "Audit-consumer unit tests"
node_test audit-consumer "test/*.test.js" || fail=1

hr "Agent Go unit tests"
if have go; then
  ( cd "$ROOT/agent" && go test ./maskdetect/ ) || fail=1
elif have docker; then
  echo "(via Docker: $GO_IMG)"
  docker run --rm -e CGO_ENABLED=0 -v "$ROOT/agent":/src -w /src "$GO_IMG" go test ./maskdetect/ || fail=1
else
  echo "SKIP: neither go nor docker available"
fi

hr "Functional / regression suite"
if [ -n "${TEST_API_URL:-}" ]; then
  echo "HTTP → $TEST_API_URL"
  if have node; then
    ( cd "$ROOT/api" && node --test test/functional.test.js ) || fail=1
  elif have docker; then
    echo "(via Docker: $NODE_IMG, --network host)"
    docker run --rm --network host \
      -e TEST_API_URL -e TEST_TOKEN -e TEST_ENROLL_TOKEN \
      -v "$ROOT/api":/app -w /app "$NODE_IMG" \
      sh -c "node --test test/functional.test.js" || fail=1
  else
    echo "SKIP: neither node nor docker available"
  fi
else
  echo "SKIP: set TEST_API_URL (and optionally TEST_TOKEN / TEST_ENROLL_TOKEN) to run it"
fi

hr "RESULT"
if [ "$fail" -eq 0 ]; then echo "✓ all suites passed"; else echo "✗ one or more suites failed"; fi
exit $fail
