import { useState } from 'react';
import { Phone, PhoneCall } from 'lucide-react';
import type { Customer } from 'shared-types';
import { apiFetch, ApiError } from '../shared/api';

type DialState = { status: 'idle' | 'dialing' | 'ok' | 'error'; message?: string };

/**
 * Customer-facing counterpart to CustomersPage.tsx's callCustomer() — same backend call
 * (POST /calls/dial-me instead of /calls/dial-out, but both land in the identical
 * PstnCallService.dial()), same real FreeSWITCH/Connectel/telephony-worker path, no separate
 * telephony architecture. Deliberately NOT the browser-microphone VoiceCallWidget used elsewhere
 * (SupportPage still uses that unchanged) — this rings the customer's own real phone on file,
 * the same way admin-initiated outbound calls already do.
 */
export function RealPhoneCallPanel({ token, customer }: { token: string; customer: Customer }) {
  const [state, setState] = useState<DialState>({ status: 'idle' });

  async function callMe() {
    setState({ status: 'dialing' });
    try {
      await apiFetch('/calls/dial-me', { method: 'POST', token });
      setState({ status: 'ok' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not place the call';
      setState({ status: 'error', message });
    }
  }

  return (
    <div className="card" style={{ padding: 24, textAlign: 'center' }}>
      <PhoneCall size={32} style={{ color: 'var(--accent)', marginBottom: 12 }} />
      <h3 style={{ marginBottom: 6 }}>Talk to us by phone</h3>
      <p className="text-muted" style={{ marginBottom: 16, fontSize: 13.5 }}>
        We'll call {customer.phone ?? 'your number on file'} right now.
      </p>
      {!customer.phone && (
        <p style={{ color: 'var(--danger)', fontSize: 13.5, marginBottom: 12 }}>
          No phone number on file for this account — a real call can't be placed yet.
        </p>
      )}
      <button
        className="btn"
        onClick={callMe}
        disabled={!customer.phone || state.status === 'dialing' || state.status === 'ok'}
        style={{ margin: '0 auto' }}
      >
        <Phone size={15} style={{ marginRight: 6 }} />
        {state.status === 'dialing' ? 'Calling your phone…' : state.status === 'ok' ? 'Calling…' : 'Call me now'}
      </button>
      {state.status === 'ok' && (
        <p style={{ color: 'var(--success)', fontSize: 13.5, marginTop: 12 }}>Your phone is ringing — answer to start talking.</p>
      )}
      {state.status === 'error' && (
        <p style={{ color: 'var(--danger)', fontSize: 13.5, marginTop: 12 }}>{state.message}</p>
      )}
    </div>
  );
}
