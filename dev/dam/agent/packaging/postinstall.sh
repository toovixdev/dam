#!/bin/sh
# Runs after .deb/.rpm install. Registers the unit but does NOT start it — the operator must
# fill in /etc/toovix/agent.env first (an unconfigured agent would just crash-loop on enroll).
set -e

systemctl daemon-reload 2>/dev/null || true

cat <<'EOF'

TooVix DAM agent installed.

  1) Edit /etc/toovix/agent.env
       MODE, DB_ENGINE, TARGET_HOST/PORT, AGENT_ENROLL_TOKEN, CONTROL_PLANE
  2) Start it:
       sudo systemctl enable --now dam-agent
  3) Check it:
       systemctl status dam-agent   |   journalctl -u dam-agent -f

Host (eBPF) mode needs Linux kernel >= 5.8 and runs on the database host itself.
EOF
