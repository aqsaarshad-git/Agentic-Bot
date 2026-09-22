import { Construction } from 'lucide-react';

export function ComingSoonPage({ title }: { title: string; phase?: number }) {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
        <Construction size={28} style={{ marginBottom: 10, opacity: 0.5 }} />
        <p style={{ margin: 0 }}>{title} is coming soon.</p>
      </div>
    </div>
  );
}
