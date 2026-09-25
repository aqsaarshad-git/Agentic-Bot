import { FormEvent, useEffect, useState } from 'react';
import { Landmark, MessageCircle, Phone, RotateCcw } from 'lucide-react';
import { useCustomerAuth } from '../shared/CustomerAuthContext';
import { apiFetch, ApiError } from '../shared/api';
import { ChatWidget } from '../support/ChatWidget';
import { RealPhoneCallPanel } from './RealPhoneCallPanel';
import { DevTestPanel } from './DevTestPanel';

const CONVERSATION_STORAGE_KEY = 'banking_conversation_id';

/**
 * DEVELOPMENT / DEMO ONLY. These go through the exact same real /auth/customer-identify +
 * /auth/customer-verify-otp endpoints as manual login — this is a UI convenience (pre-fills a
 * known seeded email and submits the dev-bypass OTP code automatically) with ZERO backend trust
 * shortcut: the backend independently finds-or-creates the customer and issues a real JWT, the
 * same way it would for anyone typing this in by hand. Emails/archetypes match prisma/seed.ts.
 */
const DEMO_CUSTOMERS = [
  { label: 'Healthy customer', fullName: 'Sara Al-Fahad', email: 'sara@example.com', note: 'Active account, healthy history' },
  { label: 'Insufficient funds', fullName: 'Mohammed bin Khalid', email: 'mohammed@example.com', note: 'Pending + failed transaction' },
  { label: 'PIN blocked / locked', fullName: 'Fatima Al-Zahra', email: 'fatima@example.com', note: 'Card blocked, login locked' },
  { label: 'Stolen card', fullName: 'Khalid Al-Otaibi', email: 'khalid@example.com', note: 'Card stolen, replacement pending' },
  { label: 'Fraud dispute', fullName: 'Noura Al-Harbi', email: 'noura@example.com', note: 'Open fraud case' },
];

