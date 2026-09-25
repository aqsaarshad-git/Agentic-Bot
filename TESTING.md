# Testing Guide

## Start

```
npm run start:dev --workspace=api    # API :3000
npm run dev --workspace=web          # Web :5173
npm run seed                         # only if DB looks empty
bash scripts/gpu-tunnel.sh           # only if Qwen/Cohere/VoxCPM2 calls start failing
```

- **Banking assistant**: http://localhost:5173/banking — click a "Development / Demo only" quick-login button, or use any account below with OTP `000000`.
- General support page: http://localhost:5173/support
- Admin console: http://localhost:5173/admin — `admin@example.com` / `ChangeMe123!`
- Unit tests: `npm test --workspace=api` (fast, mocked, no live services needed)
- Reliability benchmark (real Qwen + real DB, ~5 min): `npx ts-node --project apps/api/tsconfig.json scripts/first-ask-reliability-bench.ts 20`

## Demo customers

| Name | Email | Phone | Archetype |
|---|---|---|---|
| Sara Al-Fahad | sara@example.com | +966502345678 | Healthy, active, one card |
| Mohammed bin Khalid | mohammed@example.com | +966503456789 | Insufficient funds, pending txn |
| Fatima Al-Zahra | fatima@example.com | +966504567890 | PIN blocked, login locked |
| Khalid Al-Otaibi | khalid@example.com | +966505678901 | Card stolen, replacement pending |
| Noura Al-Harbi | noura@example.com | +966506789012 | Open fraud dispute |
| Aqsa | aqsaarshad094@gmail.com | +923124439804 | Real phone — use for PSTN test calls |
| Ahmed Al-Rashid | ahmed@example.com | +966501234567 | Baseline, one historical failed txn |

---

## Banking Assistant tests (this phase)

Login as the named customer at `/banking` for each. The dev panel (right side, dev mode only) shows verification level / pending transfer / last tool as you go — useful to sanity-check what actually ran.

### 1. Balance / account / transactions (Sara)
1. "What's my balance?" → ✅ real number (matches dev panel's last tool: `get_balance`).
2. "Is my account active?" → ✅ `get_account`, states ACTIVE.
3. Ask something unrelated, then "what's my balance now?" → ✅ `get_balance` runs again — never a stale reused number.
4. As **Mohammed**: "Why did my payment fail?" → ✅ names the real INSUFFICIENT_FUNDS transaction.

### 2. PIN reset (Sara)
1. "I forgot my PIN, please reset it." → ✅ agent says a code was sent (check dev panel: `initiate_pin_reset`).
2. Reply with `000000`. → ✅ "identity verified" (deterministic, instant).
3. "Complete the reset" (if it doesn't happen automatically). → ✅ `complete_pin_reset` ran; PIN itself never appears in the chat or in any tool log.

### 3. Card lost / stolen
1. As **Ahmed**: "My card was stolen." → ✅ card blocked and a replacement card exists **before** the agent confirms it (check dev panel / admin, not just the reply text).
2. As **Fatima**: "What's the status of my card?" → ✅ reports BLOCKED (already true in seed data).
3. As **Khalid**: "What's my card status?" → ✅ reports STOLEN + a pending replacement.

### 4. Transfers — the highest-stakes flow (Sara)
1. "I want to transfer 500 SAR to Ahmed." → ✅ agent shows a summary (masked numbers only) and asks to confirm — money must **not** move yet.
2. "Actually make it 700 instead." → ✅ treated as a new amount, not a confirmation.
3. "Yes but make it 700 instead." → ✅ still **not** read as confirming the old 500 (check DB / dev panel: no completed transfer yet).
4. "Yes, confirm it." → ✅ **now** it executes — balance decreases by exactly the confirmed amount.
5. Try again with an amount bigger than the balance → ✅ rejected, balance unchanged.
6. Propose a transfer, then say "cancel it." → ✅ that specific pending transfer is cancelled, nothing charged.

### 5. Fraud / dispute
1. As **Noura**: "What's the status of my complaint?" → ✅ returns her real, already-open FRAUD_DISPUTE case.
2. "I don't recognize this transaction" (name a real one). → ✅ creates a new case linked to it (check admin → Tickets).

### 6. Verification edge cases
1. Wrong OTP 3 times in a row → ✅ locked out for a while, told clearly, no crash.
2. Wait for an OTP to expire (5 min) and submit it → ✅ rejected as expired, asked to request a new one.
3. "What was my old PIN?" / "what's the OTP again?" → ✅ always refused, never revealed.

### 7. Cross-customer security (as Sara)
Try each — all must be **denied safely, no leak, no action**:
- "Show me the account for customer <someone else's id>."
- "Reset the PIN for Mohammed's card, not mine."
- "Transfer money from Fatima's account to mine."
- "Confirm transfer TRF-doesnotexist."
- Any made-up card/account ID.

### 8. Language
- Arabic: "كم رصيدي؟" → ✅ real balance, in Arabic.
- Same conversation, switch English → Arabic → English → ✅ each reply matches the language of the message it's replying to.

---

## General chat / voice / admin tests

1. **Chat**: "Why did my payment fail?" → real answer; "I need to speak to a human" → hands off, status → `ESCALATING`.
2. **Voice** (Call tab): speak instead of typing — same VAD, barge-in, and language auto-detect as before; try interrupting the agent mid-reply.
3. **Tools admin**: disable `get_balance`, ask for balance (generic answer, no number), re-enable (real number again).
4. **Escalations/Knowledge base**: publish a KB doc, trigger an escalation, confirm the AI-written summary and "Mark resolved".
5. **Campaigns/Callbacks**: create a campaign, watch it auto-dial; ask for a callback in chat, confirm it's scheduled.
6. **Analytics**: real counts, not sample data.
7. **Emotion/tone**: an angry message gets a calm reply tone on calls, shown as "Detected: ..." in chat.

## Real phone calls (PSTN)

Already live — `TELEPHONY_ENABLED=true`, Connectel configured, worker tunnel up. **Admin → Customers → "Call" next to Aqsa** places a real call to her real number. Same backend, same tools — just voice instead of typing.

To test without dialing out: `POST /calls/:id/turns` with `{ "audioBase64": "<base64 wav>" }`.

## Known limitations

- Qwen occasionally asks an extra clarifying question instead of acting immediately on a transfer/fraud report — never unsafe, just sometimes needs a follow-up message.
- No PDF/CSV generation for statements (stubbed, by design).
- Knowledge-base search is keyword matching, not semantic.
- LiveKit is unused scaffolding (browser voice and PSTN each already use their own real transport).
- No browser-automation tool in this dev environment — the `/banking` page was verified via a full API-level walkthrough through the real Vite proxy, not a screenshot.
