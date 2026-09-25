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
  // Product-level facts, not per-customer data — config/DB-driven so get_fees never lets the
  // LLM invent a number, without needing a table for values that don't vary per customer.
  banking: {
    fees: {
      internalTransfer: { amount: 0, currency: 'SAR', description: 'Transfers between your own accounts are free.' },
      beneficiaryTransfer: { amount: 5, currency: 'SAR', description: 'Flat fee for a transfer to a saved beneficiary.' },
      atmWithdrawalOwnNetwork: { amount: 0, currency: 'SAR', description: 'No fee at our own ATMs.' },
      atmWithdrawalOtherNetwork: { amount: 10, currency: 'SAR', description: 'Fee at another bank\'s ATM.' },
      internationalTransaction: { amount: 0, currency: 'SAR', percentage: 2.5, description: '2.5% of the transaction amount for international card use.' },
      cardReplacement: { amount: 0, currency: 'SAR', description: 'Card replacement is free for lost, stolen, or damaged cards.' },
    },
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
  // Same variable names as the reference Laravel project's mail config (MAIL_MAILER/MAIL_HOST/...)
  // deliberately — 'smtp' with host/port/username/password is a direct, provider-agnostic port
  // of the exact mechanism that project's own Docker/production config already uses (Gmail SMTP),
  // not a new approach. 'log' (the default, same fallback that project uses locally) never
  // touches the network — NotificationsService just records/logs, matching its existing
  // documented behavior before this feature existed. Host/port default to Gmail's own SMTP
  // relay so setting MAIL_MAILER=smtp + a real MAIL_USERNAME/MAIL_PASSWORD (a Gmail address + app
  // password) is enough on its own — no other env var required.
  mail: {
    mailer: process.env.MAIL_MAILER ?? 'log',
    host: process.env.MAIL_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.MAIL_PORT ?? '587', 10),
    username: process.env.MAIL_USERNAME ?? '',
    password: process.env.MAIL_PASSWORD ?? '',
    fromAddress: process.env.MAIL_FROM_ADDRESS ?? 'no-reply@example.com',
    fromName: process.env.MAIL_FROM_NAME ?? 'Barq Bank Support',
  },
});
