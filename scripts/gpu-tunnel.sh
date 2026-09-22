#!/usr/bin/env bash
# Keeps the SSH port-forward to the shared GPU box (root@148.251.185.111) alive.
# The remote side has been intermittently resetting the connection ("Connection reset by
# peer") several times per hour during testing — this only restarts our own local ssh
# client when that happens; it never touches anything on the remote box itself.
while true; do
  ssh -N \
    -L 21435:127.0.0.1:11435 \
    -L 5001:127.0.0.1:5001 \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    root@148.251.185.111
  echo "$(date '+%Y-%m-%d %H:%M:%S') tunnel dropped (exit $?), reconnecting in 3s..." >&2
  sleep 3
done
