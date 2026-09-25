#!/usr/bin/env node
'use strict';

/**
 * telephony-worker — FreeSWITCH/ESL bridge for the Agentic Customer Support project.
 *
 * Deployed ON the box that holds the live Connectel SIP trunk (FreeSWITCH's ESL is firewalled
 * to loopback-only there, and record/playback WAV files have to be on the same filesystem
 * FreeSWITCH itself writes/reads — neither holds for the main NestJS API, which runs
 * elsewhere). This process owns all of that: the ESL connection, the record → detect-silence →
 * playback turn loop, and barge-in. It has NO database access and NO AI-pipeline logic of its
 * own — every actual "what do we say back" decision is one HTTP call to the main API's
 * telephony-worker.controller.ts (POST /telephony/worker/calls/:id/turn), which runs the exact
 * same CallsService.handleTurn() the browser call widget already uses.
 *
 * Ported from a proven reference (ascend-collect/esl-bridge/bridge.py, `localbackend` branch —
 * a working FreeSWITCH+ESL+Connectel bridge for a different product on this same box): the raw
 * ESL protocol (no client library), `originate ... &park()`, and the
 * record/RMS-poll/uuid_break/playback/uuid_record-for-barge-in turn-taking approach are all the
 * same techniques, just calling this project's own API instead of that product's.
 *
 * No external npm dependencies — only Node built-ins (net, http, fs, crypto). Node 18+ (built-in
 * fetch) required; the box this ships to runs Node 20.
 *
 * Run: node worker.js   (see worker.env.example for config; auto-loaded from worker.env next to
 * this file, same convention as bridge.env). Production: telephony-worker.service (systemd).
 */

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────────────────────

loadEnvFile(path.join(__dirname, 'worker.env'));

const ESL_HOST = process.env.ESL_HOST || '127.0.0.1';
const ESL_PORT = parseInt(process.env.ESL_PORT || '8021', 10);
const ESL_PASSWORD = process.env.ESL_PASSWORD || 'ClueCon';
const WORKER_PORT = parseInt(process.env.WORKER_PORT || '8005', 10);
const WORKER_BIND = process.env.WORKER_BIND || '127.0.0.1'; // loopback-only by default — reach it via the SSH tunnel, not the open network
const API_BASE_URL = (process.env.API_BASE_URL || 'http://127.0.0.1:13000').replace(/\/$/, '');
const WORKER_SECRET = process.env.TELEPHONY_WORKER_SECRET || '';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/tmp';
const SIP_GATEWAY = process.env.SIP_GATEWAY || 'connecttel';
const INBOUND_DIDS = (process.env.INBOUND_DIDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const RECORD_MAX_SECS = 30;
const RECORD_POLL_MS = 100;
const RECORD_RMS_THRESHOLD = 150;
const RECORD_SPEECH_CONFIRM_MS = 200;
const RECORD_END_SILENCE_MS = 1200;
const RECORD_MAX_SILENCE_WAIT_MS = 10_000;

const BARGEIN_POLL_MS = 50;
const BARGEIN_GRACE_MS = 500;
const BARGEIN_RMS_THRESHOLD = 350;
const BARGEIN_CONFIRM_MS = 180;

// BUG FIX (2026-09-17 — recurring "auto-ended, no response" reports): a turn request that fails
// at the network level (the freeswitch-tunnel.sh reverse SSH tunnel to the API dropping mid-turn
// — the SAME kind of transient blip already documented for the OTHER SSH tunnel, gpu-tunnel.sh,
// and for the /end notification's own callApiWithRetry below) used to go straight to uuid_kill
// with zero retry, hanging up on the customer for what is usually a few-second network hiccup
// that resolves on its own. Confirmed live (2026-09-17): turn request sent, "fetch failed" ~9s
// later (no HTTP response at all — a connection-level failure, not the API rejecting anything),
// zero audio ever played, call killed. See processTurn's retry loop around streamTurnRequest.
// Matches the tunnel supervisor's own "reconnecting in 3s" cadence (scripts/*-tunnel.sh) — 2
// retries at 3s apart covers a normal reconnect without leaving the customer waiting drastically
// longer than before on the (presumably rarer) case where it's a real, non-transient failure.
const TURN_REQUEST_RETRY_ATTEMPTS = 3; // 1 initial try + 2 retries
const TURN_REQUEST_RETRY_DELAY_MS = 3_000;

// FreeSWITCH's standard telephony recording format here: 8kHz, 16-bit, mono — confirmed live
// against real recordings (2026-09-10). Used to convert a burst of newly-arrived recording
// bytes back into a real duration, since `record`/`uuid_record` do NOT flush to disk in small
// steady increments matching RECORD_POLL_MS/BARGEIN_POLL_MS (confirmed live: `uuid_record` in
// particular arrives in bursts of several seconds' worth of audio every ~4s, not smoothly) —
// see monitorRecording/monitorBargeIn for why this matters.
const PCM_BYTES_PER_MS = 16;

const MAX_SILENCE_STREAK = 2;
const RECONNECT_DELAY_MS = 3_000;
// CHANNEL_EXECUTE added (2026-09-24, real-phone latency investigation): previously only
// CHANNEL_EXECUTE_COMPLETE was subscribed, so the only two timestamps we had for a playback were
// "we asked FreeSWITCH to play" (the eslExecute() ack, logged as "playback start" — which per its
// own doc comment only confirms FreeSWITCH ACCEPTED the command, not that audio is flowing) and
// "it finished". Everything in between was an unmeasured black box despite a comment there
// asserting "actual RTP begins within ms of this" — an assumption, never actually instrumented.
// CHANNEL_EXECUTE fires when FreeSWITCH itself begins EXECUTING the app (i.e. genuinely starts
// producing audio for the channel), giving a real, FreeSWITCH-reported "playback actually began"
// timestamp to compare against the command-accepted one. Audit instrumentation only — nothing
// about playback control flow changes.
const SUBSCRIBED_EVENTS = 'CHANNEL_ANSWER CHANNEL_EXECUTE CHANNEL_EXECUTE_COMPLETE CHANNEL_HANGUP CHANNEL_PARK';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// ── ESL wire protocol ───────────────────────────────────────────────────────────────────────
// header block terminated by a blank line, optionally followed by a Content-Length body.

function parseEslHeaders(text) {
  const headers = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

class EslFrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const messages = [];
    for (;;) {
      const sep = this.buf.indexOf('\n\n');
      if (sep === -1) break;
      const headers = parseEslHeaders(this.buf.subarray(0, sep).toString('utf8'));
      const contentLength = parseInt(headers['Content-Length'] || '0', 10);
      const bodyStart = sep + 2;
      if (this.buf.length < bodyStart + contentLength) break;
      const body = contentLength > 0 ? this.buf.subarray(bodyStart, bodyStart + contentLength).toString('utf8') : '';
      this.buf = this.buf.subarray(bodyStart + contentLength);
      messages.push({ headers, body });
    }
    return messages;
  }
}

