#!/usr/bin/env bash
# TooVix DAM test runner. Runs every layer that needs no live infrastructure:
#   • API unit tests        (secrets encryption, compliance catalog)      — node --test
#   • Consumer unit tests    (Cloud SQL / Azure / AgentLite normalizers)  — node --test
#   • Agent Go unit tests    (masked-at-rest detection, identifier quoting) — go test (Docker)
# Plus, when TEST_API_URL is set, the HTTP functional/regression suite against a running API.
#
# Usage:
#   ./run-tests.sh                       # unit + component layers (no stack required)
#   TEST_API_URL=https://dam.example \
#   TEST_TOKEN=<jwt> ./run-tests.sh      # also runs the functional/regression suite
set -uo pipefail
cd "$(dirname "$0")"
fail=0
hr() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }

hr "API unit tests (node --test)"
( cd api && node --test test/secrets.test.js test/compliance-catalog.test.js ) || fail=1

hr "Audit-consumer unit tests (node --test)"
( cd audit-consumer && node --test test/*.test.js ) || fail=1

hr "Agent Go unit tests (go test in Docker)"
if command -v go >/dev/null 2>&1; then
  ( cd agent && go test ./maskdetect/ ) || fail=1
elif command -v docker >/dev/null 2>&1; then
  ( cd agent && docker run --rm -e CGO_ENABLED=0 -v "$PWD":/src -w /src golang:1.22 go test ./maskdetect/ ) || fail=1
else
  echo "SKIP: neither go nor docker available for the agent tests"
fi

if [ -n "${TEST_API_URL:-}" ]; then
  hr "Functional / regression suite (HTTP → $TEST_API_URL)"
  ( cd api && node --test test/functional.test.js ) || fail=1
else
  hr "Functional / regression suite"
  echo "SKIP: set TEST_API_URL (and optionally TEST_TOKEN / TEST_ENROLL_TOKEN) to run it"
fi

hr "RESULT"
if [ "$fail" -eq 0 ]; then echo "✓ all suites passed"; else echo "✗ one or more suites failed"; fi
exit $fail
