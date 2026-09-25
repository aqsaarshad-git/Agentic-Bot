import { useEffect, useState } from 'react';
import { Bug } from 'lucide-react';
import type { Customer } from 'shared-types';
import { apiFetch } from '../shared/api';

interface VerificationStatusResponse {
  status: string;
  verificationLevel: 0 | 1 | 2;
  onlineBankingLocked: boolean;
  failedLoginAttempts: number;
  pendingTransfer: { transferReference: string; amount: number; currency: string } | null;
  lastTool: { name: string; status: string; executedAt: string } | null;
}

const LEVEL_LABEL = ['Public', 'Authenticated', 'Verified'];

/**
 * DEVELOPMENT / DEMO ONLY — rendered only when `import.meta.env.DEV` (see
 * BankingAssistantPage), i.e. never in a production build. Shows non-secret diagnostics only:
 * no OTP/PIN/password, no API keys, no DB credentials — just IDs and states already safe to
 * display to the customer viewing their own session.
 */
export function DevTestPanel({ token, customer, conversationId }: { token: string; customer: Customer; conversationId: string | null }) {
  const [status, setStatus] = useState<VerificationStatusResponse | null>(null);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    async function poll() {
      try {
        const result = await apiFetch<VerificationStatusResponse>(`/verification/status?conversationId=${conversationId}`, { token });
        if (alive) {
          setStatus(result);
          setFetchError(false);
        }
      } catch {
        if (alive) setFetchError(true);
      }
    }
    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [token, conversationId]);

  return (
    <div className="dev-panel">
      <h4>
        <Bug size={13} /> Dev Test Panel
      </h4>
      <span className="dev-badge" style={{ marginBottom: 10, display: 'inline-block' }}>
        Development / Demo only
      </span>
      <dl>
        <dt>Customer</dt>
        <dd>{customer.fullName}</dd>
        <dt>Customer ID</dt>
        <dd title={customer.id}>{customer.id.slice(0, 10)}…</dd>
        <dt>Conversation</dt>
        <dd title={conversationId ?? ''}>{conversationId ? `${conversationId.slice(0, 10)}…` : '—'}</dd>
        <dt>Verification</dt>
        <dd>{status?.status ?? (fetchError ? 'unavailable' : '…')}</dd>
        <dt>Verification level</dt>
        <dd>{status ? LEVEL_LABEL[status.verificationLevel] : '—'}</dd>
        <dt>Online banking</dt>
        <dd>{status ? (status.onlineBankingLocked ? 'LOCKED' : 'OK') : '—'}</dd>
        <dt>Pending transfer</dt>
        <dd>{status?.pendingTransfer ? `${status.pendingTransfer.amount} ${status.pendingTransfer.currency}` : 'none'}</dd>
        <dt>Last tool</dt>
        <dd>{status?.lastTool ? `${status.lastTool.name} (${status.lastTool.status})` : '—'}</dd>
      </dl>
    </div>
  );
}