function computeRms(chunk) {
  const usable = chunk.length - (chunk.length % 2);
  if (usable < 2) return 0;
  let sumSquares = 0;
  const sampleCount = usable / 2;
  for (let i = 0; i < usable; i += 2) {
    const sample = chunk.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

// ── ESL client — one short-lived, authenticated connection per command ────────────────────────
// (bgapi for async API commands, sendmsg/execute for channel apps) — mirrors the reference
// bridge's _open_esl()/esl_bgapi()/esl_execute() exactly, including opening a fresh connection
// per command rather than sharing one, which avoids any reply-interleaving bugs.

function eslWithConnection(fn, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ESL_HOST, port: ESL_PORT });
    const parser = new EslFrameParser();
    const queued = [];
    const waiters = [];
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(val);
    };

    const readMessage = () =>
      new Promise((res, rej) => {
        const next = queued.shift();
        if (next) return res(next);
        const timer = setTimeout(() => rej(new Error('ESL read timeout')), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          res(msg);
        });
      });

    socket.on('data', (chunk) => {
      for (const msg of parser.feed(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else queued.push(msg);
      }
    });
    socket.on('error', (err) => finish(err));

    const connectTimer = setTimeout(() => finish(new Error(`ESL connect timeout to ${ESL_HOST}:${ESL_PORT}`)), timeoutMs);
    socket.once('connect', async () => {
      clearTimeout(connectTimer);
      try {
        await readMessage(); // initial auth/request banner — content doesn't matter
        socket.write(`auth ${ESL_PASSWORD}\n\n`);
        const authReply = await readMessage();
        if (!(authReply.headers['Reply-Text'] || '').includes('+OK')) {
          throw new Error(`ESL auth failed: ${JSON.stringify(authReply.headers)}`);
        }
        const result = await fn(socket, readMessage);
        finish(null, result);
      } catch (err) {
        finish(err);
      }
    });
  });
}

function eslBgapi(command) {
  return eslWithConnection(async (socket, readMessage) => {
    socket.write(`bgapi ${command}\n\n`);
    const { headers, body } = await readMessage();
    return (headers['Reply-Text'] || body || '').trim();
  });
}

/** Queues a dialplan app on a channel — returns once FreeSWITCH accepts it, NOT once the app
 *  itself finishes (that arrives asynchronously as a CHANNEL_EXECUTE_COMPLETE event on the
 *  separate persistent connection below — see waitForExecuteComplete). */
function eslExecute(uuid, app, arg = '') {
  return eslWithConnection(async (socket, readMessage) => {
    const lines = [`sendmsg ${uuid}`, 'call-command: execute', `execute-app-name: ${app}`];
    if (arg) lines.push(`execute-app-arg: ${arg}`);
    lines.push('event-lock: true', '');
    socket.write(lines.join('\n') + '\n');
    await readMessage();
  });
}

// ── Persistent event listener (auto-reconnecting) ──────────────────────────────────────────

const handlers = new Map(); // fsUuid -> (eventName, headers) => void
let fallbackHandler = null;
let eventSocket = null;

function registerHandler(uuid, handler) {
  handlers.set(uuid, handler);
}
function unregisterHandler(uuid) {
  handlers.delete(uuid);
}

function startEventListener() {
  const parser = new EslFrameParser();
  const socket = net.createConnection({ host: ESL_HOST, port: ESL_PORT });
  let stage = 'banner';

  log(`ESL event listener connecting to ${ESL_HOST}:${ESL_PORT}…`);

  socket.on('data', (chunk) => {
    for (const msg of parser.feed(chunk)) {
      switch (stage) {
        case 'banner':
          stage = 'authReply';
          socket.write(`auth ${ESL_PASSWORD}\n\n`);
          break;
        case 'authReply':
          if (!(msg.headers['Reply-Text'] || '').includes('+OK')) {
            log('ESL auth failed:', JSON.stringify(msg.headers));
            socket.destroy();
            return;
          }
          stage = 'subscribeAck';
          socket.write(`event plain ${SUBSCRIBED_EVENTS}\n\n`);
          break;
        case 'subscribeAck':
          stage = 'events';
          eventSocket = socket;
          log('ESL event listener subscribed');
          break;
        case 'events':
          if (msg.headers['Content-Type'] === 'text/event-plain') dispatch(msg.body);
          break;
      }
    }
  });

  socket.on('error', (err) => log('ESL event socket error:', err.message));
  socket.on('close', () => {
    if (eventSocket === socket) {
      eventSocket = null;
      log('ESL event listener disconnected — reconnecting in 3s');
    }
    setTimeout(startEventListener, RECONNECT_DELAY_MS);
  });
}

