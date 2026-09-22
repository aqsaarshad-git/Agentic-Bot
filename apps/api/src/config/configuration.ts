export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  auth: {
    // Dev-only convenience: never set in a real deployment (guarded off in prod too).
    otpDevBypassCode: process.env.NODE_ENV === 'production' ? '' : process.env.OTP_DEV_BYPASS_CODE ?? '',
  },
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'mock',
    qwenBaseUrl: process.env.QWEN_BASE_URL ?? '',
    qwenApiKey: process.env.QWEN_API_KEY ?? '',
    qwenModel: process.env.QWEN_MODEL ?? 'qwen3.5',
  },
  stt: {
    provider: process.env.STT_PROVIDER ?? 'mock',
    cohereBaseUrl: process.env.COHERE_STT_BASE_URL ?? '',
    cohereApiKey: process.env.COHERE_STT_API_KEY ?? '',
  },
  tts: {
    provider: process.env.TTS_PROVIDER ?? 'mock',
    voxcpm2BaseUrl: process.env.VOXCPM2_BASE_URL ?? '',
  },
  livekit: {
    url: process.env.LIVEKIT_URL ?? '',
    apiKey: process.env.LIVEKIT_API_KEY ?? '',
    apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  },
  // FreeSWITCH/ESL/Connectel themselves live entirely on a separate telephony worker process
  // (telephony-worker/) deployed on the box that actually holds the SIP trunk — this app never
  // connects to ESL directly. `workerUrl` is how THIS app reaches that worker (originate a
  // call, ask for a seeded greeting) — normally the local end of an SSH tunnel, see
  // scripts/freeswitch-tunnel.sh. `workerSecret` authenticates traffic in both directions: this
  // app's own /telephony/worker/* routes (called BY the worker) require it on the way in, and
  // PstnCallService sends it on the way out when calling the worker.
  telephony: {
    enabled: process.env.TELEPHONY_ENABLED === 'true',
    workerUrl: process.env.TELEPHONY_WORKER_URL ?? '',
    workerSecret: process.env.TELEPHONY_WORKER_SECRET ?? '',
    connectel: {
      callerIdNumber: process.env.CONNECTEL_CALLER_ID_NUMBER ?? '',
    },
  },
});
