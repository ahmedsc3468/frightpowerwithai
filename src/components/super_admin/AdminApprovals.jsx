import React, { useEffect, useMemo, useState } from 'react';
import { auth } from '../../firebase';
import Toast from '../common/Toast';
import { API_URL } from '../../config';

export default function AdminApprovals() {
  const [pending, setPending] = useState([]);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState('');

  const sortedPending = useMemo(() => {
    const toMs = (v) => {
      if (!v) return 0;
      if (typeof v.toMillis === 'function') return v.toMillis();
      if (typeof v.seconds === 'number') return v.seconds * 1000;
      return 0;
    };
    return [...pending].sort((a, b) => toMs(b.created_at) - toMs(a.created_at));
  }, [pending]);

  const fetchPending = async () => {
    setLoading(true);
    try {
      const user = auth.currentUser;
      if (!user) {
        setToast({ type: 'error', message: 'Not signed in.' });
        setLoading(false);
        return;
      }

      const token = await user.getIdToken();
      const resp = await fetch(`${API_URL}/auth/admin-requests?status=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data?.detail || 'Failed to load admin requests.');
      }

      setRole('super_admin');
      setPending(Array.isArray(data?.requests) ? data.requests : []);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: err?.message || 'Failed to load admin requests.' });
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async (req) => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in.');
      const token = await user.getIdToken();

      const resp = await fetch(`${API_URL}/auth/admin-requests/${req.id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.detail || 'Approve failed.');

      setToast({ type: 'success', message: 'Admin approved.' });
      fetchPending();
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: err?.message || 'Approve failed.' });
    }
  };

  const reject = async (req) => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in.');
      const token = await user.getIdToken();

      const resp = await fetch(`${API_URL}/auth/admin-requests/${req.id}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.detail || 'Reject failed.');

      setToast({ type: 'success', message: 'Admin rejected.' });
      fetchPending();
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: err?.message || 'Reject failed.' });
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <Toast message={toast?.message} type={toast?.type} onClose={() => setToast(null)} />
      <h2 style={{ marginTop: 0 }}>Admin Approvals</h2>

      {loading && <div className="fp-card" style={{ padding: 14 }}>Loading…</div>}

      {!loading && sortedPending.length === 0 && (
        <div className="fp-card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>No pending admin requests.</div>
          <div className="muted" style={{ fontSize: 13 }}>
            If you just signed up an admin and don’t see it here, the most common causes are:
            (1) the request was not created in the backend, or
            (2) you’re connected to a different Firebase project.
          </div>
          {role && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Detected role: <strong>{role}</strong></div>
          )}
        </div>
      )}

      {!loading && sortedPending.length > 0 && (
        <div className="fp-card" style={{ padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', gap: 10, fontWeight: 700, marginBottom: 10 }}>
            <div>Name</div>
            <div>Email</div>
            <div>Status</div>
            <div>Actions</div>
          </div>

          {sortedPending.map((r) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', gap: 10, alignItems: 'center', padding: '10px 0', borderTop: '1px solid #eee' }}>
              <div>{r.name || '—'}</div>
              <div>{r.email || '—'}</div>
              <div style={{ fontWeight: 700, color: '#b45309' }}>Pending</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => approve(r)} style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #bbf7d0', background: '#dcfce7', fontWeight: 700, cursor: 'pointer' }}>Approve</button>
                <button onClick={() => reject(r)} style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #fecaca', background: '#fee2e2', fontWeight: 700, cursor: 'pointer' }}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
