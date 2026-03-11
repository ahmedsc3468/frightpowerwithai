import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import { getJson, postJson } from '../../api/http';

import '../../styles/driver/AccountSettings.css';
import '../../styles/shipper/ShipperProfile.css';

const TABS = ['Profile', 'Security', 'Activity'];

function formatTs(ts) {
  if (!ts) return '—';
  const n = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
  return new Date(n).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ShipperProfile({ onProfileUpdate }) {
  const { currentUser } = useAuth();
  const fileInputRef = useRef(null);
  const w9InputRef = useRef(null);

  const FALLBACK_AVATAR_URL = 'https://randomuser.me/api/portraits/men/32.jpg';

  const [isDarkMode, setIsDarkMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [activeTab, setActiveTab] = useState('Profile');

  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [onboardingSaving, setOnboardingSaving] = useState(false);
  const [w9Uploading, setW9Uploading] = useState(false);
  const [onboardingMissing, setOnboardingMissing] = useState({
    requiredFields: [], optionalFields: [], documents: [],
  });

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState({ type: '', text: '' });

  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoaded, setActivityLoaded] = useState(false);

  const [profileData, setProfileData] = useState({
    businessName: '',
    businessType: '',
    taxId: '',
    website: '',
    contactFullName: '',
    contactTitle: '',
    phone: '',
    email: '',
    address: '',
    billingAddress: '',
    profilePicture: null,
    onboardingCompleted: false,
    onboardingScore: 0,
    createdAt: null,
    role: 'shipper',
  });

  useEffect(() => {
    const detectDark = () => {
      const root = document.querySelector('.fp-dashboard-root');
      if (root) return root.classList.contains('dark-root');
      return document.body.classList.contains('dark-root');
    };
    const update = () => setIsDarkMode(detectDark());
    update();
    const root = document.querySelector('.fp-dashboard-root');
    if (!root) return;
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const fetchProfile = async () => {
    if (!currentUser) { setLoading(false); return; }
    try {
      setLoading(true);
      const me = await getJson('/auth/me', { requestLabel: 'GET /auth/me (shipper profile)' });
      setProfileData({
        businessName: me?.company_name || '',
        businessType: me?.business_type || '',
        taxId: me?.tax_id || '',
        website: me?.website || '',
        contactFullName: me?.name || '',
        contactTitle: me?.contact_title || '',
        phone: me?.phone || '',
        email: me?.email || currentUser.email || '',
        address: me?.address || '',
        billingAddress: me?.billing_address || '',
        profilePicture: me?.profile_picture_url || null,
        onboardingCompleted: me?.onboarding_completed || false,
        onboardingScore: me?.onboarding_score || 0,
        createdAt: me?.created_at || null,
        role: me?.role || 'shipper',
      });
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || 'Failed to load profile data' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProfile(); }, [currentUser]); // eslint-disable-line

  const refreshOnboardingMissing = async () => {
    if (!currentUser) return;
    try {
      setOnboardingLoading(true);
      const data = await getJson('/onboarding/shipper/missing', {
        requestLabel: 'GET /onboarding/shipper/missing',
      });
      setOnboardingMissing({
        requiredFields: Array.isArray(data?.missing_required_fields) ? data.missing_required_fields : [],
        optionalFields: Array.isArray(data?.missing_optional_fields) ? data.missing_optional_fields : [],
        documents: Array.isArray(data?.missing_documents) ? data.missing_documents : [],
      });
    } catch {
      setOnboardingMissing({ requiredFields: [], optionalFields: [], documents: [] });
    } finally {
      setOnboardingLoading(false);
    }
  };

  useEffect(() => { refreshOnboardingMissing(); }, [currentUser]); // eslint-disable-line

  useEffect(() => {
    if (activeTab !== 'Activity' || activityLoaded || !currentUser) return;
    (async () => {
      setActivityLoading(true);
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`${API_URL}/auth/profile/updates`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        setActivity(json.items || []);
        setActivityLoaded(true);
      } catch {
        setActivity([]);
      } finally {
        setActivityLoading(false);
      }
    })();
  }, [activeTab, activityLoaded, currentUser]);

  const handleInputChange = (field, value) =>
    setProfileData(p => ({ ...p, [field]: value }));

  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setMessage({ type: 'error', text: 'Invalid file type. Use JPG, PNG, GIF, or WebP.' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'File size must be less than 5 MB.' });
      return;
    }
    try {
      setUploading(true);
      setMessage({ type: '', text: '' });
      const token = await currentUser.getIdToken();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/auth/profile/picture`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.detail || 'Failed to upload profile picture');
      }
      const result = await res.json();
      setProfileData(p => ({ ...p, profilePicture: result.profile_picture_url }));
      setMessage({ type: 'success', text: 'Profile picture updated!' });
      if (typeof onProfileUpdate === 'function')
        await Promise.resolve(onProfileUpdate({ profile_picture_url: result.profile_picture_url }));
      setTimeout(() => setMessage({ type: '', text: '' }), 3000);
    } catch (e2) {
      setMessage({ type: 'error', text: e2?.message || 'Upload failed.' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const saveProfileUpdate = async ({ showMessage = true } = {}) => {
    if (!currentUser) return;
    try {
      setSaving(true);
      if (showMessage) setMessage({ type: '', text: '' });
      const updateData = {
        company_name: profileData.businessName,
        business_type: profileData.businessType,
        tax_id: profileData.taxId,
        website: profileData.website,
        phone: profileData.phone,
        address: profileData.address,
        billing_address: profileData.billingAddress,
        contact_title: profileData.contactTitle,
      };
      if (profileData.contactFullName) {
        updateData.name = profileData.contactFullName;
        const parts = profileData.contactFullName.split(' ').filter(Boolean);
        if (parts.length > 0) {
          updateData.first_name = parts[0];
          if (parts.length > 1) updateData.last_name = parts.slice(1).join(' ');
        }
      }
      await postJson('/auth/profile/update', updateData, {
        requestLabel: 'POST /auth/profile/update (shipper profile)',
      });
      if (showMessage) setMessage({ type: 'success', text: 'Profile saved!' });
      if (typeof onProfileUpdate === 'function') onProfileUpdate();
      await fetchProfile();
      refreshOnboardingMissing();
      if (showMessage) setTimeout(() => setMessage({ type: '', text: '' }), 3000);
    } catch (e) {
      if (showMessage)
        setMessage({ type: 'error', text: e?.message || 'Failed to save profile.' });
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProfile = async () => {
    try { await saveProfileUpdate({ showMessage: true }); } catch { /* handled */ }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwMsg({ type: '', text: '' });
    if (pwForm.next.length < 8) {
      setPwMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    if (pwForm.current === pwForm.next) {
      setPwMsg({ type: 'error', text: 'New password must differ from current password.' });
      return;
    }
    try {
      setPwSaving(true);
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/auth/password/change`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ current_password: pwForm.current, new_password: pwForm.next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.detail || 'Password change failed.');
      }
      setPwMsg({ type: 'success', text: 'Password changed successfully!' });
      setPwForm({ current: '', next: '', confirm: '' });
    } catch (err) {
      setPwMsg({ type: 'error', text: err?.message || 'Password change failed.' });
    } finally {
      setPwSaving(false);
    }
  };

  const hasAnyOnboardingMissing =
    (onboardingMissing?.requiredFields || []).length > 0 ||
    (onboardingMissing?.optionalFields || []).length > 0 ||
    (onboardingMissing?.documents || []).length > 0;
  const modalMissingFields = [
    ...(onboardingMissing?.requiredFields || []),
    ...(onboardingMissing?.optionalFields || []),
  ];

  const openOnboardingModal = async () => {
    setOnboardingOpen(true);
    await refreshOnboardingMissing();
  };
  const closeOnboardingModal = () => {
    if (onboardingSaving || w9Uploading) return;
    setOnboardingOpen(false);
  };

  const uploadW9 = async (file) => {
    if (!file || !currentUser) return;
    const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    if (!allowed.includes(file.type)) {
      setMessage({ type: 'error', text: 'W9 must be a PDF, JPG, or PNG file.' });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'W9 file size must be less than 25 MB.' });
      return;
    }
    try {
      setW9Uploading(true);
      const token = await currentUser.getIdToken();
      const fd = new FormData();
      fd.append('file', file);
      fd.append('document_type', 'w9');
      const res = await fetch(`${API_URL}/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to upload W9');
      setMessage({ type: 'success', text: 'W9 uploaded successfully!' });
      await refreshOnboardingMissing();
      setTimeout(() => setMessage({ type: '', text: '' }), 2500);
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || 'Failed to upload W9.' });
    } finally {
      setW9Uploading(false);
      if (w9InputRef.current) w9InputRef.current.value = '';
    }
  };

  const completeOnboarding = async () => {
    if (!currentUser) return;
    try {
      setOnboardingSaving(true);
      setMessage({ type: '', text: '' });
      await saveProfileUpdate({ showMessage: false });
      await postJson('/onboarding/shipper/complete', {}, {
        requestLabel: 'POST /onboarding/shipper/complete',
      });
      setMessage({ type: 'success', text: 'Onboarding completed!' });
      if (typeof onProfileUpdate === 'function') onProfileUpdate();
      await refreshOnboardingMissing();
      setOnboardingOpen(false);
      setTimeout(() => setMessage({ type: '', text: '' }), 2500);
    } catch (e) {
      setMessage({
        type: 'error',
        text: e?.message || 'Unable to complete onboarding. Review missing items.',
      });
      await refreshOnboardingMissing();
    } finally {
      setOnboardingSaving(false);
    }
  };

  const completionPct = (() => {
    const fields = [
      profileData.businessName,
      profileData.contactFullName,
      profileData.phone,
      profileData.email,
      profileData.address,
      profileData.profilePicture,
      profileData.businessType,
    ];
    const filled = fields.filter(f => f && String(f).trim()).length;
    return Math.round((filled / fields.length) * 100);
  })();

  const asTheme = {
    text: isDarkMode ? '#f1f5f9' : '#0f172a',
    muted: isDarkMode ? '#94a3b8' : '#6b7280',
    surface: isDarkMode ? '#1e293b' : '#f8fafc',
    border: isDarkMode ? '#334155' : '#e5e7eb',
  };

  const barColor = completionPct >= 80 ? '#22c55e' : completionPct >= 50 ? '#f59e0b' : '#ef4444';

  if (loading) {
    return (
      <div className="account-settings-container">
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 240 }}>
          <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }} />
          <span style={{ marginLeft: 10 }}>Loading profile...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="account-settings-container" style={{ padding: 0, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>

      {message.text && (
        <div style={{
          padding: '12px 16px',
          marginBottom: 16,
          borderRadius: 8,
          background: message.type === 'success' ? '#d1fae5' : '#fee2e2',
          color: message.type === 'success' ? '#065f46' : '#991b1b',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <i className={`fa-solid ${message.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}`} />
          {message.text}
        </div>
      )}

      <div className="sp-hero-card" style={{
        background: isDarkMode ? '#2c2c2c' : '#fff',
        borderRadius: 12,
        padding: '24px 28px',
        marginBottom: 20,
        border: `1px solid ${asTheme.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        flexWrap: 'wrap',
      }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <img
            src={profileData.profilePicture || FALLBACK_AVATAR_URL}
            alt="Avatar"
            onError={e => { e.target.src = FALLBACK_AVATAR_URL; }}
            style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Change photo"
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 26, height: 26, borderRadius: '50%',
              background: '#3b82f6', border: '2px solid #fff',
              color: '#fff', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 11,
            }}
          >
            {uploading
              ? <i className="fa-solid fa-spinner fa-spin" />
              : <i className="fa-solid fa-camera" />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            onChange={handlePhotoChange}
            style={{ display: 'none' }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontWeight: 700, fontSize: 20, color: asTheme.text }}>
            {profileData.businessName || profileData.contactFullName || 'Shipper Account'}
          </div>
          <div style={{ color: asTheme.muted, fontSize: 13, marginTop: 2 }}>
            {profileData.email}
            {profileData.phone && ` · ${profileData.phone}`}
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: asTheme.muted }}>Profile completion</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: barColor }}>{completionPct}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 99, background: isDarkMode ? '#374151' : '#e5e7eb', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${completionPct}%`, background: barColor, borderRadius: 99, transition: 'width .4s' }} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 18, color: asTheme.text }}>
              {profileData.onboardingCompleted ? '✓' : '—'}
            </div>
            <div style={{ fontSize: 11, color: asTheme.muted }}>Onboarding</div>
          </div>
          <div style={{ width: 1, height: 32, background: asTheme.border }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 18, color: asTheme.text }}>
              {profileData.onboardingScore || 0}
            </div>
            <div style={{ fontSize: 11, color: asTheme.muted }}>Score</div>
          </div>
          <div style={{ width: 1, height: 32, background: asTheme.border }} />
          <span style={{
            padding: '4px 10px',
            borderRadius: 99,
            background: '#dbeafe',
            color: '#1d4ed8',
            fontSize: 12,
            fontWeight: 700,
            textTransform: 'capitalize',
          }}>
            {profileData.role}
          </span>
        </div>
      </div>

      {hasAnyOnboardingMissing && (
        <div style={{
          background: isDarkMode ? '#1e293b' : '#fffbeb',
          border: `1px solid ${isDarkMode ? '#854d0e' : '#fde68a'}`,
          borderRadius: 10,
          padding: '12px 16px',
          marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 700, color: isDarkMode ? '#fde68a' : '#92400e' }}>
              <i className="fa-solid fa-triangle-exclamation" /> Onboarding incomplete
            </div>
            <div style={{ color: asTheme.muted, fontSize: 13 }}>
              {(onboardingMissing.requiredFields || []).length} required field(s) missing.
            </div>
          </div>
          <button
            type="button"
            className="btn small ghost-cd"
            onClick={openOnboardingModal}
            disabled={onboardingLoading}
          >
            {onboardingLoading ? 'Loading...' : 'Complete onboarding'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: `1px solid ${asTheme.border}`, paddingBottom: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '8px 18px',
              border: 'none',
              background: 'transparent',
              borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === tab ? '#3b82f6' : asTheme.muted,
              fontWeight: activeTab === tab ? 700 : 400,
              fontSize: 14,
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab === 'Profile' && <i className="fa-solid fa-user" style={{ marginRight: 6 }} />}
            {tab === 'Security' && <i className="fa-solid fa-shield-halved" style={{ marginRight: 6 }} />}
            {tab === 'Activity' && <i className="fa-solid fa-clock-rotate-left" style={{ marginRight: 6 }} />}
            {tab}
          </button>
        ))}
      </div>

      {/* PROFILE TAB */}
      {activeTab === 'Profile' && (
        <div className="profile-preferences-section">
          <div className="profile-card">
            <div className="profile-card-title">Business Information</div>

            <div className="profile-field">
              <label>Business Name</label>
              <input
                type="text"
                value={profileData.businessName}
                onChange={e => handleInputChange('businessName', e.target.value)}
                placeholder="Business Name"
              />
            </div>

            <div className="profile-field">
              <label>Business Type</label>
              <select
                value={profileData.businessType}
                onChange={e => handleInputChange('businessType', e.target.value)}
                style={{
                  width: '100%', padding: 8, borderRadius: 6,
                  border: `1px solid ${asTheme.border}`,
                  background: isDarkMode ? '#2c2c2c' : '#fff',
                  color: asTheme.text,
                }}
              >
                <option value="">Select type</option>
                <option value="shipper">Shipper</option>
                <option value="broker">Broker</option>
              </select>
            </div>

            <div className="profile-field">
              <label>Tax ID (EIN)</label>
              <input
                type="text"
                value={profileData.taxId}
                onChange={e => handleInputChange('taxId', e.target.value)}
                placeholder="Tax ID (EIN)"
              />
            </div>

            <div className="profile-field">
              <label>Primary Contact Name</label>
              <input
                type="text"
                value={profileData.contactFullName}
                onChange={e => handleInputChange('contactFullName', e.target.value)}
                placeholder="Full name"
              />
            </div>

            <div className="profile-field">
              <label>Contact Title</label>
              <input
                type="text"
                value={profileData.contactTitle}
                onChange={e => handleInputChange('contactTitle', e.target.value)}
                placeholder="Title / Role"
              />
            </div>

            <div className="profile-field">
              <label>Phone</label>
              <input
                type="text"
                value={profileData.phone}
                onChange={e => handleInputChange('phone', e.target.value)}
                placeholder="+1 (555) 123-4567"
              />
            </div>

            <div className="profile-field">
              <label>Email</label>
              <input
                type="email"
                value={profileData.email}
                readOnly
                style={{
                  background: isDarkMode ? '#1e293b' : '#f3f4f6',
                  color: asTheme.muted, cursor: 'not-allowed',
                }}
              />
              <span style={{ fontSize: 12, color: asTheme.muted }}>Email address cannot be changed here.</span>
            </div>

            <div className="profile-field">
              <label>Address</label>
              <textarea
                value={profileData.address}
                rows={2}
                onChange={e => handleInputChange('address', e.target.value)}
                placeholder="123 Main St, Dallas, TX 75201"
              />
            </div>

            <div className="profile-field">
              <label>Website</label>
              <input
                type="text"
                value={profileData.website}
                onChange={e => handleInputChange('website', e.target.value)}
                placeholder="https://"
              />
            </div>

            <div className="profile-field">
              <label>Billing Address</label>
              <textarea
                value={profileData.billingAddress}
                rows={2}
                onChange={e => handleInputChange('billingAddress', e.target.value)}
                placeholder="Billing address for invoices"
              />
            </div>

            <button
              className="btn small-cd"
              onClick={handleSaveProfile}
              disabled={saving}
              style={{ marginTop: 16, width: '100%' }}
            >
              {saving ? <><i className="fa-solid fa-spinner fa-spin" /> Saving...</> : 'Save Changes'}
            </button>
          </div>

          <div className="profile-card">
            <div className="profile-card-title">Account Details</div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: asTheme.muted, marginBottom: 6 }}>Profile Photo</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <img
                  src={profileData.profilePicture || FALLBACK_AVATAR_URL}
                  alt="Profile"
                  onError={e => { e.target.src = FALLBACK_AVATAR_URL; }}
                  style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover' }}
                />
                <div>
                  <button className="btn small ghost-cd" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    {uploading ? 'Uploading...' : 'Change Photo'}
                  </button>
                  <div style={{ fontSize: 12, color: asTheme.muted, marginTop: 4 }}>JPG, PNG, WebP — max 5 MB</div>
                </div>
              </div>
            </div>

            <div style={{ background: asTheme.surface, borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'User ID', value: currentUser?.uid || '—', mono: true },
                { label: 'Role', value: profileData.role, capitalize: true },
                { label: 'Onboarding', value: profileData.onboardingCompleted ? 'Complete' : 'Incomplete', badge: true, ok: profileData.onboardingCompleted },
                { label: 'Score', value: String(profileData.onboardingScore || 0) },
                { label: 'Email', value: profileData.email || '—' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                  <span style={{ color: asTheme.muted }}>{row.label}</span>
                  {row.badge ? (
                    <span style={{
                      padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                      background: row.ok ? '#d1fae5' : '#fef3c7',
                      color: row.ok ? '#065f46' : '#92400e',
                    }}>{row.value}</span>
                  ) : (
                    <span style={{
                      color: asTheme.text,
                      fontFamily: row.mono ? 'monospace' : undefined,
                      fontSize: row.mono ? 11 : 13,
                      maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      textTransform: row.capitalize ? 'capitalize' : undefined,
                    }}>{row.value}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SECURITY TAB */}
      {activeTab === 'Security' && (
        <div className="profile-preferences-section">
          <div className="profile-card">
            <div className="profile-card-title">Change Password</div>

            {pwMsg.text && (
              <div style={{
                padding: '10px 14px',
                marginBottom: 14,
                borderRadius: 8,
                background: pwMsg.type === 'success' ? '#d1fae5' : '#fee2e2',
                color: pwMsg.type === 'success' ? '#065f46' : '#991b1b',
                display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
              }}>
                <i className={`fa-solid ${pwMsg.type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}`} />
                {pwMsg.text}
              </div>
            )}

            <form onSubmit={handleChangePassword}>
              <div className="profile-field">
                <label>Current Password</label>
                <input
                  type="password"
                  value={pwForm.current}
                  onChange={e => setPwForm(p => ({ ...p, current: e.target.value }))}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                  required
                />
              </div>
              <div className="profile-field">
                <label>New Password</label>
                <input
                  type="password"
                  value={pwForm.next}
                  onChange={e => setPwForm(p => ({ ...p, next: e.target.value }))}
                  placeholder="Minimum 8 characters"
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="profile-field">
                <label>Confirm New Password</label>
                <input
                  type="password"
                  value={pwForm.confirm}
                  onChange={e => setPwForm(p => ({ ...p, confirm: e.target.value }))}
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                  required
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
                {[
                  { ok: pwForm.next.length >= 8, label: 'At least 8 characters' },
                  { ok: pwForm.next === pwForm.confirm && pwForm.next.length > 0, label: 'Passwords match' },
                  { ok: pwForm.current !== pwForm.next || !pwForm.next, label: 'Different from current' },
                ].map(rule => (
                  <span key={rule.label} style={{ fontSize: 12, color: rule.ok ? '#16a34a' : asTheme.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <i className={`fa-solid fa-${rule.ok ? 'circle-check' : 'circle-xmark'}`} style={{ color: rule.ok ? '#16a34a' : '#d1d5db' }} />
                    {rule.label}
                  </span>
                ))}
              </div>

              <button
                type="submit"
                className="btn small-cd"
                disabled={pwSaving || !pwForm.current || !pwForm.next || pwForm.next !== pwForm.confirm}
                style={{ width: '100%' }}
              >
                {pwSaving ? <><i className="fa-solid fa-spinner fa-spin" /> Updating...</> : 'Update Password'}
              </button>
            </form>
          </div>

          <div className="profile-card">
            <div className="profile-card-title">Security Overview</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { icon: 'fa-envelope-circle-check', label: 'Email Authentication', badge: 'Active', ok: true },
                { icon: 'fa-key', label: 'Password', badge: 'Set', ok: true },
                { icon: 'fa-shield-halved', label: 'Account Status', badge: 'Verified', ok: true },
              ].map(item => (
                <div key={item.label} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', borderRadius: 8, background: asTheme.surface, fontSize: 13,
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: asTheme.text }}>
                    <i className={`fa-solid ${item.icon}`} style={{ color: '#3b82f6' }} />
                    {item.label}
                  </span>
                  <span style={{
                    padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                    background: item.ok ? '#d1fae5' : '#fee2e2',
                    color: item.ok ? '#065f46' : '#991b1b',
                  }}>{item.badge}</span>
                </div>
              ))}
            </div>

            <div style={{
              marginTop: 16, padding: '12px 14px', borderRadius: 8,
              background: isDarkMode ? '#1e293b' : '#f0f9ff',
              border: `1px solid ${isDarkMode ? '#334155' : '#bae6fd'}`,
              fontSize: 13, color: isDarkMode ? '#bae6fd' : '#0369a1',
              display: 'flex', gap: 8,
            }}>
              <i className="fa-solid fa-circle-info" style={{ flexShrink: 0, marginTop: 2 }} />
              <span>Use a strong, unique password. Avoid reusing passwords from other services.</span>
            </div>
          </div>
        </div>
      )}

      {/* ACTIVITY TAB */}
      {activeTab === 'Activity' && (
        <div className="profile-card" style={{ maxWidth: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div className="profile-card-title" style={{ margin: 0 }}>Profile Update History</div>
            <button
              className="btn small ghost-cd"
              onClick={() => { setActivityLoaded(false); }}
              disabled={activityLoading}
            >
              <i className={`fa-solid fa-rotate${activityLoading ? ' fa-spin' : ''}`} /> Refresh
            </button>
          </div>

          {activityLoading ? (
            <div style={{ textAlign: 'center', padding: 32, color: asTheme.muted }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: 24 }} />
              <p style={{ marginTop: 8 }}>Loading activity...</p>
            </div>
          ) : activity.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: asTheme.muted }}>
              <i className="fa-regular fa-clock-rotate-left" style={{ fontSize: 32, marginBottom: 12 }} />
              <p>No profile update history yet.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activity.map((item, i) => {
                // Safely parse and render activity item
                const renderChanges = () => {
                  try {
                    // Parse changes if string
                    const changes = typeof item.changes === 'string' 
                      ? JSON.parse(item.changes) 
                      : item.changes;
                    
                    if (!changes || typeof changes !== 'object') return null;
                    
                    // Get entries, filtering out numeric keys from bad iterations
                    const entries = Object.entries(changes).filter(
                      ([k]) => typeof k === 'string' && !/^\d+$/.test(k)
                    );
                    
                    if (entries.length === 0) return null;
                    
                    return (
                      <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {entries.map(([field, change]) => {
                          // Safely get the "after" value
                          const changeObj = typeof change === 'string'
                            ? (() => { try { return JSON.parse(change); } catch { return { after: change }; } })()
                            : change;
                          
                          const afterVal = changeObj?.after !== undefined && changeObj?.after !== null
                            ? String(changeObj.after).slice(0, 40).trim()
                            : null;
                          
                          if (!afterVal) return null;
                          
                          return (
                            <span key={field} style={{
                              fontSize: 11, padding: '2px 8px', borderRadius: 99,
                              background: isDarkMode ? '#1e3a5f' : '#eff6ff',
                              color: isDarkMode ? '#93c5fd' : '#1d4ed8',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                              <strong>{field.replace(/_/g, ' ')}</strong>: {afterVal}
                            </span>
                          );
                        })}
                      </div>
                    );
                  } catch (e) {
                    console.warn('Activity parse error:', e, item.changes);
                    return null;
                  }
                };

                return (
                  <div key={item.id || i} style={{
                    display: 'flex', gap: 14, padding: '12px 14px',
                    borderRadius: 8, background: asTheme.surface,
                    border: `1px solid ${asTheme.border}`,
                  }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%', background: '#dbeafe',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <i className="fa-solid fa-pen-to-square" style={{ color: '#2563eb', fontSize: 14 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: asTheme.text }}>
                        Profile Updated
                        {item.source && (
                          <span style={{ fontWeight: 400, color: asTheme.muted, marginLeft: 6 }}>
                            via {item.source}
                          </span>
                        )}
                      </div>
                      {renderChanges()}
                    </div>
                    <div style={{ fontSize: 11, color: asTheme.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {formatTs(item.timestamp)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ONBOARDING MODAL */}
      {onboardingOpen && (
        <div
          className="modal-overlay"
          onClick={closeOnboardingModal}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: 16,
          }}
        >
          <div
            className="modal-content"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{
              width: '100%', maxWidth: 720, maxHeight: '80vh', overflow: 'hidden',
              borderRadius: 12,
              background: isDarkMode ? '#2c2c2c' : '#fff',
              color: asTheme.text,
              boxShadow: '0 20px 25px -5px rgba(0,0,0,.1)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: 18,
              borderBottom: `1px solid ${asTheme.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Complete Onboarding</div>
                <div style={{ fontSize: 13, color: asTheme.muted }}>Fill in any missing required fields.</div>
              </div>
              <button
                type="button"
                className="btn small ghost-cd"
                onClick={closeOnboardingModal}
                disabled={onboardingSaving || w9Uploading}
              >
                Close
              </button>
            </div>

            <div style={{ padding: 18, overflowY: 'auto' }}>
              {onboardingLoading ? (
                <div style={{ color: asTheme.muted }}>Loading...</div>
              ) : !hasAnyOnboardingMissing ? (
                <div style={{ color: '#16a34a', fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-check" /> All onboarding items are complete!
                </div>
              ) : (
                <>
                  {modalMissingFields.includes('company_name') && (
                    <div className="profile-field">
                      <label>Business Name</label>
                      <input type="text" value={profileData.businessName}
                        onChange={e => handleInputChange('businessName', e.target.value)}
                        placeholder="Business Name" />
                    </div>
                  )}
                  {modalMissingFields.includes('business_type') && (
                    <div className="profile-field">
                      <label>Business Type</label>
                      <select value={profileData.businessType}
                        onChange={e => handleInputChange('businessType', e.target.value)}
                        style={{ width: '100%', padding: 8, borderRadius: 6, border: `1px solid ${asTheme.border}`, background: isDarkMode ? '#2c2c2c' : '#fff', color: asTheme.text }}>
                        <option value="">Select type</option>
                        <option value="shipper">Shipper</option>
                        <option value="broker">Broker</option>
                      </select>
                    </div>
                  )}
                  {modalMissingFields.includes('tax_id') && (
                    <div className="profile-field">
                      <label>Tax ID (EIN)</label>
                      <input type="text" value={profileData.taxId}
                        onChange={e => handleInputChange('taxId', e.target.value)} placeholder="Tax ID (EIN)" />
                    </div>
                  )}
                  {modalMissingFields.includes('address') && (
                    <div className="profile-field">
                      <label>Business Address</label>
                      <textarea value={profileData.address} rows={2}
                        onChange={e => handleInputChange('address', e.target.value)} placeholder="Address" />
                    </div>
                  )}
                  {modalMissingFields.includes('phone') && (
                    <div className="profile-field">
                      <label>Phone</label>
                      <input type="text" value={profileData.phone}
                        onChange={e => handleInputChange('phone', e.target.value)} placeholder="+1 (555) 123-4567" />
                    </div>
                  )}
                  {modalMissingFields.includes('name') && (
                    <div className="profile-field">
                      <label>Primary Contact</label>
                      <input type="text" value={profileData.contactFullName}
                        onChange={e => handleInputChange('contactFullName', e.target.value)} placeholder="Full Name" />
                    </div>
                  )}
                  {modalMissingFields.includes('contact_title') && (
                    <div className="profile-field">
                      <label>Contact Title</label>
                      <input type="text" value={profileData.contactTitle}
                        onChange={e => handleInputChange('contactTitle', e.target.value)} placeholder="Title / Role" />
                    </div>
                  )}
                  {modalMissingFields.includes('website') && (
                    <div className="profile-field">
                      <label>Website</label>
                      <input type="text" value={profileData.website}
                        onChange={e => handleInputChange('website', e.target.value)} placeholder="https://" />
                    </div>
                  )}
                  {(onboardingMissing?.documents || []).includes('w9') && (
                    <div style={{ marginTop: 6, marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>W9 Form</div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button type="button" className="btn small ghost-cd"
                          onClick={() => w9InputRef.current?.click()} disabled={w9Uploading}>
                          {w9Uploading ? 'Uploading...' : 'Upload W9'}
                        </button>
                        <input ref={w9InputRef} type="file" accept=".pdf,.jpg,.jpeg,.png"
                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadW9(f); }}
                          style={{ display: 'none' }} />
                        <div style={{ fontSize: 13, color: asTheme.muted }}>PDF/JPG/PNG - Max 25 MB</div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div style={{
              padding: 18, borderTop: `1px solid ${asTheme.border}`,
              display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap',
            }}>
              <button type="button" className="btn small ghost-cd"
                onClick={refreshOnboardingMissing}
                disabled={onboardingLoading || onboardingSaving || w9Uploading}>
                Refresh
              </button>
              <button type="button" className="btn small-cd"
                onClick={completeOnboarding}
                disabled={onboardingSaving || onboardingLoading || w9Uploading}>
                {onboardingSaving ? 'Saving...' : 'Complete Onboarding'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
