import { useEffect, useState } from 'react';
import type { AnalyticsSummary } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { formatEnumLabel } from '../shared/format';

// Fixed categorical palette — a category's color comes from its identity (hash), never
// from its position in the current result set, so it never repaints as filters change.
const CATEGORICAL_PALETTE = ['#3b5fe0', '#b45309', '#7c3aed', '#0d9488', '#db2777', '#475569', '#059669', '#b91c1c'];
function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return CATEGORICAL_PALETTE[hash % CATEGORICAL_PALETTE.length];
}

const OK_COLOR = 'var(--success)';
const CRITICAL_COLOR = 'var(--danger)';

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '24px 0 10px' }}>
      {children}
    </div>
  );
}

function BarBreakdown({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="card">
      <h3 style={{ marginBottom: 12, fontSize: 15 }}>{title}</h3>
      {entries.length === 0 && <p className="text-muted">No data in this range.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map(([key, value]) => (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 36px', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13 }}>{formatEnumLabel(key)}</span>
            <div style={{ background: 'var(--surface-alt)', borderRadius: 4, overflow: 'hidden', height: 10 }}>
              <div
                style={{ width: `${(value / max) * 100}%`, background: colorForKey(key), height: '100%', borderRadius: 4 }}
              />
            </div>
            <span style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolSuccessFailureChart({ byTool }: { byTool: { name: string; success: number; failure: number }[] }) {
  const max = Math.max(1, ...byTool.map((t) => t.success + t.failure));
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15 }}>Tool executions</h3>
        <div style={{ display: 'flex', gap: 14, fontSize: 12 }} className="text-muted">
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: OK_COLOR, borderRadius: 2, marginRight: 4 }} />success</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: CRITICAL_COLOR, borderRadius: 2, marginRight: 4 }} />failure</span>
        </div>
      </div>
      {byTool.length === 0 && <p className="text-muted">No tool calls in this range.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {byTool.map((t) => (
          <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 60px', gap: 8, alignItems: 'center' }}>
            <span className="mono">{t.name}</span>
            <div style={{ display: 'flex', background: 'var(--surface-alt)', borderRadius: 4, overflow: 'hidden', height: 10 }}>
              <div style={{ width: `${(t.success / max) * 100}%`, background: OK_COLOR }} />
              <div style={{ width: `${(t.failure / max) * 100}%`, background: CRITICAL_COLOR }} />
            </div>
            <span className="text-muted" style={{ fontSize: 12, textAlign: 'right' }}>
              {t.success + t.failure} calls
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatMs(n: number | null): string {
  if (n === null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

export function AnalyticsPage() {
  const { token } = useAdminAuth();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function load() {
    if (!token) return;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    apiFetch<AnalyticsSummary>(`/analytics/summary${qs ? `?${qs}` : ''}`, { token }).then(setSummary).catch(() => {});
  }

  useEffect(load, [token]);

  if (!summary) return <p className="text-muted">Loading…</p>;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const secs = (n: number | null) => (n === null ? '—' : `${Math.round(n)}s`);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Analytics</h2>
          <p>Volume, resolution, and system health at a glance.</p>
        </div>
      </div>
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>From</label>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>To</label>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn" onClick={load}>
          Apply filter
        </button>
      </div>

      <SectionTitle>Volume</SectionTitle>
      <div className="stat-grid">
        <StatTile label="Conversations" value={String(summary.conversations.total)} />
        <StatTile label="Escalation rate" value={pct(summary.conversations.escalationRate)} />
        <StatTile label="Calls" value={String(summary.calls.total)} hint={`avg ${secs(summary.calls.avgDurationSeconds)}`} />
        <StatTile label="Tickets" value={String(summary.tickets.total)} />
      </div>

      <SectionTitle>System health</SectionTitle>
      <div className="stat-grid">
        <StatTile label="Tool failure rate" value={pct(summary.tools.failureRate)} hint={`${summary.tools.failures}/${summary.tools.totalExecutions} failed`} />
        <StatTile label="LLM errors" value={String(summary.llm.errorCount)} />
        <StatTile label="Avg LLM latency" value={formatMs(summary.llm.avgLatencyMs)} />
        <StatTile label="Avg STT latency" value={formatMs(summary.voice.avgSttLatencyMs)} />
        <StatTile label="Avg TTS latency" value={formatMs(summary.voice.avgTtsLatencyMs)} />
        <StatTile label="Avg total response" value={formatMs(summary.avgTotalResponseMs)} />
      </div>

      <SectionTitle>Breakdowns</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <BarBreakdown title="Conversations by state" data={summary.conversations.byState} />
        <BarBreakdown title="Tickets by status" data={summary.tickets.byStatus} />
        <BarBreakdown title="Tickets by priority" data={summary.tickets.byPriority} />
        <BarBreakdown title="Calls by outcome" data={summary.calls.byOutcome} />
        <BarBreakdown title="Callbacks by status" data={summary.callbacks.byStatus} />
        <BarBreakdown title="Campaign contacts by status" data={summary.campaigns.contactsByStatus} />
        <ToolSuccessFailureChart byTool={summary.tools.byTool} />
      </div>
    </div>
  );
}
