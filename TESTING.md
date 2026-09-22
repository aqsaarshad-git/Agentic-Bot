# Testing Guide

Simple, click-through test cases — no API calls needed for any of this except the
one optional section at the end.

## Start everything

```
npm run start:dev --workspace=api    # API on :3000
npm run dev --workspace=web          # Admin + chat on :5173
npm run seed                         # only if the database looks empty
```

- Admin console: http://localhost:5173/admin — login `admin@example.com` / `ChangeMe123!`
- Customer support page: http://localhost:5173/support
- Demo customers (seeded, each with their own distinct balance/transactions):

  | Name | Email | Phone | Balance | Notable |
  |---|---|---|---|---|
  | Ahmed Al-Rashid | ahmed@example.com | +966501234567 | 1,250.75 SAR | Has a FAILED transaction (insufficient funds) |
  | Sara Al-Fahad | sara@example.com | +966502345678 | 8,340.20 SAR | Healthy account, all COMPLETED |
  | Mohammed bin Khalid | mohammed@example.com | +966503456789 | 340.00 SAR | Business account, PENDING + FAILED (card expired) |
  | Fatima Al-Zahra | fatima@example.com | +966504567890 | 12.40 SAR | Account SUSPENDED |

  Any full name works at identify time — the email/phone is what looks up the seeded
  account. For OTP, either use the code shown on screen in dev mode, or the **fixed test
  code `000000`** (works for any account) — set via `OTP_DEV_BYPASS_CODE` in
  `apps/api/.env`, dev/test only, remove it before any real deployment.

**Real AI vs. mock**: `apps/api/.env` currently points at the real Qwen 3.5 / Cohere
Transcribe Arabic / VoxCPM2 GPU deployment. That only works while the tunnel is running —
use the self-healing supervisor instead of a plain `ssh` command, since the connection has
been observed dropping unpredictably:

```
bash scripts/gpu-tunnel.sh
```

(It auto-reconnects on its own if the tunnel drops — just leave it running in its own
terminal.) Qwen 3.5 4B is loaded on a dedicated Ollama instance (port 11435) that's
reserved for this project and always kept resident in VRAM, so it isn't affected by
whatever else is running on that shared GPU box.

Real replies typically land in well under 5 seconds — the LLM adapter talks to Ollama's
native API with reasoning/"thinking" mode off, which is ~10x faster than the
OpenAI-compatible endpoint for this model, and the dedicated instance means no waiting on
other workloads. If replies ever start timing out (~90s) and falling back to "connect me
with a human" again, check `GET http://127.0.0.1:21435/api/ps` — `qwen3.5:4b` should show
`size_vram` equal to its full model size; if it's much lower, something else is now
competing for that instance and someone needs to look at it. Either way the app times out
gracefully rather than hanging. For fast, predictable testing instead, set
`LLM_PROVIDER=mock`, `STT_PROVIDER=mock`, `TTS_PROVIDER=mock` in `apps/api/.env` and
restart the API.

---

## Test 1 — Chat with the AI as a customer

1. Open the support page, enter a name and an email or phone number.
2. Enter the 6-digit code (shown on screen in dev mode).
3. Type: **"I want to know why my payment failed."**
4. ✅ You get a reply — with real AI, it should name the actual failed transaction and why.
5. Type: **"I need to speak to a human."**
6. ✅ The reply hands you off gracefully and the status badge changes to `ESCALATING`.

---

## Test 2 — Call the AI as a customer (voice)

This is a real, hands-free call — no button to hold. The mic opens once and stays open;
voice activity detection (VAD) figures out when you start and stop talking, the same
energy-based approach the GPU box's own reference demo uses.

1. On the support page, click the **📞 Call** tab.
2. Click **Start Call**. Allow microphone access when your browser asks.
3. ✅ The status pill turns green ("Listening — just start talking") — just speak, e.g.
   *"What's my account balance?"*. No button.
4. ✅ While you're talking the pill turns blue ("Hearing you…") and the level bar under it
   moves with your voice — visible proof the app is picking you up.
5. Stop talking and wait about a second. ✅ The pill turns amber ("Thinking…"), then your
   own words appear as text in the transcript, then the agent's reply text appears, then
   you **hear the agent's voice** (now boosted client-side — should be clearly audible,
   not faint).
