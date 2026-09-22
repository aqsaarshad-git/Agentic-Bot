import { FormEvent, useEffect, useState } from 'react';
import type { KnowledgeDocument, KnowledgeDocumentStatus } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { formatDateTime } from '../shared/format';

const STATUS_OPTIONS: KnowledgeDocumentStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

export function KnowledgeBasePage() {
  const { token } = useAdminAuth();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function load() {
    if (!token) return;
    apiFetch<KnowledgeDocument[]>('/knowledge-documents', { token }).then(setDocuments).catch(() => {});
  }

  useEffect(load, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    try {
      await apiFetch('/knowledge-documents', {
        method: 'POST',
        token,
        body: { title, category: category || undefined, content, status: 'PUBLISHED' },
      });
      setTitle('');
      setCategory('');
      setContent('');
      load();
    } finally {
      setSubmitting(false);
    }
  }

  async function updateStatus(id: string, status: KnowledgeDocumentStatus) {
    if (!token) return;
    await apiFetch(`/knowledge-documents/${id}`, { method: 'PATCH', token, body: { status } });
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Knowledge Base</h2>
          <p>Only Published documents are retrieved by the AI when answering policy/FAQ questions.</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td style={{ fontWeight: 600 }}>{d.title}</td>
                <td className="text-muted">{d.category ?? '—'}</td>
                <td>
                  <select className="input" value={d.status} onChange={(e) => updateStatus(d.id, e.target.value as KnowledgeDocumentStatus)}>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-muted">{formatDateTime(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>New document</h3>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label>Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="field">
            <label>Category</label>
            <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div className="field">
            <label>Content</label>
            <textarea className="input" rows={8} value={content} onChange={(e) => setContent(e.target.value)} required />
          </div>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Publishing…' : 'Publish'}
          </button>
        </form>
      </div>
    </div>
  );
}
