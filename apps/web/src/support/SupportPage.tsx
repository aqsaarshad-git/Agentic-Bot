import { FormEvent, useEffect, useState } from 'react';
import { MessageCircle, Phone, ShieldCheck } from 'lucide-react';
import { useCustomerAuth } from '../shared/CustomerAuthContext';
import { apiFetch, ApiError } from '../shared/api';
import { ChatWidget } from './ChatWidget';
import { VoiceCallWidget } from './VoiceCallWidget';

const CONVERSATION_STORAGE_KEY = 'customer_conversation_id';

export function SupportPage() {
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

  // The customer JWT expires (see apps/api/.env JWT_EXPIRES_IN, 8h by default), but the
  // "logged in" screen is rendered straight from localStorage without checking that —
  // so a stale token still shows the authenticated view until an actual API call reveals
  // it's dead (401 Unauthorized). Both widgets call this when that happens, instead of
  // leaving the customer stuck looking at a call/chat screen that will never work.
  function handleSessionExpired() {
    logout();
    setSessionMessage('Your session expired. Please verify your identity again.');
  }

  // Manual logout, e.g. to switch and test as a different customer account. This only
  // clears this browser's own localStorage (the JWT, plus the cached conversation id so a
  // different account that logs in next doesn't inherit someone else's conversation) — the
  // API is stateless with no server-side session list, so it cannot touch any other
  // concurrent session/browser/user.
  function handleLogout() {
    localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    setConversationId(null);
    setSessionMessage(null);
    logout();
  }

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

  if (loading) return null;

  const brandHeader = (
    <div className="brand-header">
      <span className="brand-mark">
        <ShieldCheck size={18} />
      </span>
      <span className="brand-name">Barq Bank</span>
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
          <p style={{ margin: '0 0 18px', color: 'var(--text-muted)', fontSize: 13.5 }}>
            Enter the 6-digit code we sent you.
          </p>
          {devOtpHint && (
            <p style={{ color: 'var(--accent)', fontSize: 13 }}>Dev mode — your code is {devOtpHint}</p>
          )}
          {devBypassHint && (
            <p style={{ color: 'var(--accent)', fontSize: 13 }}>
              Or use the fixed test code <strong>{devBypassHint}</strong> — works for any account while testing.
            </p>
          )}
          <div className="field">
            <label>Verification code</label>
            <input
              className="input"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              maxLength={6}
              required
            />
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
        <form className="support-box" onSubmit={onSubmit}>
          {brandHeader}
          <h2 style={{ marginBottom: 4 }}>Contact support</h2>
          <p style={{ margin: '0 0 18px', color: 'var(--text-muted)', fontSize: 13.5 }}>
            Tell us who you are so we can pick up where you left off.
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
            {submitting ? 'Starting…' : 'Start chat'}
          </button>
          {import.meta.env.DEV && (
            <div
              style={{
                marginTop: 18,
                padding: '10px 12px',
                background: 'var(--surface-alt)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              <strong style={{ color: 'var(--text)' }}>Demo accounts (dev only)</strong>
              <br />
              ahmed@example.com · sara@example.com · mohammed@example.com · fatima@example.com
              <br />
              Any name works — the email/phone is what looks up the seeded account.
            </div>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="support-screen">
      <div className="support-box" style={{ width: 480 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Barq Bank
            </div>
            <h2 style={{ marginTop: 2 }}>Hi {customer.fullName.split(' ')[0]}, how can we help?</h2>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12.5 }}
          >
            Log out
          </button>
        </div>

        <div className="mode-toggle">
          <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
            <MessageCircle size={16} />
            Chat
          </button>
          <button type="button" className={mode === 'call' ? 'active' : ''} onClick={() => setMode('call')}>
            <Phone size={16} />
            Call
          </button>
        </div>

        {mode === 'chat' &&
          (conversationId ? (
            <ChatWidget conversationId={conversationId} token={token} onUnauthorized={handleSessionExpired} />
          ) : (
            <p className="text-muted">Connecting…</p>
          ))}
        {mode === 'call' && <VoiceCallWidget token={token} onUnauthorized={handleSessionExpired} />}
      </div>
    </div>
  );
}
