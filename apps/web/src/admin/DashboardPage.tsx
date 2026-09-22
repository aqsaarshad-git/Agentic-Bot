import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, MessagesSquare, Ticket as TicketIcon, AlertTriangle } from 'lucide-react';
import type { Customer, Conversation, Ticket } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';

export function DashboardPage() {
  const { token } = useAdminAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);

  useEffect(() => {
    if (!token) return;
    apiFetch<Customer[]>('/customers', { token }).then(setCustomers).catch(() => {});
    apiFetch<Conversation[]>('/conversations', { token }).then(setConversations).catch(() => {});
    apiFetch<Ticket[]>('/tickets', { token }).then(setTickets).catch(() => {});
  }, [token]);

  const openTickets = tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length;
  const escalating = conversations.filter((c) => c.state === 'ESCALATING').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Dashboard</h2>
          <p>A quick pulse on customer activity — see Analytics for latency and trend breakdowns.</p>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            <Users size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
            Customers
          </div>
          <div className="stat-value">{customers.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <MessagesSquare size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
            Conversations
          </div>
          <div className="stat-value">{conversations.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <TicketIcon size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
            Open tickets
          </div>
          <div className="stat-value">{openTickets}</div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{tickets.length} total</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <AlertTriangle size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
            Needs a human
          </div>
          <div className="stat-value">{escalating}</div>
          {escalating > 0 && (
            <Link to="/admin/escalations" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>
              View escalations →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
