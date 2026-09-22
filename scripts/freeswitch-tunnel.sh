#!/usr/bin/env bash
# Keeps the SSH tunnel to the shared FreeSWITCH/telephony-worker box (root@192.168.5.133) alive.
# Two directions in one session, same "just restart our own ssh client on drop" philosophy as
# scripts/gpu-tunnel.sh:
#   -L 18005:127.0.0.1:8005   this machine -> the worker's HTTP server (originate a call)
#   -R 13000:127.0.0.1:3000   the box -> this machine's API (turn/end/greeting/inbound-answer)
# apps/api/.env's TELEPHONY_WORKER_URL should point at http://127.0.0.1:18005 (the -L side);
# telephony-worker/worker.env's API_BASE_URL should point at http://127.0.0.1:13000 (the -R
# side, as seen FROM the box).
while true; do
  ssh -N \
    -L 18005:127.0.0.1:8005 \
    -R 13000:127.0.0.1:3000 \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    root@192.168.5.133
  echo "$(date '+%Y-%m-%d %H:%M:%S') tunnel dropped (exit $?), reconnecting in 3s..." >&2
  sleep 3
done
