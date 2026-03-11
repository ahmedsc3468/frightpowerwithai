import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getIdToken, signInWithCustomToken } from 'firebase/auth';
import { auth } from '../../firebase';
import Toast from '../common/Toast';
import { API_URL } from '../../config';

export default function SuperAdminLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);


  const handleSubmit = async (e) => {
    e.preventDefault();
    setToast(null);

    setLoading(true);
    try {
      const resp = await fetch(`${API_URL}/auth/super-admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data?.detail || 'Super admin login failed');
      }

      await signInWithCustomToken(auth, data.custom_token);
      if (auth.currentUser) {
        await getIdToken(auth.currentUser, true);
      }
      const from = location?.state?.from;
      const fromPath = from?.pathname ? `${from.pathname}${from.search || ''}` : '';
      navigate(fromPath || '/super-admin/dashboard', { replace: true });
    } catch (err) {
      console.error(err);
      setToast({
        type: 'error',
        message: err?.message || 'Super admin login failed.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24, background: '#f5f7fa' }}>
      <Toast message={toast?.message} type={toast?.type} onClose={() => setToast(null)} />
      <div style={{ width: '100%', maxWidth: 420, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18, boxShadow: '0 12px 30px rgba(16,24,40,0.08)' }}>
        <h2 style={{ margin: 0 }}>Super Admin Login</h2>
        <p style={{ marginTop: 8, marginBottom: 16, color: '#6b7280' }}>Authorized personnel only.</p>

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #e5e7eb', marginBottom: 12 }}
            autoComplete="username"
          />

          <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>Password</label>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #e5e7eb', marginBottom: 16 }}
            autoComplete="current-password"
          />

          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: 12, borderRadius: 12, border: 'none', background: '#111827', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
