import { Fragment, FormEvent, useEffect, useState } from 'react';
import type { StaffUser, Ticket, TicketStatus } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';
import { formatDateTime, truncate } from '../shared/format';

const STATUS_OPTIONS: TicketStatus[] = [
  'NEW',
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
];

function TicketNotes({ ticketId, token }: { ticketId: string; token: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function load() {
    apiFetch<Ticket>(`/tickets/${ticketId}`, { token }).then(setTicket).catch(() => {});
  }

  useEffect(load, [ticketId, token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch(`/tickets/${ticketId}/messages`, { method: 'POST', token, body: { content: note } });
      setNote('');
      load();
    } finally {
      setSubmitting(false);
    }
  }

  if (!ticket) return <p>Loading…</p>;

  return (
    <div>
      {(ticket.messages ?? []).map((m) => (
        <div key={m.id} style={{ marginBottom: 8, fontSize: 13 }}>
          <strong>{m.authorType}</strong> — {m.content}
          <div className="text-muted" style={{ fontSize: 11 }}>{formatDateTime(m.createdAt)}</div>
        </div>
      ))}
      {(ticket.messages ?? []).length === 0 && <p style={{ color: '#999' }}>No notes yet.</p>}
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input className="input" placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn" type="submit" disabled={submitting}>
          Add
        </button>
      </form>
    </div>
  );
}

export function TicketsPage() {
  const { token } = useAdminAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  function load() {
    if (!token) return;
    apiFetch<Ticket[]>('/tickets', { token }).then(setTickets).catch(() => {});
  }

  useEffect(load, [token]);
  useEffect(() => {
    if (!token) return;
    apiFetch<StaffUser[]>('/users', { token }).then(setStaff).catch(() => {});
  }, [token]);

  async function updateStatus(id: string, status: TicketStatus) {
    if (!token) return;
    await apiFetch(`/tickets/${id}`, { method: 'PATCH', token, body: { status } });
    load();
  }

  async function assign(id: string, assignToUserId: string) {
    if (!token || !assignToUserId) return;
    await apiFetch(`/tickets/${id}`, { method: 'PATCH', token, body: { assignToUserId } });
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Tickets</h2>
          <p>{tickets.length} total</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Description</th>
              <th>Assigned to</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const currentAssignee = t.assignments?.[0]?.user.name;
              return (
                <Fragment key={t.id}>
                  <tr>
                    <td className="mono">{t.ticketNumber}</td>
                    <td>
                      <StatusBadge value={t.priority} />
                    </td>
                    <td>
                      <select className="input" value={t.status} onChange={(e) => updateStatus(t.id, e.target.value as TicketStatus)}>
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ maxWidth: 260 }} title={t.description}>
                      {truncate(t.description, 60)}
                    </td>
                    <td>
                      <select className="input" defaultValue="" onChange={(e) => assign(t.id, e.target.value)}>
                        <option value="" disabled>
                          {currentAssignee ?? 'Unassigned'}
                        </option>
                        {staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="text-muted">{formatDateTime(t.createdAt)}</td>
                    <td>
                      <button className="btn btn-ghost" onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                        {expanded === t.id ? 'Hide notes' : 'Notes'}
                      </button>
                    </td>
                  </tr>
                  {expanded === t.id && token && (
                    <tr>
                      <td colSpan={7} style={{ background: 'var(--surface-alt)' }}>
                        <TicketNotes ticketId={t.id} token={token} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
