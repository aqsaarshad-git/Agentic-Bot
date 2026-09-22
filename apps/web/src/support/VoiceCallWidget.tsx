import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { apiFetch, ApiError } from '../shared/api';
import { PcmStreamFormat, PcmStreamPlayer, VadCallSession, VadEvent, base64ToBlob, concatWavBuffers, uint8ToBase64 } from './audioCapture';

interface TranscriptLine {
  speaker: 'You' | 'Agent';
  text: string;
  /** Shown as soon as speech-to-text finishes, before the AI has actually replied. */
  pending?: boolean;
  /** Only set on Agent lines — the classification of the customer's turn that shaped this
   *  reply's wording and (via EMOTION_TTS_STYLE server-side) its spoken tone. */
  emotion?: string;
  sentiment?: string;
  urgency?: string;
}

interface StartCallResponse {
  call: { id: string; conversationId?: string | null };
  voiceTransportNote?: string;
}

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:3000';

interface CallTurnResponse {
  transcript: string | null;
  reply: string | null;
  state: string | null;
  emotion?: string;
  sentiment?: string;
  urgency?: string;
  audioBase64: string | null;
  audioFormat?: string;
  /** True when a long reply was split into speakable chunks and more of them are still
   *  synthesizing in the background — see the 'audio-chunk' socket event below. Always false
   *  when audioStreaming is true (see below) — 'audio-stream-end' is the equivalent signal. */
  hasMoreAudio?: boolean;
  /** True when this turn's audio is being delivered incrementally over the socket
   *  ('audio-stream-start'/'audio-stream-chunk'/'audio-stream-end') instead of inline —
   *  audioBase64 is never populated for this turn; see the PcmStreamPlayer-based path below. */
  audioStreaming?: boolean;
}

type CallPhase = 'idle' | 'connecting' | 'listening' | 'user-speaking' | 'transcribing' | 'sending' | 'agent-speaking';

const PHASE_LABEL: Record<CallPhase, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  listening: "Listening — just start talking",
  'user-speaking': 'Hearing you…',
  // Sits between "done talking" and "Thinking…" — the transcript (what was actually heard)
  // shows up during this phase, BEFORE the status ever says "Thinking", so the customer sees
  // what the agent understood before being told it's off reasoning about it. Without this gap,
  // the status jumped straight to "Thinking…" the instant speech ended, well before the
  // transcript itself had even arrived from the backend — confusing, since it read as "thinking
  // about something" with no visible confirmation of what that something was.
  transcribing: 'Got it — one moment…',
  sending: 'Thinking…',
  'agent-speaking': 'Agent speaking — jump in anytime',
};

// The real GPU box's TTS voice comes back quiet no matter what we send it, and that box is
// off-limits to touch — so the fix is client-side: route playback through a Web Audio gain
// stage instead of relying on the <audio> element's volume, which tops out at "normal".
const TTS_GAIN_BOOST = 2.4;

