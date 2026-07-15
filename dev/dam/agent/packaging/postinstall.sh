#!/bin/sh
# Runs after .deb/.rpm install. Registers the template unit but does NOT start anything — the
# operator picks a mode and fills in its env file first (an unconfigured agent crash-loops).
set -e

systemctl daemon-reload 2>/dev/null || true

cat <<'EOF'

TooVix DAM agent installed (systemd template: dam-agent@<mode>).

Run one agent per mode — they coexist without colliding:

  1) Create the env for a mode (copy the example):
       sudo cp /etc/toovix/agent.env.example /etc/toovix/agent-host.env
       sudo nano /etc/toovix/agent-host.env      # set MODE=host, targets, token, control plane
  2) Start it:
       sudo systemctl enable --now dam-agent@host
  3) Add more modes the same way (own env file each):
       dam-agent@network   (cleartext capture)
       dam-agent@proxy      (inline proxy — set LISTEN_PORT to a free port + UPSTREAM=<db>)
  4) Check:
       systemctl status dam-agent@host   |   journalctl -u dam-agent@host -f

Host (eBPF) mode needs Linux kernel >= 5.8 and runs on the database host itself.
EOF
