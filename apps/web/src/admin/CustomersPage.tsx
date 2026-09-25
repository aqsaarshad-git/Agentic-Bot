import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Phone, Pencil, UserPlus } from 'lucide-react';
import type { Customer, Call } from 'shared-types';
import { apiFetch, ApiError } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { formatDateTime } from '../shared/format';
import { Modal } from '../shared/Modal';

type DialState = { status: 'dialing' | 'ok' | 'error'; message?: string; conversationId?: string | null };

type CustomerFormState = { fullName: string; email: string; phone: string; language: string };

const EMPTY_FORM: CustomerFormState = { fullName: '', email: '', phone: '', language: 'ar' };

export function CustomersPage() {
  const { token, user } = useAdminAuth();
  const canManage = user?.role === 'ADMIN' || user?.role === 'AGENT';
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [dialState, setDialState] = useState<Record<string, DialState>>({});
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CustomerFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    if (!token) return;
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    apiFetch<Customer[]>(`/customers${query}`, { token }).then(setCustomers).catch(() => {});
  }

  useEffect(load, [token]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowCreate(true);
  }

  function openEdit(c: Customer) {
    setForm({ fullName: c.fullName, email: c.email ?? '', phone: c.phone ?? '', language: c.language });
    setFormError(null);
    setEditingCustomer(c);
  }

  function closeModals() {
    setShowCreate(false);
    setEditingCustomer(null);
  }

  async function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await apiFetch('/customers', {
        method: 'POST',
        token,
        body: {
          fullName: form.fullName,
          email: form.email || undefined,
          phone: form.phone || undefined,
          language: form.language || undefined,
        },
      });
      closeModals();
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create customer');
    } finally {
      setSubmitting(false);
    }
  }

  async function onEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || !editingCustomer) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await apiFetch(`/customers/${editingCustomer.id}`, {
        method: 'PATCH',
        token,
        body: {
          fullName: form.fullName,
          email: form.email || undefined,
          phone: form.phone || undefined,
          language: form.language || undefined,
        },
      });
      closeModals();
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to update customer');
    } finally {
      setSubmitting(false);
    }
  }

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
        {canManage && (
          <button className="btn" onClick={openCreate}>
            <UserPlus size={15} style={{ marginRight: 6 }} />
            Add customer
          </button>
        )}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {canManage && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 10px' }}
                          onClick={() => openEdit(c)}
                          title="Edit customer"
                        >
                          <Pencil size={14} />
                          Edit
                        </button>
                      )}
                      {c.phone && (
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
                      )}
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(showCreate || editingCustomer) && (
        <Modal title={editingCustomer ? 'Edit customer' : 'Add customer'} onClose={closeModals}>
          <form onSubmit={editingCustomer ? onEditSubmit : onCreateSubmit}>
            <div className="field">
              <label>Full name</label>
              <input
                className="input"
                value={form.fullName}
                onChange={(e) => setForm((prev) => ({ ...prev, fullName: e.target.value }))}
                required
              />
            </div>
            <div className="field">
              <label>Email</label>
              <input
                className="input"
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Phone</label>
              <input
                className="input"
                value={form.phone}
                onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))}
                placeholder="+9665XXXXXXXX"
              />
            </div>
            <div className="field">
              <label>Language</label>
              <select
                className="input"
                value={form.language}
                onChange={(e) => setForm((prev) => ({ ...prev, language: e.target.value }))}
              >
                <option value="ar">Arabic</option>
                <option value="en">English</option>
              </select>
            </div>
            {formError && <p style={{ color: 'var(--danger)', fontSize: 13.5, marginBottom: 12 }}>{formError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={closeModals}>
                Cancel
              </button>
              <button className="btn" type="submit" disabled={submitting}>
                {submitting ? 'Saving…' : editingCustomer ? 'Save changes' : 'Create customer'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