6. Try barge-in: while the agent is still talking (purple pill), just start speaking over
   it. ✅ Playback stops immediately — no button, exactly like interrupting someone on a
   real phone call.
7. Try **Mute**: click it, then talk — ✅ nothing happens (VAD is paused). Click **Unmute**
   and it resumes listening.
8. Try switching languages mid-call: say one sentence in English, then (without restarting
   anything — there's no language picker) say the next one in Arabic. ✅ The transcript
   shows each utterance correctly in the language it was actually spoken in, and the
   agent's reply follows along in the same language each time — it's detected fresh per
   utterance, not fixed for the whole call.
9. Click **End Call**.
10. In the admin console, go to **Calls** — ✅ your call is listed with a duration and
   outcome, linking to the full transcript (everything you said and the agent said, in
   text, exactly as shown live during the call).

---

## Test 3 — Tools, tickets, and staff (admin)

1. **Human Agents** → create a staff account (role `AGENT`).
2. **Tickets** → find a ticket from Test 1, assign it to that agent. ✅ Status moves
   `NEW → OPEN` automatically.
3. Click **Notes** on that ticket, add one. ✅ It appears immediately.
4. **Tools** → disable `get_balance`. Back in chat, ask "what's my balance?" — ✅ you get a
   generic answer, not a number. Re-enable it and ask again — ✅ now you get a real answer.

---

## Test 4 — Knowledge base and escalation queue (admin)

1. **Knowledge Base** → publish a short document (e.g. a two-paragraph refund policy),
   status `PUBLISHED`.
2. In chat, say something that should escalate (e.g. "this is taking forever, get me a
   human"). ✅ Status becomes `ESCALATING`.
3. **Escalations** → find that conversation. ✅ It shows an AI-written one-line summary —
   you shouldn't need to re-read the transcript to know what happened.
4. Click **Mark resolved**. ✅ It disappears from the queue.

---

## Test 5 — Outbound campaigns and callbacks (admin)

1. **Campaigns** → create one (e.g. "Payment Reminder"), pick a customer, set it **ACTIVE**.
2. Wait about 30 seconds. ✅ The campaign's contact count moves to "in progress" — a call
   was placed automatically with your script as the opening line.
3. **Callbacks**: in chat as a customer, ask *"call me back today about a charge"*. ✅ A
   callback appears in the admin **Callbacks** page and gets called automatically once its
   time arrives (same 30-second scheduler).

---

## Test 6 — Analytics (admin)

1. **Analytics**. ✅ You see real counts (conversations, calls, tickets), an escalation
   rate, tool success/failure breakdown, and average response times — all computed from
   what you just did in the tests above, not sample data.

---

## Test 7 — Emotion/sentiment detection and the agent's tone

The AI reads the customer's own words (never the audio itself — this is transcript-based, not
voice-tone detection) and classifies emotion/sentiment/urgency, which (a) shows up right under
the agent's reply so you can see what was detected, and (b) on a **call**, picks a matching
spoken tone for the agent — an angry customer gets a calm, de-escalating agent, never an angry
one back.

1. In **chat**, type: **"My payment failed again! This is ridiculous."**
   ✅ Under the agent's reply bubble, a small line reads something like
   *"Detected: frustrated · negative · high urgency"*.
2. Type: **"Thank you! That solved my problem."**
   ✅ The detected line now flips to something like *"Detected: happy · positive"* — it's
   re-classified fresh every turn, not stuck on the earlier frustration.
3. In a **call**, say something clearly frustrated (e.g. *"why does my payment keep
   failing, this is so annoying"*). ✅ The transcript shows the same "Detected: ..." line
   under the agent's turn, and — listen for it — the agent's **voice** should sound
   noticeably calmer/more measured than its normal neutral tone, not matching your
   frustration.
4. Say something clearly positive (e.g. *"perfect, thank you so much"*).
   ✅ The agent's tone should sound warmer/more upbeat than the neutral baseline.

**Caveats to know going in**: this is a 4B model doing the classification, so it won't be
perfect every time — expect it to occasionally pick an adjacent label (e.g. "frustrated"
instead of "angry") rather than the exact one you'd expect; it should never be wrong-direction
(never "happy" for something clearly angry). The TTS tone shift is also not guaranteed
identical every time you repeat the same test — VoxCPM2's own documentation notes its style
control "can vary between runs." If you don't see a "Detected: ..." line at all on some turns,
that's the safe fallback kicking in (the model didn't produce a usable classification for that
specific turn) — nothing is broken, it just defaults to a neutral/professional tone.

---

## Test 8 — Real phone calls (FreeSWITCH + Connectel)

Off by default (`TELEPHONY_ENABLED=false`) — everything above (browser calls, campaigns,
callbacks) works exactly the same whether or not this is set up. This test is only relevant
once you actually want to place/receive a real PSTN call.

1. Fill in real Connectel trunk credentials:
   `cp infra/freeswitch/.env.example infra/freeswitch/.env` and fill it in, and set the
   matching `CONNECTEL_*`/`FREESWITCH_ESL_PASSWORD` values in `apps/api/.env` (same values,
   both places).
2. Start FreeSWITCH: `cd infra/freeswitch && docker compose up` (Docker Desktop must be
   running). ✅ Logs show it starting with no XML parse errors. Confirm the gateway
   registered: `docker compose exec freeswitch fs_cli -x "sofia status gateway connectel"`
   — ✅ state is `REGED` (or `NOREG` if Connectel authenticates by IP instead of
   registration — see the comment in `connectel.xml.template`).
3. Set `TELEPHONY_ENABLED=true` in `apps/api/.env` and restart the API. ✅ Log line reads
   `ESL event listener subscribed` (not a repeating `ECONNREFUSED` warning — if you see
   that, FreeSWITCH isn't reachable yet at `FREESWITCH_ESL_HOST:FREESWITCH_ESL_PORT`).
4. **Outbound**: as an admin/agent, `POST /calls/dial-out` with
   `{ "customerId": "<id>", "phoneNumber": "+9665XXXXXXXX" }` (a seeded demo customer ID
   works fine). ✅ The phone rings, answering it starts the same STT→LLM→TTS turn loop as a
   browser call — talk, get a spoken reply, try barge-in by talking over it. Hang up.
5. **Inbound**: call your Connectel number from a real phone. ✅ FreeSWITCH answers, and the
   same turn loop starts — a new `Customer` is created automatically from your caller ID if
   one doesn't already exist for that number.
6. In the admin **Calls** page: ✅ the call you just made/received shows a **Channel** column
   with the phone number (not "Browser"), and the transcript link works exactly the same as
   for a browser call.

If you only want to exercise the ESL/record/playback loop without a real trunk yet, you can
register a softphone (e.g. Zoiper/Linphone) as a FreeSWITCH internal extension and dial it via
`POST /calls/dial-out` — everything except the actual Connectel hop is identical.

---

## Optional — testing the voice pipeline without a browser mic

If you want to test a call turn directly (e.g. to isolate a backend issue from a browser
issue), the API accepts a call turn as JSON instead of a live microphone: `POST
/calls/:id/turns` with `{ "audioBase64": "<base64-encoded WAV audio>" }`. You don't need
this for normal testing — Tests 1–6 above cover everything through the UI.

---

## Known limitations right now

- LiveKit is still unused scaffolding — no live LiveKit server is connected, and it's not
  part of the real-time audio path for either the browser-mic flow (Test 2) or real PSTN
  calls (Test 8), which have their own separate transports.
- Real PSTN calling (Test 8) needs Connectel to reach FreeSWITCH's SIP+RTP ports — on a
  machine behind NAT (e.g. this dev laptop without port-forwarding) that generally means
  hosting FreeSWITCH somewhere network-reachable rather than purely `localhost`; the
  `infra/freeswitch/docker-compose.yml` config itself works either way.
- PSTN turn-boundary detection (and barge-in) is RMS-energy polling of the recording file,
  not a trained VAD model — coarser than the browser's own VAD, tunable via the constants at
  the top of `pstn-call.service.ts` if it feels too trigger-happy or too slow to cut in.
- The GPU box behind real Qwen/Cohere/VoxCPM2 is shared with other people's own work —
  expect variable latency and occasional timeouts (handled gracefully, see above).
- Customer OTP codes are kept in memory on the API process — restarting the API
  invalidates any codes mid-verification.
- Knowledge-base search is keyword matching, not semantic search (no embedding model is
  part of the mandated stack).
