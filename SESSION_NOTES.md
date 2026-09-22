# Session Notes — 2026-09-07 / 2026-09-08

Handoff summary for starting a fresh chat. For step-by-step test instructions see `TESTING.md`.

## How to get everything running

```bash
bash scripts/gpu-tunnel.sh          # auto-reconnecting SSH tunnel to the GPU box (own terminal)
npm run start:dev --workspace=api   # API on :3000
npm run dev --workspace=web         # web app on :5173
```

The tunnel drops unpredictably (confirmed several times a session — "Connection reset by peer"
from the remote side). `scripts/gpu-tunnel.sh` is a `while true; do ssh -N ...; sleep 3; done`
loop that reconnects on its own — always use it instead of a bare `ssh` command.

Nothing survives between chat sessions — if you're picking this up fresh, all three of the
above need to be started again (confirmed: a new session found zero of these processes alive).

## Standing constraints (do not violate)

- **Never modify, restart, or install anything on the shared GPU box** (`root@148.251.185.111`).
  Read-only discovery or normal request traffic only. Never touch `/home/ai/voxcpm-clone/` or
  another user's ("ai", "sullis") processes.
- Only commit to git when explicitly asked.
- Never leak the real GPU IP/credentials into committed files (`.env` is gitignored; `.env.example`
  stays generic).

## Live infrastructure facts

- **Qwen 3.5 4B now runs on the DEDICATED `ollama-ascend` instance, port 11435** (tunneled to
  local 21435) — NOT the shared default `ollama.service` (11434), which is contended by another
  tenant's 27B model and was causing total request hangs (not just slowness). `apps/api/.env`:
  `QWEN_BASE_URL="http://127.0.0.1:21435"`. If Qwen ever seems to hang again, check
  `GET http://127.0.0.1:21435/api/ps` — `size_vram` should equal the model's full `size`; if far
  lower, something else is competing for that instance again.
- Uses Ollama's **native** `/api/chat` (not `/v1/chat/completions`) with `"think": false` — ~10x
  faster for this model; the OpenAI-compat layer silently ignores the think flag.
- Cohere STT + VoxCPM2 TTS both live behind one Flask app on port 5001 (same tunnel).
  **`/transcribe` can only handle ONE request at a time** — concurrent calls return HTTP 409.
  Never call it in parallel; always sequential `await`s with per-call error handling.
- OTP dev-bypass code: `000000` (works for any customer) — `apps/api/.env` `OTP_DEV_BYPASS_CODE`.
- 4 seeded demo customers with distinct account/balance/transaction data (re-run `npm run seed`
  if the DB looks empty): `ahmed@example.com`, `sara@example.com`, `mohammed@example.com`,
  `fatima@example.com`.

## What changed this session (chronological, high level)