function dispatch(body) {
  const evars = parseEslHeaders(body);
  const name = evars['Event-Name'] || '';
  const uuid = evars['Unique-ID'] || '';
  const handler = handlers.get(uuid) || fallbackHandler;
  if (!handler) return;
  try {
    handler(name, evars);
  } catch (err) {
    log('ESL event handler error:', err instanceof Error ? err.message : err);
  }
}

// ── API client (talks back to the main NestJS app) ──────────────────────────────────────────

async function callApi(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telephony-Worker-Secret': WORKER_SECRET },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(90_000), // handleTurn's own STT+LLM+TTS budget can legitimately take a while
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed (HTTP ${res.status}): ${text}`);
  }
  return res.json();
}

/** Same as callApi, but rides out a brief connectivity blip instead of losing the call on the
 *  first try — for calls whose failure isn't just "this one turn didn't happen" but "this
 *  record never gets finalized at all." Confirmed live (2026-09-11): the SSH tunnel to the API
 *  (freeswitch-tunnel.sh) dropped and reconnected — it does that occasionally by design, the
 *  same "just restart our own ssh client" philosophy as gpu-tunnel.sh — and a call's one-shot
 *  end-of-call notification landed in that ~3s reconnect gap and was silently lost, leaving the
 *  Call row open in the database forever with no way to retry later. A handful of retries a
 *  couple seconds apart comfortably rides out that kind of transient drop. */
async function callApiWithRetry(path, body, attempts = 4, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callApi(path, body);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Turn requests use a streamed newline-delimited-JSON response (one line per event) instead of
 * one buffered JSON object — see the API's telephony-worker.controller.ts/pstn-call.service.ts
 * for why: a long reply's audio can take tens of seconds longer to fully render than its first
 * sentence, and `onLine` fires for each line AS IT ARRIVES over the still-open HTTP response, so
 * the caller can start playing chunk 0 immediately instead of waiting for the whole reply.
 */
async function streamTurnRequest(callId, audioBase64, onLine, abortSignal) {
  // A barge-in can fire while this reply is still rendering — see processTurn's abortController
  // — so the timeout and an external "customer already cut in, stop waiting for the rest of
  // this reply" signal both need to be able to end this fetch.
  const signal = abortSignal ? AbortSignal.any([AbortSignal.timeout(90_000), abortSignal]) : AbortSignal.timeout(90_000);
  const res = await fetch(`${API_BASE_URL}/telephony/worker/calls/${callId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telephony-Worker-Secret': WORKER_SECRET },
    body: JSON.stringify({ audioBase64 }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`turn request failed (HTTP ${res.status}): ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(JSON.parse(line));
      }
    }
    if (done) break;
  }
  if (buf.trim()) onLine(JSON.parse(buf));
}

// ── Per-call turn loop ──────────────────────────────────────────────────────────────────────

function newSession(fsUuid, callId) {
  return {
    fsUuid,
    callId,
    turn: 0,
    state: 'answering',
    alive: true,
    finalizedByAgent: false,
    silenceStreak: 0,
    execWaiters: [], // { app, resolve }
    // BUG FIX (2026-09-15 — "first hello sometimes not heard"): default to "no greeting" so
    // onAnswer never has to make its own network call to find out — see originate()/
    // handleInboundAnswer() below, which each set this explicitly before onAnswer ever reads
    // it. Always resolves (never rejects), so onAnswer can safely `await` it unconditionally.
    greetingPromise: Promise.resolve({ audioBase64: null }),
  };
}

function waitForExecuteComplete(session, app) {
  return new Promise((resolve) => session.execWaiters.push({ app, resolve }));
}

function filePath(session, suffix) {
  return path.join(RECORDINGS_DIR, `${session.fsUuid}_${suffix}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statSizeOrNull(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function readNewBytes(file, from, to) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(to - from);
      fs.readSync(fd, chunk, 0, chunk.length, from);
      return chunk;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function onEvent(session, eventName, headers) {
  switch (eventName) {
    case 'CHANNEL_ANSWER':
      // AUDIT INSTRUMENTATION ONLY (2026-09-10 — investigating "first hello not heard"):
      // marks the moment FreeSWITCH itself confirms the channel answered, so we can see how
      // much of the gap before recording starts is greeting-check network time vs ESL/record
      // startup time.
      log(`[LATENCY] CHANNEL_ANSWER received (call:${session.callId}) at ${Date.now()}`);
      onAnswer(session).catch((err) => log(`onAnswer(${session.callId}) failed:`, err.message));
      break;
    case 'CHANNEL_EXECUTE': {
      // AUDIT INSTRUMENTATION ONLY (2026-09-24) — see SUBSCRIBED_EVENTS' doc comment. Only
      // logged for 'playback' (the app this whole investigation cares about) — record/uuid_record
      // also execute on this channel and would just be noise here.
      if (headers['Application'] === 'playback') {
        log(`[LATENCY] CHANNEL_EXECUTE playback (FreeSWITCH actually started it) turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
      }
      break;
    }
    case 'CHANNEL_EXECUTE_COMPLETE': {
      const app = headers['Application'] || '';
      const idx = session.execWaiters.findIndex((w) => w.app === app);
      if (idx !== -1) session.execWaiters.splice(idx, 1)[0].resolve();
      break;
    }
    case 'CHANNEL_HANGUP':
      onHangup(session);
      break;
  }
}

function onHangup(session) {
  session.alive = false;
  unregisterHandler(session.fsUuid);
  if (!session.finalizedByAgent) {
    callApiWithRetry(`/telephony/worker/calls/${session.callId}/end`, {}).catch((err) =>
      log(`end(${session.callId}) failed after retries:`, err.message),
    );
  }
  log(`call ${session.callId} (${session.fsUuid}) cleaned up after ${session.turn} turn(s)`);
}

async function onAnswer(session) {
  session.state = 'greeting';
  // FreeSWITCH's recording (both the `record` app used for the caller's turn, and `uuid_record`
  // used concurrently during playback for barge-in detection — see monitorBargeIn) mixes BOTH
  // directions into the file by default: what we're PLAYING to the caller as well as what we're
  // hearing FROM them. Without this, the barge-in monitor's RMS check was picking up the agent's
  // own TTS audio (as recorded back off the same channel) and misreading it as the caller
  // interrupting — confirmed as the root cause of playback stopping after only ~2-3 words once
  // segment playback started firing the grace-period/confirm-window check against real content
  // almost immediately (see PCM_SEGMENT_TARGET_MS in pstn-call.service.ts: audio now starts
  // ~250ms into a turn instead of ~6s, so what used to be silent dead air during the grace
  // period is now the agent's own live speech). RECORD_READ_ONLY restricts every recording on
  // this channel, for the rest of the call, to the caller's true incoming audio only — set once,
  // before the first `record`/`uuid_record start` ever runs.
  await eslBgapi(`uuid_setvar ${session.fsUuid} RECORD_READ_ONLY true`).catch((err) =>
    log(`failed to set RECORD_READ_ONLY on ${session.fsUuid}: ${err.message}`),
  );
  // BUG FIX (2026-09-24, real-phone latency investigation): `enable_file_write_buffering`
  // defaults to true in FreeSWITCH and is exactly the mechanism behind the bursty (not
  // steady-per-RECORD_POLL_MS) file growth already noted above monitorRecording/monitorBargeIn
  // ("confirmed live 2026-09-10... arrives in bursts of several seconds' worth of audio") — it
  // batches recorded PCM in an internal buffer (SWITCH_DEFAULT_FILE_BUFFER_LEN) before ever
  // calling write(), so our poll-the-growing-file VAD can only SEE trailing silence once that
  // buffer happens to flush, not when it actually occurred. Confirmed against FreeSWITCH's own
  // docs (developer.signalwire.com/.../enable_file_write_buffering): disabling it is the
  // documented fix for exactly this "record app, need real-time access to the growing file"
  // case. This does not touch RECORD_END_SILENCE_MS, the RMS thresholds, or FreeSWITCH's own
  // record/uuid_record apps themselves — it only stops FreeSWITCH from sitting on already-
  // recorded silence before our poller can act on it, which is a real, possibly multi-second
  // contributor to physical-speech-end -> VAD-end-of-speech latency that up to now nothing in
  // this codebase had actually eliminated (only worked around, per the comments above). Set
  // once per call, before the first `record`/`uuid_record start` ever runs, same as
  // RECORD_READ_ONLY.
  await eslBgapi(`uuid_setvar ${session.fsUuid} enable_file_write_buffering false`).catch((err) =>
    log(`failed to disable file write buffering on ${session.fsUuid}: ${err.message}`),
  );
  try {
    // BUG FIX (2026-09-15 — "first hello sometimes not heard"): this used to be `await
    // callApi(...)` right here, meaning recording could not arm until a fresh HTTP round trip
    // to the main API (over the SSH tunnel, cross-machine, variable latency — the same tunnel
    // confirmed to drop/stall unpredictably elsewhere in this project) had finished. That put a
    // genuinely slow, external network call directly in the critical path between "caller
    // answered" and "we're listening" — exactly the kind of gap a caller who says "hello"
    // immediately on pickup can speak into before it closes. The greeting lookup is now kicked
    // off as early as possible — in parallel with dialing for outbound (originate() below), or
    // right at answer for inbound (handleInboundAnswer below, since every call now always gets a
    // real greeting — see getGreetingAudio's doc comment in pstn-call.service.ts) — and simply
    // awaited here: for outbound calls it has almost always already resolved by the time the
    // callee actually answers (the ring itself takes seconds — far longer than one API round
    // trip); inbound still pays that round trip since there's no ringing window to hide it in,
    // but recording only arms after it resolves either way, so the agent always speaks first.
    const greeting = await session.greetingPromise;
    // AUDIT INSTRUMENTATION (2026-09-10, still useful post-fix): how long recording had to wait
    // on the greeting lookup — should now read ~0ms in the common case instead of a real
    // network round trip.
    log(`[LATENCY] greeting check resolved, hasGreeting=${Boolean(greeting && greeting.audioBase64)} (call:${session.callId}) at ${Date.now()}`);
    if (greeting && greeting.audioBase64) {
      const greetingFile = filePath(session, 'greeting.wav');
      fs.writeFileSync(greetingFile, Buffer.from(greeting.audioBase64, 'base64'));
      await playbackAndWait(session, greetingFile, 'greeting');
    }
  } catch (err) {
    log(`greeting playback failed, continuing without it: ${err.message}`);
  }
  if (!session.alive) return;
  await startRecording(session);
}

async function startRecording(session) {
  if (!session.alive) return;
  session.turn += 1;
  session.state = 'recording';
  const recFile = filePath(session, `input_${session.turn}.wav`);

  const done = waitForExecuteComplete(session, 'record');
  // silence_hits is set absurdly high (999) so FreeSWITCH's own auto-stop never fires first —
  // monitorRecording() below decides the turn boundary itself and calls uuid_break.
  await eslExecute(session.fsUuid, 'record', `${recFile} ${RECORD_MAX_SECS} 200 999`);
  // AUDIT INSTRUMENTATION ONLY (2026-09-10 — investigating "first hello not heard"): FreeSWITCH
  // has now accepted the record command and is capturing — this is the true "we're listening"
  // moment, whatever ran before it (greeting check, ESL round trip) is dead air the caller could
  // have spoken into with nothing recording.
  log(`[LATENCY] recording armed, turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
  const monitor = monitorRecording(session, recFile);
  await done;
  await monitor.catch(() => undefined);

  if (!session.alive) return;
  await processTurn(session, recFile);
}

async function monitorRecording(session, file) {
  let bytesRead = 44; // skip the WAV header
  let speechStarted = false;
  let speechConfirmMs = 0;
  let silenceMs = 0;
  let noSpeechMs = 0;
  let totalMs = 0;
  // Mirrors FreeSWITCH's own hard record cap (RECORD_MAX_SECS above) so this loop can't outlive
  // the actual recording if that safety net fires before our own RMS logic ever does.
  const hardDeadlineMs = RECORD_MAX_SECS * 1000 + 1_000;
  const windowBytes = RECORD_POLL_MS * PCM_BYTES_PER_MS;

  while (session.alive && session.state === 'recording') {
    await sleep(RECORD_POLL_MS);
    if (session.state !== 'recording') return;
    totalMs += RECORD_POLL_MS;
    if (totalMs >= hardDeadlineMs) return endTurnRecording(session);

    const size = statSizeOrNull(file);
    if (size === null || size <= bytesRead) {
      if (!speechStarted) {
        noSpeechMs += RECORD_POLL_MS;
        if (noSpeechMs >= RECORD_MAX_SILENCE_WAIT_MS) return endTurnRecording(session);
      }
      continue;
    }

    const chunk = readNewBytes(file, bytesRead, size);
    bytesRead = size;
    if (!chunk) continue;

    // `record` doesn't flush in small steady increments matching RECORD_POLL_MS either
    // (confirmed live, 2026-09-10, same as uuid_record — see monitorBargeIn) — a multi-second
    // burst evaluated as a single RMS sample and credited only RECORD_POLL_MS would badly
    // under-count real speech/silence duration, and would completely miss a burst that's part
    // silence then part speech (or vice versa). Slicing into fixed-duration sub-windows and
    // crediting each by its own actual audio duration fixes both problems.
    for (let offset = 0; offset < chunk.length; offset += windowBytes) {
      const slice = chunk.subarray(offset, Math.min(offset + windowBytes, chunk.length));
      const sliceMs = slice.length / PCM_BYTES_PER_MS;
      const rms = computeRms(slice);
      if (rms >= RECORD_RMS_THRESHOLD) {
        if (!speechStarted) {
          speechConfirmMs += sliceMs;
          noSpeechMs = 0;
          if (speechConfirmMs >= RECORD_SPEECH_CONFIRM_MS) {
            speechStarted = true;
            silenceMs = 0;
          }
        } else {
          silenceMs = 0;
        }
      } else if (speechStarted) {
        speechConfirmMs = 0;
        silenceMs += sliceMs;
        if (silenceMs >= RECORD_END_SILENCE_MS) return endTurnRecording(session);
      } else {
        speechConfirmMs = 0;
        noSpeechMs += sliceMs;
        if (noSpeechMs >= RECORD_MAX_SILENCE_WAIT_MS) return endTurnRecording(session);
      }
    }
  }
}

async function endTurnRecording(session) {
  // AUDIT INSTRUMENTATION ONLY (2026-09-10 latency audit — no behavior change): closest
  // available proxy for "customer speech end" — this is when our own RMS-based silence
  // detection actually decided the utterance was over and issued uuid_break.
  log(`[LATENCY] VAD end-of-speech detected, turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
  session.state = 'processing';
  await eslBgapi(`uuid_break ${session.fsUuid}`).catch(() => undefined);
}

/**
 * Streams the turn request and plays each reply chunk AS IT ARRIVES, sequentially — not after
 * buffering the whole (possibly multi-chunk, tens-of-seconds) reply first. Confirmed live: a
 * 6-chunk reply took 47s to fully render but its first chunk was ready in 4.3s; buffering the
 * whole thing before playing anything left the caller in dead air long enough that they hung up
 * before ever hearing a reply that had been sitting ready almost the entire time. One barge-in
 * monitor spans the whole sequence (not restarted per chunk) so interrupting mid-reply abandons
 * every remaining queued chunk, not just the one currently playing.
 */
async function processTurn(session, recFile) {
  if (!session.alive) return;

  let audioBase64;
  try {
    audioBase64 = fs.readFileSync(recFile).toString('base64');
  } catch (err) {
    log(`failed to read recording ${recFile}: ${err.message}`);
    return startRecording(session);
  }

  session.state = 'playing';
  const bargeFile = filePath(session, `barge_${session.turn}.wav`);
  const stop = { cancelled: false };
  const abortController = new AbortController();
  const bargeMonitor = monitorBargeIn(session, bargeFile, stop, abortController);

  let textResult = null;
  let requestError = null;
  let sawAnyAudio = false;
  const queue = [];
  let wakePlayer = null;
  let requestDone = false;
  // AUDIT INSTRUMENTATION (diagnoses "customer only heard N words" reports): the exact segment
  // index last confirmed played and how many were ever received, so a per-call log always
  // answers "which segment was last played, and why didn't the next one play" without needing
  // to reproduce the issue live.
  let lastPlayedIndex = -1;
  let segmentsReceived = 0;

  const enqueueChunk = (chunk) => {
    segmentsReceived++;
    queue.push(chunk);
    if (wakePlayer) {
      const wake = wakePlayer;
      wakePlayer = null;
      wake();
    }
  };

  // AUDIT INSTRUMENTATION ONLY (2026-09-10 latency audit — no behavior change): tracks the gap
  // between one segment's playback finishing and the next one's starting — the number that
  // shows whether generation is keeping up with playback now that segments are small (~250ms)
  // rather than whole multi-second TTS chunks.
  let lastPlaybackEndAt = null;

  const player = (async () => {
    let idx = 0;
    for (;;) {
      while (idx < queue.length) {
        if (!session.alive || stop.cancelled) return;
        const chunk = queue[idx++];
        sawAnyAudio = true;
        // Tells monitorBargeIn the agent's audio is actually audible now — see there for why
        // that matters (the STT+LLM+TTS wait before this point can be several seconds, and
        // sound during THAT wait isn't "talking over the agent," there's nothing to talk over).
        stop.playbackStarted = true;
        const file = filePath(session, `reply_${session.turn}_${chunk.chunkIndex}.wav`);
        try {
          fs.writeFileSync(file, Buffer.from(chunk.audioBase64, 'base64'));
          if (lastPlaybackEndAt !== null) {
            const gapMs = Date.now() - lastPlaybackEndAt;
            log(`[LATENCY] inter-segment gap before chunk${chunk.chunkIndex}: ${gapMs}ms turn ${session.turn} (call:${session.callId})`);
          }
          await playbackAndWait(session, file, `chunk${chunk.chunkIndex}`);
          lastPlaybackEndAt = Date.now();
          lastPlayedIndex = chunk.chunkIndex;
        } catch (err) {
          log(`playback of turn ${session.turn} chunk ${chunk.chunkIndex} failed: ${err.message}`);
        }
      }
      if (requestDone || !session.alive || stop.cancelled) return;
      await new Promise((resolve) => {
        wakePlayer = resolve;
      });
    }
  })();

  // AUDIT INSTRUMENTATION ONLY (2026-09-10 latency audit — no behavior change).
  log(`[LATENCY] turn request sending, turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
  for (let attempt = 1; attempt <= TURN_REQUEST_RETRY_ATTEMPTS; attempt++) {
    requestError = null;
    try {
      await streamTurnRequest(
        session.callId,
        audioBase64,
        (line) => {
          log(`[LATENCY] ndjson line received: type=${line.type}${line.chunkIndex !== undefined ? ` chunkIndex=${line.chunkIndex}` : ''} turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
          if (line.type === 'text') textResult = line;
          else if (line.type === 'audio') enqueueChunk(line);
          else if (line.type === 'error') requestError = line.message;
        },
        abortController.signal,
      );
    } catch (err) {
      // A barge-in-triggered abort is expected, not a failure — the reply so far already played
      // (or started playing) and the customer's already talking; treat it like the stream ended
      // normally instead of killing the call the way a real network/API failure below would.
      if (!(stop.cancelled && err instanceof Error && err.name === 'AbortError')) {
        requestError = err.message;
      }
    }
    // BUG FIX (2026-09-17): only retry a connection-level failure (requestError set, meaning
    // the fetch itself threw or returned non-OK — never even reached playable content) AND only
    // while NOTHING has played yet (segmentsReceived === 0) — retrying after real audio already
    // started would risk a second, contradictory reply on top of what the customer already
    // heard, exactly the risk the barge-in-abort exclusion above already guards against for a
    // different reason. Not retried when stop.cancelled (barge-in) — that's not a failure at all.
    if (!requestError || segmentsReceived > 0 || stop.cancelled) break;
    if (attempt < TURN_REQUEST_RETRY_ATTEMPTS) {
      log(`turn request failed (attempt ${attempt}/${TURN_REQUEST_RETRY_ATTEMPTS}, turn ${session.turn}, call:${session.callId}): ${requestError} — retrying in ${TURN_REQUEST_RETRY_DELAY_MS}ms`);
      await sleep(TURN_REQUEST_RETRY_DELAY_MS);
    } else {
      log(`turn request failed on final attempt (${attempt}/${TURN_REQUEST_RETRY_ATTEMPTS}, turn ${session.turn}, call:${session.callId}): ${requestError} — giving up`);
    }
  }
  requestDone = true;
  if (wakePlayer) wakePlayer();
  await player.catch((err) => log(`chunk player failed: ${err.message}`));

  // AUDIT INSTRUMENTATION: one line that always answers "which segment was last played, and
  // why didn't the rest play" for this turn, without needing to reproduce the issue live.
  const playedAllReceived = lastPlayedIndex === segmentsReceived - 1;
  const reason = !session.alive
    ? 'channel dead'
    : stop.bargedIn
      ? 'barge-in'
      : requestError
        ? `stream error: ${requestError}`
        : playedAllReceived
          ? 'completed normally'
          : 'unexplained gap — player stopped without barge-in or error';
  log(
    `[LATENCY] turn ${session.turn} playback summary (call:${session.callId}): ` +
      `segmentsReceived=${segmentsReceived} lastPlayedIndex=${lastPlayedIndex} reason="${reason}"`,
  );

  stop.cancelled = true;
  await eslBgapi(`uuid_record ${session.fsUuid} stop ${bargeFile}`).catch(() => undefined);
  await bargeMonitor.catch(() => undefined);

  if (!session.alive) return;

  if (requestError) {
    log(`turn(${session.callId}) failed: ${requestError}`);
    await eslBgapi(`uuid_kill ${session.fsUuid}`).catch(() => undefined);
    return;
  }

  if (!textResult || !textResult.reply || !sawAnyAudio) {
    session.silenceStreak += 1;
    if (session.silenceStreak >= MAX_SILENCE_STREAK) {
      await eslBgapi(`uuid_kill ${session.fsUuid}`).catch(() => undefined);
      return;
    }
    return startRecording(session);
  }
  session.silenceStreak = 0;

  if (textResult.state === 'CALL_ENDED' && !stop.bargedIn) {
    // The API's handleTurn() already finalized the Call record itself — only the channel
    // still needs tearing down.
    session.finalizedByAgent = true;
    await eslBgapi(`uuid_kill ${session.fsUuid}`).catch(() => undefined);
    return;
  }
  // Confirmed live (2026-09-11): the LLM had already decided end_call for this reply (the API
  // finalized the Call record the moment it made that decision, before this reply's audio even
  // started playing) — but the customer was simultaneously talking over the agent, which is
  // exactly what barge-in exists to let them do. Hanging up right through their interruption
  // defeats the entire point of barge-in, so their spoken-over turn wins: keep listening
  // instead of killing the channel. The Call row stays marked resolved/ended from the API's
  // side (a known, harmless bookkeeping quirk — durationSeconds/endTime reflect the moment the
  // LLM decided, not the moment the channel actually closes) rather than trying to un-finalize
  // it here.

  await startRecording(session);
}

async function playbackAndWait(session, file, label) {
  const tag = label !== undefined ? ` label=${label}` : '';
  const done = waitForExecuteComplete(session, 'playback');
  // AUDIT INSTRUMENTATION ONLY (2026-09-10 latency audit — no behavior change): "playback
  // start requested" (FreeSWITCH accepts the app here; actual RTP begins within ms of this)
  // vs. "playback confirmed done" bracket exactly how long this one clip took to play out.
  log(`[LATENCY] playback start${tag} turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
  await eslExecute(session.fsUuid, 'playback', file);
  await done;
  log(`[LATENCY] playback confirmed done${tag} turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
}

/** Runs alongside playback: records the caller leg concurrently and watches for the caller
 *  speaking over the agent — on confirmed speech, uuid_break stops playback immediately (its
 *  CHANNEL_EXECUTE_COMPLETE then resolves playbackAndWait's wait exactly as if the sentence had
 *  simply finished on its own). */
async function monitorBargeIn(session, bargeFile, stop, abortController) {
  await eslBgapi(`uuid_record ${session.fsUuid} start ${bargeFile}`).catch(() => undefined);

  let bytesRead = 44;
  let confirmMs = 0;
  let elapsedMs = 0;
  let armed = false;
  const windowBytes = BARGEIN_POLL_MS * PCM_BYTES_PER_MS;

  while (session.alive && !stop.cancelled) {
    await sleep(BARGEIN_POLL_MS);

    // Confirmed live (2026-09-11): this recording starts the moment the turn begins, well
    // before the reply's own STT+LLM+TTS pipeline produces anything audible (routinely several
    // seconds) — a real, loud sound in THAT window (the customer talking into what is, for
    // them, dead air) used to count fully toward confirmMs the instant real playback began,
    // immediately cutting the reply off before it had said a single word. Nothing gets
    // evaluated until the agent's audio is actually playing, and the very first check after
    // that fast-forwards past whatever backlog piled up in the recording during the wait
    // instead of processing it as if it just happened.
    if (!stop.playbackStarted) {
      confirmMs = 0;
      continue;
    }
    if (!armed) {
      armed = true;
      bytesRead = statSizeOrNull(bargeFile) ?? bytesRead;
      elapsedMs = 0;
      continue;
    }
    elapsedMs += BARGEIN_POLL_MS;
    if (elapsedMs < BARGEIN_GRACE_MS) continue;

    const size = statSizeOrNull(bargeFile);
    if (size === null || size <= bytesRead) {
      confirmMs = 0;
      continue;
    }
    const chunk = readNewBytes(bargeFile, bytesRead, size);
    bytesRead = size;
    if (!chunk) continue;

    // uuid_record does NOT flush to disk in small steady increments matching BARGEIN_POLL_MS —
    // confirmed live (2026-09-10): it arrives in bursts of several seconds' worth of audio at
    // once, ~4s apart here. Crediting a whole burst as only one BARGEIN_POLL_MS toward confirmMs
    // (the old behavior) made barge-in mathematically unable to ever fire: confirmMs got reset
    // to 0 by the very next "no growth" poll before it could accumulate past one increment, no
    // matter how loud or how long the real speech was. Slicing each burst into fixed-duration
    // sub-windows and crediting confirmMs by each sub-window's ACTUAL audio duration fixes this
    // independent of how bursty the underlying writes are — this loop can trigger and return
    // partway through a single burst, exactly as if it had arrived smoothly.
    for (let offset = 0; offset < chunk.length; offset += windowBytes) {
      const slice = chunk.subarray(offset, Math.min(offset + windowBytes, chunk.length));
      const sliceMs = slice.length / PCM_BYTES_PER_MS;
      const rms = computeRms(slice);
      if (rms >= BARGEIN_RMS_THRESHOLD) {
        confirmMs += sliceMs;
        if (confirmMs >= BARGEIN_CONFIRM_MS) {
          log(`[LATENCY] barge-in triggered (rms confirmed ${BARGEIN_CONFIRM_MS}ms), turn ${session.turn} (call:${session.callId}) at ${Date.now()}`);
          // Set BEFORE uuid_break so the chunk-sequence player (see processTurn) sees it the
          // instant it wakes up — it must not start a NEXT queued chunk just because the
          // CURRENT one was broken, it needs to abandon the whole remaining reply.
          stop.cancelled = true;
          // Separate from stop.cancelled (which processTurn also sets on ordinary, un-interrupted
          // completion just to unwind this loop cleanly) — this one specifically means "the
          // customer was really talking over the agent," which processTurn uses to override an
          // end_call decision the LLM already made for THIS turn (see below).
          stop.bargedIn = true;
          // Confirmed live (2026-09-11): without this, processTurn keeps awaiting the API's
          // NDJSON stream for the REST of the reply's render time (tens of seconds for a long
          // reply) even though nothing more will ever be played — the call goes dead silent,
          // not listening again, until that abandoned stream finally finishes on its own. A
          // customer's real next utterance spoken into that gap was never recorded at all.
          abortController?.abort();
          await eslBgapi(`uuid_break ${session.fsUuid}`).catch(() => undefined);
          return;
        }
      } else {
        confirmMs = 0;
      }
    }
  }
}

// ── Outbound origination ───────────────────────────────────────────────────────────────────

async function originate({ callId, fsUuid, phoneNumber, callerIdNumber }) {
  const session = newSession(fsUuid, callId);
  registerHandler(fsUuid, (eventName, headers) => onEvent(session, eventName, headers));

  // BUG FIX (2026-09-15 — "first hello sometimes not heard"): fetch the greeting NOW, in
  // parallel with dialing, instead of waiting until CHANNEL_ANSWER fires (see onAnswer). The
  // phone ringing is normally several seconds (confirmed live: ~14s on a real call) — comfortably
  // more time than one API round trip needs — so by the time the callee actually picks up, this
  // has almost always already resolved, and onAnswer's own await becomes a no-op instead of a
  // fresh network wait sitting directly between "answered" and "we're listening". Never rejects
  // (defaults to "no greeting" on any failure, matching onAnswer's prior catch behavior exactly).
  session.greetingPromise = callApi(`/telephony/worker/calls/${callId}/greeting`, {}).catch((err) => {
    log(`greeting prefetch failed, call will proceed without one: ${err.message}`);
    return { audioBase64: null };
  });

  // origination_uuid pins the FreeSWITCH channel UUID to the value the API already generated
  // and stored as Call.providerCallUuid, so every later event is already correlated to this
  // session with no separate lookup table; &park() hands full control to us over ESL the
  // instant the far end answers, no dialplan scripting needed for the answered leg.
  const cmd =
    `originate {origination_uuid=${fsUuid},ignore_early_media=true,` +
    `origination_caller_id_number=${callerIdNumber || ''},originate_timeout=30}` +
    `sofia/gateway/${SIP_GATEWAY}/${phoneNumber} &park()`;

  try {
    const reply = await eslBgapi(cmd);
    log(`originate ${phoneNumber} (call ${callId}) -> ${reply}`);
  } catch (err) {
    unregisterHandler(fsUuid);
    throw err;
  }
}

// ── Inbound calls — no pre-registered session; the dialplan answers+parks any of our DIDs ────

function onInboundEvent(eventName, headers) {
  if (eventName !== 'CHANNEL_ANSWER') return;
  const fsUuid = headers['Unique-ID'];
  if (!fsUuid || handlers.has(fsUuid)) return; // already claimed

  // This box is shared with other products on the same FreeSWITCH instance — ESL event
  // subscriptions are global, not scoped to a gateway/DID, so without this filter we would
  // also see (and try to hijack) every other product's calls. Only claim answers on OUR DIDs.
  const destination = headers['Caller-Destination-Number'] || headers['variable_sip_to_user'] || '';
  if (INBOUND_DIDS.length > 0 && !INBOUND_DIDS.includes(destination)) return;

  handleInboundAnswer(fsUuid, headers).catch((err) => log('inbound call setup failed:', err.message));
}

async function handleInboundAnswer(fsUuid, headers) {
  const fromNumber = headers['Caller-Caller-ID-Number'] || headers['variable_sip_from_user'] || 'unknown';
  const toNumber = headers['Caller-Destination-Number'] || '';

  const { callId } = await callApi('/telephony/worker/inbound-answer', {
    fromNumber,
    toNumber,
    providerCallUuid: fsUuid,
  });

  const session = newSession(fsUuid, callId);
  // BUG FIX (2026-09-23 — "agent should speak first"): getGreetingAudio now always seeds and
  // synthesizes a standard opening line when the conversation has no pre-seeded script (see its
  // own doc comment in pstn-call.service.ts) — that includes every inbound call, which never had
  // one before. This used to be skipped here entirely (left at newSession()'s no-op default)
  // under the old assumption that inbound calls could never have a greeting; now it has to
  // actually ask, same as originate() does for outbound. There's no ringing window to hide the
  // round trip in here (the call is already answered), so this does add one network+TTS round
  // trip before the caller hears anything — but onAnswer() already awaits this promise before
  // arming recording, so the ordering (agent speaks, then the caller is heard) is correct either
  // way; never rejects (defaults to "no greeting" on failure), matching originate()'s contract.
  session.greetingPromise = callApi(`/telephony/worker/calls/${callId}/greeting`, {}).catch((err) => {
    log(`greeting fetch failed, call will proceed without one: ${err.message}`);
    return { audioBase64: null };
  });
  registerHandler(fsUuid, (eventName, hdrs) => onEvent(session, eventName, hdrs));
  await onAnswer(session);
}

fallbackHandler = onInboundEvent;

// ── HTTP server (called by the main API, normally over the SSH tunnel) ────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', eslConnected: eventSocket !== null, activeCalls: handlers.size }));
    return;
  }

  if (req.method === 'POST' && req.url === '/originate') {
    const providedSecret = req.headers['x-telephony-worker-secret'];
    if (!WORKER_SECRET || providedSecret !== WORKER_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid worker secret' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        if (!params.callId || !params.fsUuid || !params.phoneNumber) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'callId, fsUuid, phoneNumber required' }));
          return;
        }
        await originate(params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'dialing' }));
      } catch (err) {
        log('originate error:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// ── Entry point ─────────────────────────────────────────────────────────────────────────────

if (!WORKER_SECRET) {
  log('WARNING: TELEPHONY_WORKER_SECRET is not set — /originate will reject every request. Set it in worker.env.');
}
if (INBOUND_DIDS.length === 0) {
  log('WARNING: INBOUND_DIDS is empty — inbound calls on ANY destination number would be claimed. Set it in worker.env.');
}

startEventListener();
server.listen(WORKER_PORT, WORKER_BIND, () => {
  log(`telephony-worker listening on ${WORKER_BIND}:${WORKER_PORT}`);
  log(`ESL target: ${ESL_HOST}:${ESL_PORT}  API: ${API_BASE_URL}  gateway: ${SIP_GATEWAY}  DIDs: ${INBOUND_DIDS.join(', ') || '(none)'}`);
});

process.on('uncaughtException', (err) => log('uncaughtException:', err.stack || err));
process.on('unhandledRejection', (err) => log('unhandledRejection:', err));