export function BankingAssistantPage() {
  const { token, customer, loading, identify, verifyOtp, logout } = useCustomerAuth();
  const [fullName, setFullName] = useState('');
  const [contact, setContact] = useState('');
  const [pendingCustomerId, setPendingCustomerId] = useState<string | null>(null);
  const [devOtpHint, setDevOtpHint] = useState<string | null>(null);
  const [devBypassHint, setDevBypassHint] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'call'>('chat');
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  function handleSessionExpired() {
    logout();
    setSessionMessage('Your session expired. Please verify your identity again.');
  }

  function handleLogout() {
    localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    setConversationId(null);
    setSessionMessage(null);
    logout();
  }

  function handleClearConversation() {
    localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    setConversationId(null);
  }

  async function loginAsDemoCustomer(demo: (typeof DEMO_CUSTOMERS)[number]) {
    setError(null);
    setSubmitting(true);
    try {
      const result = await identify(demo.fullName, { email: demo.email });
      await verifyOtp(result.customerId, result.devBypassCode ?? '000000');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the demo session');
    } finally {
      setSubmitting(false);
    }
  }

  // Reuses/mirrors SupportPage's own conversation bootstrap exactly, under a separate storage
  // key so switching between the general support page and this one never mixes conversations.
  useEffect(() => {
    if (!token || conversationId) return;
    const existing = localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (existing) {
      setConversationId(existing);
      return;
    }
    apiFetch<{ id: string }>('/conversations', { method: 'POST', token, body: {} })
      .then((conv) => {
        localStorage.setItem(CONVERSATION_STORAGE_KEY, conv.id);
        setConversationId(conv.id);
      })
      .catch(() => {});
  }, [token, conversationId]);

  // Backend connectivity heartbeat — a real network failure (backend down/unreachable) throws a
  // plain fetch error, not an ApiError (which means the server DID respond, even with a 4xx/5xx);
  // that distinction is what separates "backend online but this call needs auth" from "offline".
  useEffect(() => {
    if (!token) return;
    let alive = true;
    async function ping() {
      try {
        await apiFetch('/verification/status', { token });
        if (alive) setBackendOnline(true);
      } catch (err) {
        if (alive) setBackendOnline(err instanceof ApiError);
      }
    }
    ping();
    const interval = setInterval(ping, 8000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [token]);

  if (loading) return null;

  const brandHeader = (
    <div className="brand-header">
      <span className="brand-mark">
        <Landmark size={18} />
      </span>
      <span className="brand-name">Barq Bank</span>
      {import.meta.env.DEV && <span className="dev-badge">Dev / Demo</span>}
    </div>
  );

  if (!token && pendingCustomerId) {
    async function onVerify(e: FormEvent) {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        await verifyOtp(pendingCustomerId!, otpCode);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Verification failed');
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <div className="support-screen">
        <form className="support-box" onSubmit={onVerify}>
          {brandHeader}
          <h2 style={{ marginBottom: 4 }}>Verify it's you</h2>
          <p style={{ margin: '0 0 18px', color: 'var(--text-muted)', fontSize: 13.5 }}>Enter the 6-digit code we sent you.</p>
          {devOtpHint && <p style={{ color: 'var(--accent)', fontSize: 13 }}>Dev mode — your code is {devOtpHint}</p>}
          {devBypassHint && (
            <p style={{ color: 'var(--accent)', fontSize: 13 }}>
              Or use the fixed test code <strong>{devBypassHint}</strong> — works for any account while testing.
            </p>
          )}
          <div className="field">
            <label>Verification code</label>
            <input className="input" value={otpCode} onChange={(e) => setOtpCode(e.target.value)} maxLength={6} required />
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13.5 }}>{error}</p>}
          <button className="btn" type="submit" disabled={submitting} style={{ width: '100%' }}>
            {submitting ? 'Verifying…' : 'Verify'}
          </button>
        </form>
      </div>
    );
  }

  if (!token || !customer) {
    async function onSubmit(e: FormEvent) {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        const isEmail = contact.includes('@');
        const result = await identify(fullName, isEmail ? { email: contact } : { phone: contact });
        setPendingCustomerId(result.customerId);
        setDevOtpHint(result.devOtp ?? null);
        setDevBypassHint(result.devBypassCode ?? null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <div className="support-screen">
        <form className="support-box" style={{ width: 420 }} onSubmit={onSubmit}>
          {brandHeader}
          <h2 style={{ marginBottom: 4 }}>Talk to your bank</h2>
          <p style={{ margin: '0 0 18px', color: 'var(--text-muted)', fontSize: 13.5 }}>
            Tell us who you are so we can securely pull up your account.
          </p>
          {sessionMessage && <p style={{ color: 'var(--danger)', fontSize: 13.5 }}>{sessionMessage}</p>}
          <div className="field">
            <label>Full name</label>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Email or phone</label>
            <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} required />
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13.5 }}>{error}</p>}
          <button className="btn" type="submit" disabled={submitting} style={{ width: '100%' }}>
            {submitting ? 'Starting…' : 'Start banking chat'}
          </button>

          {import.meta.env.DEV && (
            <div style={{ marginTop: 18, padding: '12px 14px', background: 'var(--surface-alt)', borderRadius: 'var(--radius-sm)' }}>
              <div className="dev-badge" style={{ marginBottom: 8 }}>
                Development / Demo only
              </div>
              <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-muted)' }}>
                Skip the form — instantly sign in as a seeded demo customer (still goes through the real
                identify + OTP endpoints; the backend, not this button, decides who you are):
              </p>
              <div className="demo-customer-grid">
                {DEMO_CUSTOMERS.map((demo) => (
                  <button type="button" key={demo.email} onClick={() => loginAsDemoCustomer(demo)} disabled={submitting}>
                    <strong>{demo.label}</strong>
                    <span>{demo.fullName}</span>
                    <br />
                    <span>{demo.note}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="support-screen">
      <div className="banking-shell">
        <div className="support-box banking-main" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 18 }}>
            <div>
              {brandHeader}
              <h2 style={{ marginTop: 2 }}>Hi {customer.fullName.split(' ')[0]}, how can we help with your account?</h2>
              <span className={`connection-pill ${backendOnline === false ? 'offline' : 'online'}`}>
                <span className="dot" />
                {backendOnline === false ? 'Backend unreachable' : 'Connected to backend'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={handleClearConversation} className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12.5 }}>
                <RotateCcw size={13} style={{ marginRight: 4 }} />
                Clear conversation
              </button>
              <button type="button" onClick={handleLogout} className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12.5 }}>
                Log out
              </button>
            </div>
          </div>

          <div className="mode-toggle">
            <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
              <MessageCircle size={16} />
              Chat
            </button>
            <button type="button" className={mode === 'call' ? 'active' : ''} onClick={() => setMode('call')}>
              <Phone size={16} />
              Voice (real phone call)
            </button>
          </div>

          {mode === 'chat' &&
            (conversationId ? (
              <ChatWidget key={conversationId} conversationId={conversationId} token={token} onUnauthorized={handleSessionExpired} />
            ) : (
              <p className="text-muted">Connecting…</p>
            ))}
          {mode === 'call' && <RealPhoneCallPanel token={token} customer={customer} />}
        </div>

        {import.meta.env.DEV && <DevTestPanel token={token} customer={customer} conversationId={conversationId} />}
      </div>
    </div>
  );
}