1. **Voice call UI rewritten from push-to-talk to continuous VAD-based calling.** No button —
   mic opens once per call, `VadCallSession` (`apps/web/src/support/audioCapture.ts`) does
   energy-based voice detection (ported from the GPU box's own reference demo), auto-sends each
   utterance, supports barge-in (talking over the agent interrupts it).
2. **Optimistic/instant message display.** Customer's own message now broadcasts over the socket
   the moment STT finishes, instead of waiting for the full LLM+TTS turn — this is what was
   making the app look "stuck" before.
3. **Language auto-detection, no manual picker.** Every voice utterance is transcribed TWICE
   (English-forced + Arabic-forced, sequentially — see the 409 note above) and a small Qwen call
   judges which is the real transcription (a wrong-language attempt doesn't fail, it hallucinates
   a fluent-sounding sentence in the wrong language, so simple heuristics don't work). Reliability
   improved via a chain-of-thought prompt (ask for one-sentence reasoning before the verdict) —
   not perfect, but solid. See `CallsService.pickSpokenLanguage`.
4. **Reply-language mirroring fix.** The model wasn't reliably switching reply language when the
   customer switched mid-conversation — a system-prompt-level rule lost to several prior turns'
   momentum in the other language. Fix: attach the directive directly onto the *current* message
   being replied to (not stated separately earlier in context) — `OrchestratorService`, right
   before the LLM call. This same "attach to the last message, not the system prompt" technique
   is the one lesson most worth remembering from this session for any future prompt-reliability
   problem with this model.
5. **Auto-hangup.** When the agent decides the conversation is over (`end_call` tool, e.g.
   customer says "thanks, bye"), the backend now finalizes the Call record immediately instead of
   waiting for the customer to click End Call; the widget lets the goodbye audio finish, then
   tears itself down automatically.
6. **Audio-stop-on-end fixes.** Clicking "End Call" previously didn't pause in-flight TTS audio
   (the agent kept talking after the call visibly ended) — fixed. Also fixed a race where a turn
   still in flight when the call ends would resolve afterward and still show/play its response.
7. **Full visual redesign.** Rebuilt `apps/web/src/index.css` as a real design system (navy/slate
   + indigo-blue fintech palette, Inter font, `lucide-react` icons — none existed before), redid
   the admin nav/topbar, login, support/chat/call widgets, and decluttered essentially every admin
   page (color-coded status badges instead of raw enum strings, compact relative dates instead of
   full locale timestamps, truncated IDs, etc.). `apps/web/src/shared/format.ts` +
   `shared/Badge.tsx` are the shared helpers behind this — reuse them for any new admin page.
8. **Transcript-based emotion/sentiment/urgency + TTS style pipeline.** Per explicit spec:
   - `apps/api/src/ai/tts/emotion-style-map.ts` — centralized, single-source-of-truth mapping
     from a controlled emotion vocabulary to a TTS style instruction (customer's emotion is never
     mirrored back — an angry customer gets a calm, de-escalating agent, not an angry one).
   - `OrchestratorService` generates the reply exactly as before (untouched), then makes one
     additional small, tool-free Qwen call to classify `{intent, emotion, sentiment, urgency}`.
   - `VoxCpm2TtsProvider` combines the style with the reply text using VoxCPM2's own documented
     convention: a parenthetical prefix at the very start of the text, e.g.
     `"(calm, empathetic tone)Actual reply..."` — confirmed real via VoxCPM2's GitHub
     README/technical report AND empirically (a short valid prefix produces audio of identical
     duration to no prefix at all).
   - **Important false start, worth knowing**: the first attempt tried to make the *main reply*
     always be a JSON envelope in one combined call — this measurably hurt reliability (more
     escalation fallbacks, one near-miss of showing broken JSON to a customer). Redesigned into
     two separate calls (still just Qwen, no new model) — the main reply can never be corrupted
     by a classification hiccup. Live test result: 5/7 exact matches on the spec's own emotion
     test cases, the other 2 close-but-different (never wrong-direction).

## What changed this session — real PSTN calling (FreeSWITCH + ESL + Connectel)

Added a *second* call transport — real phone calls over a Connectel SIP trunk via FreeSWITCH,
controlled from the existing NestJS process over ESL (Event Socket Library) — alongside the
browser-mic transport above, which is untouched. Off by default (`TELEPHONY_ENABLED=false`);
see `TESTING.md` Test 8 for how to turn it on and test it.

- **No existing FreeSWITCH/ESL/Connectel code was found to reuse** — `C:\Users\MYTM\ascend-collect`
  (initially thought to have this) actually uses a third-party SaaS (autocalls.ai) for its own
  real calling, not self-hosted telephony. The *actual* proven reference turned out to be that
  repo's `localbackend` branch, `esl-bridge/bridge.py` — a working Python ESL bridge for a
  different (debt-collection) product. Its exact ESL command set/turn-taking approach (raw
  socket protocol, `originate ... &park()`, `record`/`playback`/`uuid_break`/`uuid_record` for
  barge-in) was ported to TypeScript; only the AI-pipeline calls differ — PSTN turns call the
  same `CallsService.handleTurn()`/`endCall()` the browser widget already uses, untouched.
- New `apps/api/src/modules/telephony/` module: `esl-protocol.ts` (wire-format parser, shared),
  `esl-client.service.ts` (per-command connections — `bgapi`/`execute`), `esl-event-listener.service.ts`
  (one persistent subscriber connection, auto-reconnects every 3s on drop — same "while true,
  retry" shape as `scripts/gpu-tunnel.sh`), `pstn-call.service.ts` (the actual per-call state
  machine: record → RMS-poll for end-of-speech → `handleTurn()` → synthesize → playback, with
  concurrent-`uuid_record`-based barge-in). No `modesl`/library dependency — raw `net.Socket`,
  matching the reference (which also doesn't use one).
- `Call` gained `transport` (`WEBRTC`|`PSTN`), `fromNumber`, `toNumber`, `providerCallUuid`
  (additive Prisma migration, default `WEBRTC` — every existing row/behavior unchanged).
  `CallsService.startCall` was refactored (Call+Conversation creation extracted into a shared
  private helper) so both transports create identical DB history — no behavior change to the
  browser path, verified by diff.
- `CampaignSchedulerService` now dials a real number via `PstnCallService` when
  `TELEPHONY_ENABLED=true` **and** the customer has a phone on file; otherwise falls back to
  exactly the prior simulated behavior. Same for callback scheduling.
- `infra/freeswitch/` — a local-dev Docker Compose FreeSWITCH, overlaying only two small files
  onto the stock image's own config (a Connectel `<gateway>` XML and a public-context
  `answer`+`park` dialplan extension) rather than replacing the whole `/etc/freeswitch` tree.
  Not a hard dependency — the same conf files work on a native/systemd FreeSWITCH install too.
- **Live-validated the ESL wiring** (handshake, event subscribe/dispatch, inbound-call handling,
  correct `record` command framing) end-to-end against a throwaway fake ESL TCP server standing
  in for FreeSWITCH — confirmed the full pipeline runs with no errors, including real DB writes
  (customer lookup/creation, Call/Conversation rows). Could not validate an actual live phone
  call — no real Connectel trunk credentials were available this session, and (separately) a
  Windows dev machine behind NAT generally can't receive inbound SIP/RTP from a real trunk
  without port-forwarding or hosting FreeSWITCH somewhere reachable — noted in `TESTING.md`.

## Known limitations / things to watch

- VoxCPM2's own docs say style/voice-design results "can vary between runs" — don't expect
  perfectly consistent tone every time.
- Qwen 3.5 4B's classification (language pick, emotion, reply-language) is good but not perfect —
  small-model instruction-following has a real, non-zero failure rate. Everything that depends on
  it has a safe fallback (never shows broken JSON/raw structure to a customer).
- Noticed but NOT fixed (unrelated, pre-existing): some replies containing transaction amounts
  occasionally render with garbled Unicode currency symbols — a model quirk, not touched.
- LiveKit is still unused scaffolding, unrelated to either voice transport (browser-mic REST
  turns, or the new PSTN/FreeSWITCH path) — see the new section above.
- Real PSTN calling is built and wired but not yet live-call-verified — needs real Connectel
  credentials and (likely) FreeSWITCH hosted somewhere network-reachable; see `TESTING.md` Test 8.

## Memory files (already loaded automatically each session)

`project_architecture_decisions.md`, `credentials_guidance.md`, `user_wants_production_polish.md`
in the assistant's memory directory carry the same information in more detail plus older context
(stack choices, earlier bug fixes). This file is a standalone snapshot for your own reference —
memory will keep working even without it.
