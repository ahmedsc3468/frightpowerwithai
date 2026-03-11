import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import { AUTO_REFRESH_MS } from '../../constants/refresh';
import '../../styles/shipper/DocumentVault.css';

// Document type mapping
const DOCUMENT_TYPES = [
  { value: 'rate_confirmation', label: 'Rate Confirmation' },
  { value: 'bol', label: 'Bill of Lading (BOL)' },
  { value: 'pod', label: 'Proof of Delivery (POD)' },
  { value: 'coi', label: 'Certificate of Insurance (COI)' },
  { value: 'contract', label: 'Contract' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'consent', label: 'Consent Form' },
  { value: 'other', label: 'Other' }
];

function StatusBadge({ status }) {
  const cls = status === 'Valid' ? 'dv-badge green' : status === 'Expired' ? 'dv-badge red' : 'dv-badge yellow';
  return <span className={cls}>{status}</span>;
}

export default function DocumentVault() {
  const { currentUser } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedDocType, setSelectedDocType] = useState('other');
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
  const [complianceScore, setComplianceScore] = useState(null);

  // Computed stats from documents
  const docStats = {
    total: docs.length,
    valid: docs.filter(d => {
      if (!d.expiry_date) return true;
      return new Date(d.expiry_date) > new Date();
    }).length,
    expiring: docs.filter(d => {
      if (!d.expiry_date) return false;
      const daysUntil = Math.ceil((new Date(d.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
      return daysUntil > 0 && daysUntil <= 30;
    }).length,
    expired: docs.filter(d => {
      if (!d.expiry_date) return false;
      return new Date(d.expiry_date) < new Date();
    }).length
  };

  // Fetch compliance score
  const fetchComplianceScore = useCallback(async () => {
    if (!currentUser) return;
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/compliance/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        console.log('📊 Compliance Score Data (Shipper):', data);
        setComplianceScore(data);
      } else {
        console.error('Failed to fetch compliance score:', response.status);
      }
    } catch (error) {
      console.error('Error fetching compliance:', error);
    }
  }, [currentUser]);

  useEffect(() => { fetchComplianceScore(); }, [fetchComplianceScore]);

  // Fetch documents from API
  const fetchDocuments = useCallback(async () => {
    if (!currentUser) return;
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/compliance/status`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        setDocs(data.documents || []);
      }
    } catch (error) {
      console.error('Error fetching documents:', error);
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  const refreshAll = useCallback(async ({ showSpinner = false } = {}) => {
    if (!currentUser) return;
    if (showSpinner) setRefreshing(true);
    try {
      await Promise.allSettled([
        fetchDocuments(),
        fetchComplianceScore(),
      ]);
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, [currentUser, fetchDocuments, fetchComplianceScore]);

  // Time-based auto-refresh (5 minutes) for Document Vault data.
  useEffect(() => {
    const id = setInterval(() => {
      refreshAll({ showSpinner: false }).catch(() => {});
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshAll]);

  // Handle file upload
  const handleFileUpload = async (file) => {
    if (!currentUser || !file) return;
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowedTypes.includes(file.type)) {
      setUploadError('Only PDF, JPG, and PNG files are allowed');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('File size must be less than 25MB');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const token = await currentUser.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('document_type', selectedDocType);
      const response = await fetch(`${API_URL}/documents`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const result = await response.json();
      if (response.ok) {
        const expiryMsg = result.expiry_date ? ` Expiry date detected: ${result.expiry_date}` : '';
        setUploadSuccess(`Document uploaded successfully!${expiryMsg}`);
        setShowUploadModal(false);
        setSelectedFile(null);
        setSelectedDocType('other');
        fetchDocuments();
        setTimeout(() => setUploadSuccess(''), 5000);
      } else {
        setUploadError(result.detail || 'Failed to upload document');
      }
    } catch (_error) {
      setUploadError('Failed to upload document. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const getDocStatus = (doc) => {
    if (!doc.expiry_date) return 'Valid';
    const expiry = new Date(doc.expiry_date);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    if (daysUntilExpiry < 0) return 'Expired';
    if (daysUntilExpiry <= 30) return 'Expiring Soon';
    return 'Valid';
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Format timestamp for upload time
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp * 1000); // Convert from Unix timestamp
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    }) + ' ' + date.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="dv-root">
        <header className="fp-header">
          <div className='sd-carrier-row'>
            <div className="fp-header-titles">
            <h2>Document Vault</h2>
          </div>
          </div>
        </header>

      {uploadSuccess && (
        <div style={{ background: '#dcfce7', color: '#166534', padding: '12px 20px', borderRadius: '8px', margin: '0 20px 20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <i className="fa-solid fa-check-circle"></i> {uploadSuccess}
        </div>
      )}

      <div className="dv-top-row">
        <div className="dv-controls">
          <div className="dv-search">
            <input placeholder="Search documents (OCR-enabled)" />
          </div>
          <button className="btn small filter">Filters</button>
          <button
            className="btn small filter"
            onClick={() => refreshAll({ showSpinner: true })}
            disabled={refreshing}
            title="Refresh"
          >
            <i className={`fa-solid ${refreshing ? 'fa-spinner fa-spin' : 'fa-rotate-right'}`} style={{ marginRight: '6px' }}></i>
            Refresh
          </button>
          <button className="btn small-cd" onClick={() => setShowUploadModal(true)}>
            <i className="fa-solid fa-upload" style={{ marginRight: '6px' }}></i>
            Upload
          </button>
        </div>
      </div>

      {/* Compliance Score Card */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <div style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', borderRadius: '12px', padding: '20px', color: '#fff' }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>
            <i className="fa-solid fa-shield-halved" style={{ marginRight: '8px' }}></i>
            Compliance Score
          </div>
          <div style={{ fontSize: '36px', fontWeight: '700' }}>
            {complianceScore ? `${complianceScore.compliance_score}%` : '—'}
          </div>
          <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>
            {complianceScore?.is_compliant ? '✓ Compliant' : 'Review needed'}
          </div>
        </div>
        <div className="dv-stat dv-total">
          <i className="dv-stat-icon fa-regular fa-file" aria-hidden="true" />
          <div className="dv-stat-num">{docStats.total}</div>
          <div className="dv-stat-label">Total Docs</div>
        </div>
        <div className="dv-stat dv-verified">
          <i className="dv-stat-icon fa-solid fa-circle-check" aria-hidden="true" />
          <div className="dv-stat-num">{docStats.valid}</div>
          <div className="dv-stat-label">Valid</div>
        </div>
        <div className="dv-stat dv-expiring">
          <i className="dv-stat-icon fa-solid fa-hourglass-half" aria-hidden="true" />
          <div className="dv-stat-num">{docStats.expiring}</div>
          <div className="dv-stat-label">Expiring Soon</div>
        </div>
        <div className="dv-stat dv-missing">
          <i className="dv-stat-icon fa-solid fa-triangle-exclamation" aria-hidden="true" />
          <div className="dv-stat-num">{docStats.expired}</div>
          <div className="dv-stat-label">Expired</div>
        </div>
      </div>
      {/* Main content: cards grid + recent activity */}
      <div className="dv-main-grid">
        <div className="dv-cards-grid">
          <div className="dv-card-large">
            <div className="dv-card-icon"><i className="fa-solid fa-building" aria-hidden="true" /></div>
            <div className="dv-card-body">
              <h4>FedEx Logistics</h4>
              <p className="muted">128 files · 5 shared links</p>
              <p className="small-muted">Updated Oct 8</p>
            </div>
          </div>

          <div className="dv-card-large">
            <div className="dv-card-icon"><i className="fa-solid fa-truck" aria-hidden="true" /></div>
            <div className="dv-card-body">
              <h4>Carrier Documents</h4>
              <p className="muted">342 files · 12 expiring</p>
              <p className="small-muted">Fleet insurance, W9s, permits</p>
            </div>
          </div>

          <div className="dv-card-large">
            <div className="dv-card-icon"><i className="fa-solid fa-box" aria-hidden="true" /></div>
            <div className="dv-card-body">
              <h4>Load #2091</h4>
              <p className="muted">24 files · Auto-created</p>
              <p className="small-muted">BOLs, PODs, Rate confirmations</p>
            </div>
          </div>

          <div className="dv-card-large">
            <div className="dv-card-icon"><i className="fa-solid fa-user" aria-hidden="true" /></div>
            <div className="dv-card-body">
              <h4>Driver Documents</h4>
              <p className="muted">156 files · 8 expiring</p>
              <p className="small-muted">Licenses, med cards, training</p>
            </div>
          </div>

          <div className="dv-card-large">
            <div className="dv-card-icon"><i className="fa-solid fa-shield-halved" aria-hidden="true" /></div>
            <div className="dv-card-body">
              <h4>Compliance</h4>
              <p className="muted">89 files · All current</p>
              <p className="small-muted">Audit forms, legal docs</p>
            </div>
          </div>

          <div className="dv-card-large">
            <div className="dv-card-icon"><i className="fa-solid fa-star" aria-hidden="true" /></div>
            <div className="dv-card-body">
              <h4>Favorites</h4>
              <p className="muted">45 files · Bookmarked</p>
              <p className="small-muted">Quick access documents</p>
            </div>
          </div>
        </div>

        <aside className="dv-activity">
          <h4 className='heading-recent-tr' style={{marginBottom: '20px'}}>Recent Activity</h4>
          <ul className="activity-list">
            <li><span className="act-icon"><i className="fa-solid fa-arrow-up" aria-hidden="true" /></span><div><strong>Driver uploaded POD #8389</strong><div className="muted small-muted">10 min ago</div></div></li>
            <li><span className="act-icon"><i className="fa-solid fa-exclamation-triangle" aria-hidden="true" /></span><div><strong>Insurance expiring in 7 days</strong><div className="muted small-muted">Atlas Freight</div></div></li>
            <li><span className="act-icon"><i className="fa-solid fa-envelope" aria-hidden="true" /></span><div><strong>Rate Confirmation sent</strong><div className="muted small-muted">Atlas Freight · 1h ago</div></div></li>
            <li><span className="act-icon"><i className="fa-solid fa-check" aria-hidden="true" /></span><div><strong>Document verified</strong><div className="muted small-muted">BOL #7321 · 2h ago</div></div></li>
          </ul>
        </aside>
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '30px', maxWidth: '500px', width: '90%', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <h3 style={{ margin: '0 0 20px', color: '#1e293b' }}>Upload Document</h3>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>Document Type *</label>
              <select value={selectedDocType} onChange={(e) => setSelectedDocType(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                {DOCUMENT_TYPES.map(dt => (<option key={dt.value} value={dt.value}>{dt.label}</option>))}
              </select>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>Select File *</label>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => { if (e.target.files[0]) setSelectedFile(e.target.files[0]); }} style={{ width: '100%' }} />
              {selectedFile && <p style={{ margin: '8px 0 0', fontSize: '14px', color: '#059669' }}><i className="fa-solid fa-file" style={{ marginRight: '6px' }}></i>{selectedFile.name}</p>}
              <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#6b7280' }}><i className="fa-solid fa-magic" style={{ marginRight: '6px' }}></i>Expiry date will be automatically extracted using AI.</p>
            </div>
            {uploadError && <div style={{ color: '#dc2626', marginBottom: '15px', fontSize: '14px' }}>{uploadError}</div>}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowUploadModal(false); setUploadError(''); setSelectedFile(null); }} style={{ padding: '10px 20px', borderRadius: '8px', border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => { if (selectedFile) handleFileUpload(selectedFile); else setUploadError('Please select a file'); }} disabled={uploading || !selectedFile} style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: uploading || !selectedFile ? '#9ca3af' : '#3b82f6', color: '#fff', cursor: uploading || !selectedFile ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {uploading ? <><i className="fa-solid fa-spinner fa-spin"></i>Uploading...</> : <><i className="fa-solid fa-upload"></i>Upload</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Documents Table */}
      <section className="dv-recently-added" style={{ marginTop: '20px' }}>
        <h4 className='heading-recent-tr'>Your Documents</h4>
        <div style={{ background: '#fff', borderRadius: '12px', overflow: 'hidden', marginTop: '15px' }}>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
              <p style={{ marginTop: '10px', color: '#64748b' }}>Loading documents...</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: '#475569' }}>File name</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: '#475569' }}>Type</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: '#475569' }}>Expiry date</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: '#475569' }}>Status</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: '#475569' }}>Last updated</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 ? (
                  <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                    <i className="fa-regular fa-folder-open" style={{ fontSize: '2rem', marginBottom: '10px', display: 'block' }}></i>
                    No documents uploaded yet. Click "Upload" to get started.
                  </td></tr>
                ) : docs.map((d) => (
                  <tr key={d.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '12px 16px' }}>{d.file_name || d.filename || 'Document'}</td>
                    <td style={{ padding: '12px 16px' }}>{(d.document_type || d.type || 'OTHER').replace(/_/g, ' ').toUpperCase()}</td>
                    <td style={{ padding: '12px 16px' }}>{formatDate(d.expiry_date)}</td>
                    <td style={{ padding: '12px 16px' }}><StatusBadge status={getDocStatus(d)} /></td>
                    <td style={{ padding: '12px 16px' }}>{formatTimestamp(d.uploaded_at || d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
