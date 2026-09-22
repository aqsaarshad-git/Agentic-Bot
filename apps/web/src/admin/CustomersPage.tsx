import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Phone } from 'lucide-react';
import type { Customer, Call } from 'shared-types';
import { apiFetch, ApiError } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { formatDateTime } from '../shared/format';

type DialState = { status: 'dialing' | 'ok' | 'error'; message?: string; conversationId?: string | null };

export function CustomersPage() {
  const { token } = useAdminAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [dialState, setDialState] = useState<Record<string, DialState>>({});

  function load() {
    if (!token) return;
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    apiFetch<Customer[]>(`/customers${query}`, { token }).then(setCustomers).catch(() => {});
  }

  useEffect(load, [token]);

  async function callCustomer(c: Customer) {
    if (!token || !c.phone) return;
    setDialState((prev) => ({ ...prev, [c.id]: { status: 'dialing' } }));
    try {
      const { call } = await apiFetch<{ call: Call }>('/calls/dial-out', {
        method: 'POST',
        token,
        body: { customerId: c.id, phoneNumber: c.phone },
      });
      setDialState((prev) => ({ ...prev, [c.id]: { status: 'ok', conversationId: call.conversationId } }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to place call';
      setDialState((prev) => ({ ...prev, [c.id]: { status: 'error', message } }));
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Customers</h2>
          <p>{customers.length} total</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, padding: 16, borderBottom: '1px solid var(--border)' }}>
          <input
            className="input"
            placeholder="Search by name, email, or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-secondary" onClick={load}>
            <Search size={15} />
            Search
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Language</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => {
              const state = dialState[c.id];
              return (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.fullName}</td>
                  <td className="text-muted">{c.email ?? '—'}</td>
                  <td className="text-muted">{c.phone ?? '—'}</td>
                  <td>{c.language === 'ar' ? 'Arabic' : c.language === 'en' ? 'English' : c.language}</td>
                  <td className="text-muted">{formatDateTime(c.createdAt)}</td>
                  <td>
                    {c.phone && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 10px' }}
                          disabled={state?.status === 'dialing'}
                          onClick={() => callCustomer(c)}
                          title={`Call ${c.phone}`}
                        >
                          <Phone size={14} />
                          {state?.status === 'dialing' ? 'Dialing…' : 'Call'}
                        </button>
                        {state?.status === 'ok' && (
                          <span style={{ color: 'var(--success)', fontSize: 13 }}>
                            Calling
                            {state.conversationId && (
                              <>
                                {' — '}
                                <Link to={`/admin/conversations/${state.conversationId}`} style={{ color: 'var(--accent)' }}>
                                  view transcript
                                </Link>
                              </>
                            )}
                          </span>
                        )}
                        {state?.status === 'error' && (
                          <span style={{ color: 'var(--danger)', fontSize: 13 }} title={state.message}>
                            {state.message}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