export function VoiceCallWidget({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized?: () => void;
}) {
  const [callId, setCallId] = useState<string | null>(null);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);

  const vadRef = useRef<VadCallSession | null>(null);
  const callIdRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const levelBarRef = useRef<HTMLDivElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  // True for exactly as long as a /calls/:id/turns request is actually in flight (STT+LLM+
  // first-chunk-TTS — the slow part). An utterance whose speech-end fires while this is true
  // gets buffered instead of dispatched as its own separate turn — see handleVadEvent and
  // dispatchTurn — so several things said in quick succession while waiting on a reply become
  // ONE combined follow-up turn instead of N sequential ones, each waiting through the last.
  const isSendingRef = useRef(false);
  const pendingCombineBufferRef = useRef<Uint8Array[]>([]);
  // handleVadEvent is registered once (vad.start(handleVadEvent)) and never re-registered,
  // so it closes over stale state — reading `phase` directly from there would always see
  // whatever it was on the very first render. A ref mirrors the latest value for that.
  const phaseRef = useRef<CallPhase>('idle');
  // Only a 'speech-start' seen while we were actually listening (or eligible for barge-in)
  // arms the matching 'speech-end' to be sent — this is what stops background noise picked
  // up while a turn is already in flight (or idle) from being treated as the customer
  // talking again, and from getting sent as a spurious extra turn.
  const utteranceArmedRef = useRef(false);
  // Set when a turn's response says the agent itself ended the conversation (e.g. the
  // customer said "okay thanks, that's it") — the backend has already finalized the Call
  // record by the time this is set, so the teardown below must NOT call POST /end again.
  const endedByAgentRef = useRef(false);
  // A long reply is split server-side into speakable chunks — the first arrives with the
  // turn's own HTTP response, the rest stream in afterward as separate 'audio-chunk' socket
  // events. Everything funnels through this one queue (regardless of which path delivered
  // it) so playback order is correct no matter the arrival timing of any individual chunk.
  const audioQueueRef = useRef<{ base64: string; format: string }[]>([]);
  const isPlayingRef = useRef(false);
  const awaitingMoreChunksRef = useRef(false);
  // True incremental playback path (VoxCPM2's real /speak_stream) — a separate player from
  // the legacy <audio>-element queue above, since the two deliver audio completely
  // differently (raw PCM chunks scheduled via Web Audio vs. full WAV blobs per chunk). Only
  // one of the two is ever active for a given turn, chosen server-side (see
  // CallTurnResponse.audioStreaming) based on whether the active TTS provider supports
  // streaming.
  const pcmPlayerRef = useRef<PcmStreamPlayer | null>(null);
  // Tracks whether 'audio-stream-start' has actually arrived for the CURRENT turn, so a
  // stream that fails before producing any audio (audio-stream-end with no preceding start)
  // can settle the phase immediately instead of waiting on a player that was never begun.
  const streamStartedRef = useRef(false);

  function updatePhase(next: CallPhase) {
    phaseRef.current = next;
    setPhase(next);
  }

  const playbackCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  useEffect(
    () => () => {
      vadRef.current?.stop();
      socketRef.current?.disconnect();
    },
    [],
  );

  function connectTranscriptSocket(conversationId: string) {
    socketRef.current?.disconnect();
    const socket = io(`${API_ORIGIN}/conversations`, { auth: { token } });
    socketRef.current = socket;
    socket.emit('join', { conversationId });
    socket.on('message', (msg: { sender: string; content: string }) => {
      // Only the customer's own transcript is shown early — the AI's reply text is appended
      // together with its audio once the REST turn response is ready (see sendTurn), so a
      // duplicate isn't shown here.
      if (msg.sender !== 'CUSTOMER') return;
      setTranscript((prev) => [...prev, { speaker: 'You', text: msg.content, pending: true }]);
      // Only now — once the customer can actually see what was heard — move on to "Thinking…".
      // Guarded so an unrelated/late broadcast can't yank the phase backward from wherever it
      // legitimately is.
      if (phaseRef.current === 'transcribing') {
        updatePhase('sending');
      }
    });
    socket.on('audio-chunk', (payload: { audioBase64: string | null; audioFormat?: string; isLast: boolean }) => {
      if (payload.isLast) awaitingMoreChunksRef.current = false;
      if (payload.audioBase64) {
        audioQueueRef.current.push({ base64: payload.audioBase64, format: payload.audioFormat ?? 'wav' });
      }
      tryPlayNext();
    });
    // True incremental TTS path — see PcmStreamPlayer and CallsService.streamChunksIncremental.
    // Only one of this path or the legacy 'audio-chunk' queue above is ever active for a given
    // turn (chosen server-side), but both listeners can coexist safely since they touch
    // entirely separate state.
    socket.on('audio-stream-start', (payload: { format: PcmStreamFormat }) => {
      streamStartedRef.current = true;
      ensurePlaybackGraph();
      pcmPlayerRef.current?.begin(payload.format, settleAfterAgentAudio);
      updatePhase('agent-speaking');
    });
    socket.on('audio-stream-chunk', (payload: { pcmBase64: string }) => {
      pcmPlayerRef.current?.push(payload.pcmBase64);
    });
    socket.on('audio-stream-end', () => {
      if (streamStartedRef.current) {
        pcmPlayerRef.current?.finish();
      } else {
        // Nothing ever played for this turn (e.g. the TTS stream failed before its first
        // chunk) — settle immediately rather than waiting on a finish() with nothing queued.
        settleAfterAgentAudio();
      }
      streamStartedRef.current = false;
    });
  }

  /** Once all of this turn's agent audio has finished playing (whichever path delivered it),
   *  either hangs up (if the agent itself ended the call) or returns to listening. */
  function settleAfterAgentAudio() {
    if (endedByAgentRef.current) {
      teardownCallSession(true);
      setNote('Call ended.');
    } else {
      updatePhase(vadRef.current ? 'listening' : 'idle');
    }
  }

  /** Plays the next queued chunk if nothing is currently playing, or — once the queue is
   *  empty — settles the phase: still "Thinking…" if more chunks are still coming, otherwise
   *  hands off to settleAfterAgentAudio. Legacy (non-streaming) playback path only — every
   *  chunk here is a complete WAV blob played through the <audio> element. */
  function tryPlayNext() {
    if (isPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      if (awaitingMoreChunksRef.current) {
        updatePhase('sending');
      } else {
        settleAfterAgentAudio();
      }
      return;
    }
    isPlayingRef.current = true;
    ensurePlaybackGraph();
    const blob = base64ToBlob(next.base64, `audio/${next.format}`);
    if (!audioElRef.current) {
      isPlayingRef.current = false;
      return;
    }
    audioElRef.current.src = URL.createObjectURL(blob);
    updatePhase('agent-speaking');
    audioElRef.current.play().catch(() => {
      // Playback can fail silently on some browsers without a fresh gesture — the transcript
      // still shows what was said either way; move on rather than getting stuck.
      isPlayingRef.current = false;
      tryPlayNext();
    });
  }

  function ensurePlaybackGraph() {
    const el = audioElRef.current;
    if (!el) return;
    try {
      if (!playbackCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        playbackCtxRef.current = new AudioCtx();
      }
      if (!mediaSourceRef.current) {
        mediaSourceRef.current = playbackCtxRef.current.createMediaElementSource(el);
        gainNodeRef.current = playbackCtxRef.current.createGain();
        gainNodeRef.current.gain.value = TTS_GAIN_BOOST;
        mediaSourceRef.current.connect(gainNodeRef.current);
        gainNodeRef.current.connect(playbackCtxRef.current.destination);
      }
      // Shares the same gain-boosted destination as the legacy <audio> element above, so both
      // playback paths get the same volume boost without any extra wiring.
      if (!pcmPlayerRef.current && gainNodeRef.current) {
        pcmPlayerRef.current = new PcmStreamPlayer(playbackCtxRef.current, gainNodeRef.current);
      }
      playbackCtxRef.current.resume().catch(() => {});
    } catch {
      // Worst case, playback still works at normal (unboosted) volume.
    }
  }

  async function startCall() {
    setBusy(true);
    updatePhase('connecting');
    setNote(null);
    try {
      // Must happen inside this click handler (a user gesture) or the browser's autoplay
      // policy will keep the playback AudioContext suspended for every future reply.
      ensurePlaybackGraph();

      // No language to pick up front anymore — every utterance is auto-detected on the
      // backend (see CallsService.pickSpokenLanguage), so the customer can speak English or
      // Arabic and switch freely mid-call without telling the app anything first.
      const res = await apiFetch<StartCallResponse>('/calls', { method: 'POST', token, body: {} });
      callIdRef.current = res.call.id;
      setCallId(res.call.id);
      setTranscript([]);
      if (res.call.conversationId) connectTranscriptSocket(res.call.conversationId);

      const vad = new VadCallSession();
      await vad.start(handleVadEvent);
      vadRef.current = vad;

      updatePhase('listening');
      setNote(
        res.voiceTransportNote
          ? 'No live audio room configured on the backend — this still records/sends each utterance automatically.'
          : null,
      );
    } catch (err) {
      updatePhase('idle');
      if (err instanceof ApiError && err.status === 401) {
        setNote('Your session has expired. Please verify your identity again.');
        onUnauthorized?.();
      } else if (err instanceof Error && err.name === 'NotAllowedError') {
        setNote('Microphone access was blocked — allow it in your browser and try again.');
      } else {
        setNote(err instanceof ApiError ? `Failed to start call: ${err.message}` : 'Failed to start call.');
      }
    } finally {
      setBusy(false);
    }
  }

  /** Tears down the local call session. Only hits POST /end when the backend hasn't already
   *  finalized this call itself (see endedByAgentRef). */
  async function teardownCallSession(alreadyEndedOnBackend: boolean) {
    const id = callIdRef.current;
    // Ending the call must silence the agent immediately — clicking "End Call" mid-sentence
    // previously left the in-flight audio clip playing to completion in the background even
    // though the call itself had already ended on screen.
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.removeAttribute('src');
      audioElRef.current.load();
    }
    pcmPlayerRef.current?.stop();
    streamStartedRef.current = false;
    vadRef.current?.stop();
    vadRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    callIdRef.current = null;
    endedByAgentRef.current = false;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    awaitingMoreChunksRef.current = false;
    isSendingRef.current = false;
    pendingCombineBufferRef.current = [];
    setCallId(null);
    updatePhase('idle');
    setMuted(false);
    if (!id || alreadyEndedOnBackend) return;
    setBusy(true);
    try {
      await apiFetch(`/calls/${id}/end`, { method: 'POST', token });
    } finally {
      setBusy(false);
    }
  }

  function endCall() {
    return teardownCallSession(false);
  }

  function handleVadEvent(event: VadEvent) {
    if (event.type === 'level') {
      if (levelBarRef.current) {
        const pct = Math.max(0.03, Math.min(1, event.rms * 12));
        levelBarRef.current.style.transform = `scaleX(${pct})`;
      }
      return;
    }

    if (event.type === 'speech-start') {
      // Ignore this only while there's genuinely no call to talk into yet (still connecting,
      // or not on a call at all) — a stray sound in that window can't mean anything. Any other
      // phase is fair game: talking while the agent is replying is a barge-in, and talking
      // again while a previous turn is still being processed is a real follow-up (the shared
      // GPU can take a long time to reply — the customer shouldn't have to know that and time
      // their sentences around it), not noise to be dropped.
      const currentPhase = phaseRef.current;
      if (currentPhase === 'idle' || currentPhase === 'connecting') {
        utteranceArmedRef.current = false;
        return;
      }
      utteranceArmedRef.current = true;

      // Talking while the agent's reply is still playing is a barge-in, exactly like on a
      // real phone call — cut it off immediately instead of waiting for the clip to finish.
      // Checked across BOTH playback paths, since which one is active for the current turn
      // is a server-side choice (see CallTurnResponse.audioStreaming) the widget doesn't
      // control.
      const el = audioElRef.current;
      const wasPlayingLegacyAudio = Boolean(el && !el.paused);
      const wasStreamingPcm = Boolean(pcmPlayerRef.current?.isPlaying) || streamStartedRef.current;
      // Diagnostic only — printed so a browser DevTools console log can be compared against
      // the server's own [LATENCY]/barge-in logs when tracking down a barge-in that felt like
      // it didn't register or didn't stop the agent in time.
      console.log('[VAD] speech-start', {
        phase: currentPhase,
        wasPlayingLegacyAudio,
        wasStreamingPcm,
        pcmIsPlaying: pcmPlayerRef.current?.isPlaying,
        streamStarted: streamStartedRef.current,
        bargeIn: wasPlayingLegacyAudio || wasStreamingPcm,
      });
      if (wasPlayingLegacyAudio || wasStreamingPcm) {
        if (wasPlayingLegacyAudio && el) {
          el.pause();
          // el.pause() fires a 'pause' event, never 'ended' — onAgentAudioEnded (the only place
          // that normally clears isPlayingRef) never runs for it. Left alone, isPlayingRef stays
          // stuck true forever, so every future tryPlayNext() call (for the rest of THIS reply's
          // remaining chunks, and every later turn for the rest of the call) short-circuits on
          // its own "already playing" guard and never plays anything again — this, not anything
          // TTS-side, is why a long reply could go silent partway through after a barge-in.
          isPlayingRef.current = false;
          // Anything still queued/expected belongs to the reply just abandoned — the backend
          // stops producing more of it too (see CallsService.interrupt's generation bump), so
          // there's nothing left worth waiting for or playing back after this point.
          audioQueueRef.current = [];
          awaitingMoreChunksRef.current = false;
        }
        if (wasStreamingPcm) {
          // Silences whatever's already scheduled immediately, rather than letting buffers
          // already handed to the Web Audio API play out to the end.
          pcmPlayerRef.current?.stop();
          streamStartedRef.current = false;
        }
        const id = callIdRef.current;
        if (id) apiFetch(`/calls/${id}/interrupt`, { method: 'POST', token }).catch(() => {});
        setNote('Interrupted — go ahead.');
      }
      updatePhase('user-speaking');
      return;
    }

    if (event.type === 'speech-abandoned') {
      // A speech-start fired (arming and flipping the status to "Hearing you…") but the sound
      // died out before becoming a real utterance (a cough, background noise) — nothing to
      // send, but the status still needs to move on from "Hearing you…", or it would sit
      // there forever since nothing else was ever going to update it.
      utteranceArmedRef.current = false;
      if (phaseRef.current === 'user-speaking') {
        updatePhase(vadRef.current ? 'listening' : 'idle');
      }
      return;
    }

    // speech-end: only act on it if the matching speech-start was actually armed above —
    // otherwise this is the tail end of noise that was already ignored, and sending it would
    // both misreport the status and waste a turn on the backend for nothing anyone said.
    if (!utteranceArmedRef.current) {
      console.log('[VAD] speech-end ignored (not armed)', { durationMs: event.durationMs });
      return;
    }
    utteranceArmedRef.current = false;
    console.log('[VAD] speech-end', { durationMs: event.durationMs, willBuffer: isSendingRef.current });

    // Reflect "done talking, now processing" the instant the utterance is confirmed — not
    // whenever it actually gets sent (which may be later, if it ends up buffered below).
    // Land on 'transcribing' rather than 'sending' here: the customer hasn't seen their own
    // transcript yet, so jumping straight to "Thinking…" would be confusing (looks like the
    // agent is reasoning about something the customer never confirmed was heard correctly).
    // The 'message' socket handler above promotes this to 'sending' once the transcript text
    // actually lands.
    updatePhase('transcribing');

    if (isSendingRef.current) {
      // A turn is already in flight — this utterance is a quick follow-up to something still
      // being answered, not a brand new independent request. Buffer it rather than queue it
      // as its own separate subsequent turn: once the in-flight one resolves, everything
      // buffered gets combined into a SINGLE follow-up turn with one reply, instead of the
      // customer waiting through a full STT+LLM+TTS round-trip for each thing they said.
      pendingCombineBufferRef.current.push(event.wav);
      return;
    }
    dispatchTurn(event.wav);
  }

  /** Sends one turn, then — if anything was said while it was in flight — immediately sends
   *  everything buffered during that wait as a single combined follow-up turn. */
  async function dispatchTurn(wav: Uint8Array) {
    isSendingRef.current = true;
    try {
      await sendTurn(wav);
    } finally {
      isSendingRef.current = false;
    }
    if (pendingCombineBufferRef.current.length > 0) {
      const combined = concatWavBuffers(pendingCombineBufferRef.current);
      pendingCombineBufferRef.current = [];
      dispatchTurn(combined);
    }
  }

  async function sendTurn(wav: Uint8Array) {
    const id = callIdRef.current;
    if (!id) return;
    const sentAt = performance.now();
    console.log('[TURN] sending', { bytes: wav.length });
    try {
      const data = await apiFetch<CallTurnResponse>(`/calls/${id}/turns`, {
        method: 'POST',
        token,
        body: { audioBase64: uint8ToBase64(wav) },
      });
      console.log('[TURN] response', {
        ms: Math.round(performance.now() - sentAt),
        transcript: data.transcript,
        reply: data.reply,
        audioStreaming: data.audioStreaming,
      });

      // The customer may have hit "End Call" while this request was still in flight — that
      // resets callIdRef but can't cancel an already-sent fetch. Without this check, the
      // reply for a call that's already over would still show up and, worse, start playing
      // the agent's voice after the call had supposedly ended.
      if (callIdRef.current !== id) return;

      setTranscript((prev) => {
        // The socket delivery above (broadcast server-side right after STT finishes, well
        // before the LLM+TTS work here completes) already showed this exact line — replace
        // it in place instead of appending a visible duplicate. Fall back to appending if
        // the socket event never arrived (e.g. it was still connecting).
        let next = prev;
        if (data.transcript) {
          const idx = prev.findIndex((l) => l.pending && l.speaker === 'You' && l.text === data.transcript);
          next =
            idx !== -1
              ? [...prev.slice(0, idx), { speaker: 'You' as const, text: data.transcript }, ...prev.slice(idx + 1)]
              : [...prev, { speaker: 'You' as const, text: data.transcript }];
        }
        return data.reply
          ? [
              ...next,
              {
                speaker: 'Agent' as const,
                text: data.reply,
                emotion: data.emotion,
                sentiment: data.sentiment,
                urgency: data.urgency,
              },
            ]
          : next;
      });
      setNote(null);
      // The backend already finalized the Call record if the agent decided this conversation
      // is over — settleAfterAgentAudio (reached via tryPlayNext or the audio-stream-end
      // handler, depending on which path delivers this turn's audio) checks this flag once
      // playback has actually finished, and tears the call down without calling POST /end
      // again.
      endedByAgentRef.current = data.state === 'CALL_ENDED';

      if (data.audioStreaming) {
        // Audio for this turn arrives entirely over the socket ('audio-stream-start'/
        // 'audio-stream-chunk'/'audio-stream-end') — nothing to do with the legacy
        // audioBase64/audioQueue path here. Phase stays whatever it currently is
        // ("Thinking…") until 'audio-stream-start' flips it to "Agent speaking…", which is
        // typically well under a second away since the reply text (and therefore this
        // response) no longer waits on any audio being ready first.
      } else {
        // Legacy (non-streaming) path — a long reply streams its remaining chunks in over
        // the socket ('audio-chunk'); don't let the queue look "done" and settle the phase
        // prematurely just because this first chunk is all that's arrived so far.
        awaitingMoreChunksRef.current = Boolean(data.hasMoreAudio);
        if (data.audioBase64) {
          audioQueueRef.current.push({ base64: data.audioBase64, format: data.audioFormat ?? 'wav' });
        }
        tryPlayNext();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNote('Your session has expired. Please verify your identity again.');
        onUnauthorized?.();
        // Skip POST /end — a token that just failed auth can't authorize that call either.
        teardownCallSession(true);
      } else {
        setNote(err instanceof ApiError ? `Failed: ${err.message}` : 'Something went wrong on that turn — still listening.');
        updatePhase(vadRef.current ? 'listening' : 'idle');
      }
    }
  }

  function onAgentAudioEnded() {
    isPlayingRef.current = false;
    tryPlayNext();
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    vadRef.current?.setActive(!next);
    if (next) {
      // Muting cuts VAD off immediately, so there's nothing left that could ever correct the
      // status afterward — if it was showing "Hearing you…" at this exact moment (genuinely
      // mid-utterance, or stuck), it would otherwise stay frozen there for the rest of the
      // mute, since no further VAD event is coming to move it on.
      utteranceArmedRef.current = false;
      if (phaseRef.current === 'user-speaking') {
        updatePhase('listening');
      }
    }
    setNote(next ? "Muted — the agent can't hear you." : null);
  }

  const inCall = callId !== null;

  return (
    <div className="call-widget">
      <div className={`call-status call-status--${phase}`}>
        <span className="call-status-dot" />
        {PHASE_LABEL[phase]}
      </div>
      {note && <p className="call-note">{note}</p>}

      {inCall && (
        <div className="mic-level" aria-hidden="true">
          <div className="mic-level-fill" ref={levelBarRef} />
        </div>
      )}

      {!inCall ? (
        <button className="btn" onClick={startCall} disabled={busy} style={{ width: '100%' }}>
          <Phone size={16} />
          Start Call
        </button>
      ) : (
        <div className="call-actions">
          <button className={`btn ${muted ? 'btn-danger' : 'btn-secondary'}`} onClick={toggleMute}>
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button className="btn btn-danger" onClick={endCall} disabled={busy}>
            <PhoneOff size={16} />
            End Call
          </button>
        </div>
      )}

      <audio ref={audioElRef} style={{ display: 'none' }} onEnded={onAgentAudioEnded} />

      <div className="chat-messages call-transcript">
        {transcript.map((line, i) => (
          <div key={i} className={`chat-message ${line.speaker === 'You' ? 'customer' : 'ai'}`}>
            <span className="chat-message-label">{line.speaker}</span>
            {line.text}
            {line.speaker === 'Agent' && line.emotion && (
              <div className="chat-message-meta">
                Detected: {line.emotion}
                {line.sentiment ? ` · ${line.sentiment}` : ''}
                {line.urgency && line.urgency !== 'low' ? ` · ${line.urgency} urgency` : ''}
              </div>
            )}
          </div>
        ))}
        {(phase === 'transcribing' || phase === 'sending') && (
          <div className="chat-message ai chat-message-typing">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        )}
        {transcript.length === 0 && (
          <p style={{ color: '#999', fontSize: 13 }}>
            {inCall
              ? "Just start talking — you'll see exactly what the agent understood right here."
              : 'Start a call and speak naturally, like a real phone call. No buttons to hold.'}
          </p>
        )}
        <div ref={transcriptEndRef} />
      </div>
    </div>
  );
}
