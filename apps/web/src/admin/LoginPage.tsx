import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { ApiError } from '../shared/api';

export function LoginPage() {
  const { login } = useAdminAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-box" onSubmit={onSubmit}>
        <div className="brand-header">
          <span className="brand-mark">
            <ShieldCheck size={18} />
          </span>
          <span className="brand-name">Barq Bank</span>
        </div>
        <h2 style={{ marginBottom: 4 }}>Welcome back</h2>
        <p style={{ margin: '0 0 22px', color: 'var(--text-muted)', fontSize: 13.5 }}>
          Sign in to the staff console.
        </p>
        <div className="field">
          <label>Email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 13.5 }}>{error}</p>}
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', marginTop: 6 }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
