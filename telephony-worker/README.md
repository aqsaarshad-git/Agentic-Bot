# telephony-worker

FreeSWITCH/ESL bridge for real PSTN calling — see `apps/api/src/modules/telephony/pstn-call.service.ts`
for why this is a separate process instead of living in the main API. Deployed on whatever box
actually holds the live SIP trunk (currently `192.168.5.133`), not on the same machine as the API.

## Deploy

```bash
scp worker.js worker.env.example telephony-worker.service root@<box>:/home/sip/agentic-support-telephony/
ssh root@<box>
cd /home/sip/agentic-support-telephony
cp worker.env.example worker.env   # fill in real values — TELEPHONY_WORKER_SECRET must match apps/api/.env
chown -R sip:sip /home/sip/agentic-support-telephony
cp telephony-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now telephony-worker
journalctl -u telephony-worker -f   # watch it come up
```

## Reach it from the API side

`scripts/freeswitch-tunnel.sh` (run on the same machine as the API) opens both directions this
needs in one SSH session: the API calling the worker's `/originate`, and the worker calling back
into the API's `/telephony/worker/*` routes. Run it in its own terminal alongside the API, the
same way `scripts/gpu-tunnel.sh` is already used for the GPU box.

## Multi-tenant box note

This FreeSWITCH instance may be shared with other products (ESL event subscriptions are global,
not scoped to a gateway or DID) — `INBOUND_DIDS` in `worker.env` is what keeps this worker from
claiming calls that belong to someone else's product on the same box. Always set it to the exact
DIDs this project owns.
