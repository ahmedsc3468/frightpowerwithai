import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { API_URL } from '../../config';
import { AUTO_REFRESH_MS } from '../../constants/refresh';
import { t } from '../../i18n/translate';
import '../../styles/driver/DocumentVault.css';

// Document type mapping for drivers
const DOCUMENT_TYPES = [
  { value: 'cdl', labelKey: 'documentVault.docTypes.cdl', labelFallback: 'CDL License' },
  { value: 'medical_card', labelKey: 'documentVault.docTypes.medicalCard', labelFallback: 'DOT Medical Card' },
  { value: 'mvr', labelKey: 'documentVault.docTypes.mvr', labelFallback: 'Motor Vehicle Record (MVR)' },
  { value: 'w9', labelKey: 'documentVault.docTypes.w9', labelFallback: 'W-9 Tax Form' },
  { value: 'drug_test', labelKey: 'documentVault.docTypes.drugTest', labelFallback: 'Drug Test Results' },
  { value: 'background_check', labelKey: 'documentVault.docTypes.backgroundCheck', labelFallback: 'Background Check' },
  { value: 'consent', labelKey: 'documentVault.docTypes.consent', labelFallback: 'Consent Form' },
  { value: 'other', labelKey: 'documentVault.docTypes.other', labelFallback: 'Other' }
];

export default function DocumentVault({ isPostHire, setIsPostHire, onNavigate }) {
  const { currentUser } = useAuth();
  const { settings } = useUserSettings();
  const language = settings?.language || 'English';
  const locale = language === 'Spanish' ? 'es-ES' : language === 'Arabic' ? 'ar' : 'en-US';
  const tr = (key, fallback) => t(language, key, fallback);
  const trDocStatus = (status) => {
    if (status === 'Valid') return tr('documentVault.status.valid', 'Valid');
    if (status === 'Expired') return tr('documentVault.status.expired', 'Expired');
    if (status === 'Expiring Soon') return tr('documentVault.status.expiringSoon', 'Expiring Soon');
    return status;
  };
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [docs, setDocs] = useState([]);
  const [tripDocs, setTripDocs] = useState([]);
  const [tripDocsLoading, setTripDocsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showTripUploadModal, setShowTripUploadModal] = useState(false);
  const [selectedDocType, setSelectedDocType] = useState('other');
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedTripFile, setSelectedTripFile] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
  const [tripUploadError, setTripUploadError] = useState('');
  const [tripUploadSuccess, setTripUploadSuccess] = useState('');
  const [complianceScore, setComplianceScore] = useState(null);
  const [showDocumentsModal, setShowDocumentsModal] = useState(false);
  const [viewingDocument, setViewingDocument] = useState(null);
  const [replacingDocId, setReplacingDocId] = useState(null);
  const [bulkFiles, setBulkFiles] = useState([]);
  const [documentFilter, setDocumentFilter] = useState('all');
  const [requiredDocs, setRequiredDocs] = useState(null);
  const [consentInfo, setConsentInfo] = useState({ eligible: false, marketplace_eligible: false, missing_consents: [] });

  useEffect(() => {
    const onOpenUpload = (e) => {
      try {
        const dt = String(e?.detail?.docType || '').trim();
        if (!dt) return;
        const allowed = DOCUMENT_TYPES.some((x) => String(x.value) === dt);
        setSelectedDocType(allowed ? dt : 'other');
        setSelectedFile(null);
        setUploadError('');
        setUploadSuccess('');
        setShowUploadModal(true);
        setShowTripUploadModal(false);
      } catch {
        // ignore
      }
    };

    window.addEventListener('fp:documentvault-open-upload', onOpenUpload);
    return () => window.removeEventListener('fp:documentvault-open-upload', onOpenUpload);
  }, []);

  // Background refresh should not disrupt UI. We track last payloads and only update state when data changes.
  const docsPayloadRef = React.useRef('');
  const tripDocsPayloadRef = React.useRef('');
  const requiredDocsPayloadRef = React.useRef('');
  const compliancePayloadRef = React.useRef('');
  const consentInfoPayloadRef = React.useRef('');

  const missingRequiredDocumentItems = (Array.isArray(requiredDocs?.required) ? requiredDocs.required : []).filter((x) => {
    const kind = String(x?.kind || '').toLowerCase();
    if (kind !== 'document') return false;
    const s = String(x?.status || '');
    return s === 'Missing' || s === 'Expired';
  });

  useEffect(() => {
    const detectDark = () => {
      const dashboardRoot = document.querySelector('.dd-driver-dashboard');
      if (dashboardRoot) return dashboardRoot.classList.contains('dark-root');
      return (
        document.body.classList.contains('dark-root') ||
        document.documentElement.classList.contains('dark-root')
      );
    };

    const update = () => setIsDarkMode(detectDark());
    update();

    const dashboardRoot = document.querySelector('.dd-driver-dashboard');
    if (!dashboardRoot) return;
    const observer = new MutationObserver(() => update());
    observer.observe(dashboardRoot, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const dvTheme = {
    text: isDarkMode ? '#f1f5f9' : '#1e293b',
    muted: isDarkMode ? '#94a3b8' : '#64748b',
    border: isDarkMode ? '#353535' : '#e2e8f0',
    surface: isDarkMode ? '#2c2c2c' : '#ffffff',
    surfaceAlt: isDarkMode ? '#1f2937' : '#f8fafc'
  };

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
        const nextPayload = JSON.stringify(data ?? null);
        if (nextPayload !== compliancePayloadRef.current) {
          compliancePayloadRef.current = nextPayload;
          setComplianceScore(data);
        }
      } else {
        console.error('Failed to fetch compliance score:', response.status);
      }
    } catch (error) {
      console.error('Error fetching compliance:', error);
    }
  }, [currentUser]);

  useEffect(() => { fetchComplianceScore(); }, [fetchComplianceScore]);

  const fetchRequiredDocs = useCallback(async () => {
    if (!currentUser) return;
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/onboarding/driver/required-docs`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const nextPayload = JSON.stringify(data ?? null);
        if (nextPayload !== requiredDocsPayloadRef.current) {
          requiredDocsPayloadRef.current = nextPayload;
          setRequiredDocs(data);
        }
        const nextConsentInfo = {
          eligible: Boolean(data?.consent?.eligible),
          marketplace_eligible: Boolean(data?.consent?.marketplace_eligible),
          missing_consents: Array.isArray(data?.consent?.missing_consents) ? data.consent.missing_consents : [],
        };
        const nextConsentPayload = JSON.stringify(nextConsentInfo);
        if (nextConsentPayload !== consentInfoPayloadRef.current) {
          consentInfoPayloadRef.current = nextConsentPayload;
          setConsentInfo(nextConsentInfo);
        }
      }
    } catch (e) {
      console.error('Error fetching required docs:', e);
    }
  }, [currentUser]);

  useEffect(() => { fetchRequiredDocs(); }, [fetchRequiredDocs]);

  useEffect(() => {
    const onConsentUpdated = () => {
      fetchRequiredDocs();
      fetchComplianceScore();
    };
    window.addEventListener('fp:consent-updated', onConsentUpdated);
    return () => window.removeEventListener('fp:consent-updated', onConsentUpdated);
  }, [fetchRequiredDocs, fetchComplianceScore]);

  // Fetch documents from API
  const fetchDocuments = useCallback(async () => {
    if (!currentUser) return;
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/documents`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        const nextDocs = data.documents || data || [];
        const nextPayload = JSON.stringify(nextDocs ?? []);
        if (nextPayload !== docsPayloadRef.current) {
          docsPayloadRef.current = nextPayload;
          setDocs(nextDocs);
        }
      }
    } catch (error) {
      console.error('Error fetching documents:', error);
    } finally {
      setLoading((prev) => (prev ? false : prev));
    }
  }, [currentUser]);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  // Fetch trip documents (driver vault)
  const fetchTripDocuments = useCallback(async ({ silent = false } = {}) => {
    if (!currentUser) return;
    if (!silent) setTripDocsLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/trip-documents`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const items = data?.documents || [];
        const nextTripDocs = Array.isArray(items) ? items : [];
        const nextPayload = JSON.stringify(nextTripDocs);
        if (nextPayload !== tripDocsPayloadRef.current) {
          tripDocsPayloadRef.current = nextPayload;
          setTripDocs(nextTripDocs);
        }
      }
    } catch (e) {
      console.error('Error fetching trip documents:', e);
    } finally {
      if (!silent) setTripDocsLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (isPostHire) fetchTripDocuments();
  }, [isPostHire, fetchTripDocuments]);

  const refreshAll = useCallback(async ({ showSpinner = false } = {}) => {
    if (!currentUser) return;
    if (showSpinner) setRefreshing(true);
    try {
      const tasks = [
        fetchDocuments(),
        fetchComplianceScore(),
        fetchRequiredDocs(),
      ];
      if (isPostHire) tasks.push(fetchTripDocuments({ silent: true }));
      await Promise.allSettled(tasks);
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, [currentUser, fetchDocuments, fetchComplianceScore, fetchRequiredDocs, fetchTripDocuments, isPostHire]);

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
        setReplacingDocId(null);
        fetchDocuments();
        fetchComplianceScore();
        fetchRequiredDocs();
        try {
          window.dispatchEvent(new CustomEvent('fp:documents-updated'));
        } catch {
          // ignore
        }
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

  const handleTripFileUpload = async (file) => {
    if (!currentUser || !file) return;
    if (file.size > 50 * 1024 * 1024) {
      setTripUploadError(tr('documentVault.errors.fileTooLarge', 'File size must be less than 50MB'));
      return;
    }
    setUploading(true);
    setTripUploadError('');
    setTripUploadSuccess('');
    try {
      const token = await currentUser.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_URL}/trip-documents`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTripUploadError(data?.detail || tr('documentVault.errors.tripUploadFailedShort', 'Failed to upload trip document'));
        return;
      }
      const record = data?.document;
      if (record) {
        setTripDocs((prev) => [record, ...(prev || [])]);
      } else {
        fetchTripDocuments();
      }
      setTripUploadSuccess(tr('documentVault.tripUploadSuccess', 'Trip document uploaded successfully!'));
      setShowTripUploadModal(false);
      setSelectedTripFile(null);
      setTimeout(() => setTripUploadSuccess(''), 5000);
    } catch (e) {
      console.error('Trip upload failed:', e);
      setTripUploadError(tr('documentVault.errors.tripUploadFailedTryAgain', 'Failed to upload trip document. Please try again.'));
    } finally {
      setUploading(false);
    }
  };

  const UploadComplianceModal = () => (
    showUploadModal ? (
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '30px', maxWidth: '500px', width: '90%', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', boxShadow: isDarkMode ? 'none' : '0 20px 25px -5px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
          <h3 style={{ margin: '0 0 20px', color: dvTheme.text }}>{replacingDocId ? tr('documentVault.replaceDocument', 'Replace Document') : tr('documentVault.uploadDocument', 'Upload Document')}</h3>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: dvTheme.text }}>{tr('documentVault.documentTypeRequired', 'Document Type *')}</label>
            <select value={selectedDocType} onChange={(e) => setSelectedDocType(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: `1px solid ${dvTheme.border}`, background: dvTheme.surfaceAlt, color: dvTheme.text }}>
              {DOCUMENT_TYPES.map(dt => (
                <option key={dt.value} value={dt.value}>{tr(dt.labelKey, dt.labelFallback)}</option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: dvTheme.text }}>{tr('documentVault.selectFileRequired', 'Select File *')}</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => { if (e.target.files[0]) setSelectedFile(e.target.files[0]); }} style={{ width: '100%' }} />
            {selectedFile && <p style={{ margin: '8px 0 0', fontSize: '14px', color: '#059669' }}><i className="fa-solid fa-file" style={{ marginRight: '6px' }}></i>{selectedFile.name}</p>}
            <p style={{ margin: '8px 0 0', fontSize: '12px', color: dvTheme.muted }}><i className="fa-solid fa-magic" style={{ marginRight: '6px' }}></i>{tr('documentVault.expiryAutoExtracted', 'Expiry date will be automatically extracted using AI.')}</p>
          </div>
          {uploadError && <div style={{ color: '#dc2626', marginBottom: '15px', fontSize: '14px' }}>{uploadError}</div>}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowUploadModal(false); setUploadError(''); setSelectedFile(null); setReplacingDocId(null); }} style={{ padding: '10px 20px', borderRadius: '8px', border: `1px solid ${dvTheme.border}`, background: dvTheme.surface, color: dvTheme.text, cursor: 'pointer' }}>{tr('common.cancel', 'Cancel')}</button>
            <button onClick={() => { if (selectedFile) handleFileUpload(selectedFile); else setUploadError(tr('documentVault.errors.selectFile', 'Please select a file')); }} disabled={uploading || !selectedFile} style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: uploading || !selectedFile ? '#9ca3af' : '#3b82f6', color: '#fff', cursor: uploading || !selectedFile ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
              {uploading ? <><i className="fa-solid fa-spinner fa-spin"></i>{tr('common.uploading', 'Uploading…')}</> : <><i className="fa-solid fa-upload"></i>{tr('common.upload', 'Upload')}</>}
            </button>
          </div>
        </div>
      </div>
    ) : null
  );

  const UploadTripModal = () => (
    showTripUploadModal ? (
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '30px', maxWidth: '520px', width: '90%', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', boxShadow: isDarkMode ? 'none' : '0 20px 25px -5px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
          <h3 style={{ margin: '0 0 20px', color: dvTheme.text }}>{tr('documentVault.uploadTripDocument', 'Upload Trip Document')}</h3>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: dvTheme.text }}>{tr('documentVault.selectFileRequired', 'Select File *')}</label>
            <input type="file" onChange={(e) => { if (e.target.files[0]) setSelectedTripFile(e.target.files[0]); }} style={{ width: '100%' }} />
            {selectedTripFile && <p style={{ margin: '8px 0 0', fontSize: '14px', color: '#059669' }}><i className="fa-solid fa-file" style={{ marginRight: '6px' }}></i>{selectedTripFile.name}</p>}
            <p style={{ margin: '8px 0 0', fontSize: '12px', color: dvTheme.muted }}>
              {tr('documentVault.uploadAnyDocHelp', 'Upload any document type (PDF, images, Word, spreadsheets, etc.) for your own vault.')}
            </p>
          </div>
          {tripUploadError && <div style={{ color: '#dc2626', marginBottom: '15px', fontSize: '14px' }}>{tripUploadError}</div>}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowTripUploadModal(false); setTripUploadError(''); setSelectedTripFile(null); }} style={{ padding: '10px 20px', borderRadius: '8px', border: `1px solid ${dvTheme.border}`, background: dvTheme.surface, color: dvTheme.text, cursor: 'pointer' }}>{tr('common.cancel', 'Cancel')}</button>
            <button onClick={() => { if (selectedTripFile) handleTripFileUpload(selectedTripFile); else setTripUploadError(tr('documentVault.errors.selectFile', 'Please select a file')); }} disabled={uploading || !selectedTripFile} style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: uploading || !selectedTripFile ? '#9ca3af' : '#3b82f6', color: '#fff', cursor: uploading || !selectedTripFile ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
              {uploading ? <><i className="fa-solid fa-spinner fa-spin"></i>{tr('common.uploading', 'Uploading…')}</> : <><i className="fa-solid fa-upload"></i>{tr('common.upload', 'Upload')}</>}
            </button>
          </div>
        </div>
      </div>
    ) : null
  );

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
    if (!dateStr) return tr('common.na', 'N/A');
    const asNum = typeof dateStr === 'number' ? dateStr : Number(dateStr);
    const d = Number.isFinite(asNum) && asNum > 0
      ? new Date(asNum < 1e12 ? asNum * 1000 : asNum)
      : new Date(dateStr);
    if (Number.isNaN(d.getTime())) return tr('common.na', 'N/A');
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getDocTypeKey = (d) => {
    const t = (d?.type || d?.document_type || d?.extracted_fields?.document_type || '').toString().trim();
    return t.toUpperCase();
  };

  const getSubmittedTypeKey = (d) => {
    const t = (d?.submitted_type || '').toString().trim();
    return t.toUpperCase();
  };

  const getFilenameKey = (d) => {
    const t = (d?.filename || '').toString().trim();
    return t.toUpperCase();
  };

  const getUploadedAt = (d) => {
    const v = d?.uploaded_at;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Find the latest document matching a type (or types)
  const findLatestDocByType = (types) => {
    const wanted = (Array.isArray(types) ? types : [types])
      .map(t => (t || '').toString().trim().toUpperCase())
      .filter(Boolean);
    if (wanted.length === 0) return null;
    const matches = docs.filter(d => {
      const dt = getDocTypeKey(d);
      const st = getSubmittedTypeKey(d);

      // IMPORTANT: Avoid matching empty dt/st (e.g., "CDL".includes("") === true)
      // which caused every compliance card to bind to the most recent document.
      const name = getFilenameKey(d);
      return wanted.some((w) => {
        if (!w) return false;
        if (dt && (dt === w || dt.includes(w))) return true;
        if (st && (st === w || st.includes(w))) return true;
        // Optional reverse-contains only when dt/st is non-trivial
        if (dt && dt.length >= 3 && w.includes(dt)) return true;
        if (st && st.length >= 3 && w.includes(st)) return true;
        // Filename fallback for older docs that lack type keys
        if (name && name.includes(w)) return true;
        return false;
      });
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => getUploadedAt(b) - getUploadedAt(a));
    return matches[0];
  };

  // Get documents (latest versions)
  const cdlDoc = findLatestDocByType(['CDL', 'CDL_LICENSE', 'DRIVER_LICENSE']);
  const medicalDoc = findLatestDocByType(['MEDICAL_CARD', 'DOT_MEDICAL', 'MEDICAL']);
  const drugDoc = findLatestDocByType(['DRUG_TEST', 'DRUG', 'DRUGSCREEN']);
  const w9Doc = findLatestDocByType(['W9', 'W-9', 'W9_CARRIER']);

  // Handle upload for specific document type
  const handleQuickUpload = (docType) => {
    setSelectedDocType(docType);
    setShowUploadModal(true);
  };

  // Handle View Document
  const handleViewDocument = (doc) => {
    if (doc && doc.download_url) {
      window.open(doc.download_url, '_blank');
    } else {
      alert(tr('documentVault.errors.documentUrlUnavailable', 'Document URL not available'));
    }
  };

  // Handle Replace Document
  const handleReplaceDocument = (docId) => {
    setReplacingDocId(docId);
    setShowUploadModal(true);
  };

  // Handle Bulk Upload
  const handleBulkUpload = async (files) => {
    if (!files || files.length === 0) return;
    
    setUploading(true);
    const results = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await handleFileUpload(file);
        results.push({ file: file.name, success: true });
      } catch (error) {
        results.push({ file: file.name, success: false, error: error.message });
      }
    }
    
    setUploading(false);
    const successCount = results.filter(r => r.success).length;
    setUploadSuccess(
      `${tr('documentVault.bulkUpload.successPrefix', 'Successfully uploaded')} ${successCount} ` +
      `${tr('documentVault.bulkUpload.successMiddle', 'of')} ${files.length} ` +
      `${tr('documentVault.bulkUpload.successSuffix', 'documents')}`
    );
    setTimeout(() => setUploadSuccess(''), 5000);
  };

  // Handle Export All Documents as Zip
  const handleExportAllDocuments = async () => {
    if (!docs || docs.length === 0) {
      alert(tr('documentVault.errors.noDocumentsToExport', 'No documents to export'));
      return;
    }
    
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      
      for (const doc of docs) {
        if (doc.download_url) {
          try {
            const response = await fetch(doc.download_url);
            const blob = await response.blob();
            zip.file(doc.filename || `document_${doc.id}.pdf`, blob);
          } catch (error) {
            console.error(`Failed to download ${doc.filename}:`, error);
          }
        }
      }
      
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `documents_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export failed:', error);
      alert(tr('documentVault.errors.exportFailedTryAgain', 'Failed to export documents. Please try again.'));
    }
  };

  // Filter documents based on selected filter
  const getFilteredDocuments = () => {
    if (documentFilter === 'all') return docs;
    if (documentFilter === 'active') {
      return docs.filter(d => getDocStatus(d) === 'Valid');
    }
    if (documentFilter === 'pending') {
      return docs.filter(d => getDocStatus(d) === 'Expiring Soon' || getDocStatus(d) === 'Expired');
    }
    return docs;
  };

  const complianceDocuments = [
    {
      id: 1,
      title: tr('documentVault.docTypes.cdl', 'CDL License'),
      icon: "fa-solid fa-id-card",
      docType: "cdl",
      doc: cdlDoc
    },
    {
      id: 2,
      title: tr('documentVault.docTypes.medicalCard', 'DOT Medical Card'),
      icon: "fa-solid fa-stethoscope",
      docType: "medical_card",
      doc: medicalDoc
    },
    {
      id: 3,
      title: tr('documentVault.docTypes.drugTest', 'Drug Test Results'),
      icon: "fa-solid fa-vial",
      docType: 'drug_test',
      doc: drugDoc
    }
  ];

  const onboardingW9Complete = Boolean(w9Doc);
  const onboardingConsentComplete = Boolean(consentInfo?.eligible);

  function PostHireDocumentView() {
    return (
      <div className={`dd-document-vault ${isDarkMode ? 'dark' : ''}`}>
        {/* Header */}
        <div className="dd-vault-header">
                  <h1>{tr('documentVault.title', 'Document Vault')}</h1>
        <p className="dd-vault-subtitle">{tr('documentVault.subtitle', 'Manage and organize all your important documents')}</p>

          <button onClick={() => setIsPostHire(false)} className="btn small dd-back-btn">{tr('documentVault.backToPreHire', 'Back to Pre-Hire')}</button>
        </div>

        {/* Compliance Status Card */}
        <div className="dd-compliance-status-card">
          <div className="dd-compliance-card-header">
            <h3 className="dd-compliance-title">{tr('documentVault.complianceStatus', 'Compliance Status')}</h3>
            <span className="dd-last-updated">{tr('documentVault.lastUpdated', 'Last updated:')} {new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          
          <div className="dd-status-summary-section">
            <div className="dd-status-info">
              <span className="dd-status-main">{docStats.valid}/{docStats.total} {tr('documentVault.documentsActive', 'Documents Active')}</span>
              <div className="dd-status-badges">
                {docStats.expiring > 0 && (
                  <span className="int-status-badge warning">{docStats.expiring} {tr('documentVault.status.expiringSoon', 'Expiring Soon')}</span>
                )}
                {docStats.valid > 0 && (
                  <span className="int-status-badge active">{docStats.valid} {tr('documentVault.status.active', 'Active')}</span>
                )}
                {docStats.expired > 0 && (
                  <span className="int-status-badge revoked">{docStats.expired} {tr('documentVault.status.expired', 'Expired')}</span>
                )}
              </div>
            </div>
          </div>
          
          <div className="dd-progress-bar-container-new">
            <div className="dd-progress-bar-full">
              <div className="dd-progress-fill-full" style={{ width: `${docStats.total > 0 ? (docStats.valid / docStats.total * 100) : 0}%` }}></div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="dd-action-buttons">
          <button className="btn small-cd" onClick={() => setShowUploadModal(true)}>
            <i className="fa-solid fa-upload"></i>
            {tr('documentVault.uploadDocuments', 'Upload Documents')}
          </button>
          <button
            className="btn small ghost-cd"
            onClick={() => refreshAll({ showSpinner: true })}
            disabled={refreshing}
            title={tr('common.refresh', 'Refresh')}
          >
            <i className={`fa-solid ${refreshing ? 'fa-spinner fa-spin' : 'fa-rotate-right'}`}></i>
            {tr('common.refresh', 'Refresh')}
          </button>
          {/* <button className="btn small ghost-cd">
            <i className="fa-solid fa-camera"></i>
            {tr('documentVault.scanWithCamera', 'Scan with Camera')}
          </button> */}
          <button className="btn small ghost-cd" onClick={handleExportAllDocuments}>
            <i className="fa-solid fa-download"></i>
            {tr('documentVault.exportDocPack', 'Export Doc Pack')}
          </button>
          <select className="dd-filter-select" value={documentFilter} onChange={(e) => setDocumentFilter(e.target.value)}>
            <option value="all">{tr('documentVault.filter.all', 'All Documents')}</option>
            <option value="active">{tr('documentVault.filter.activeOnly', 'Active Only')}</option>
            <option value="pending">{tr('documentVault.filter.pendingOnly', 'Pending Only')}</option>
          </select>
        </div>

        {/* Upload Success Message */}
        {uploadSuccess && (
          <div style={{ background: '#dcfce7', color: '#166534', padding: '12px 20px', borderRadius: '8px', margin: '20px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <i className="fa-solid fa-check-circle"></i> {uploadSuccess}
          </div>
        )}

        {tripUploadSuccess && (
          <div style={{ background: '#dcfce7', color: '#166534', padding: '12px 20px', borderRadius: '8px', margin: '20px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <i className="fa-solid fa-check-circle"></i> {tripUploadSuccess}
          </div>
        )}

        {/* Compliance Documents Section */}
        <div className="dd-post-hire-section">
          <div className="dd-section-header-post">
            <div className="dd-section-title-post">
              <h3>{tr('documentVault.complianceDocuments', 'Compliance Documents')}</h3>
            </div>
            <span className="dd-section-count">{getFilteredDocuments().length} {tr('documentVault.documentsLabel', 'documents')}</span>
          </div>
          
          <div className="dd-post-hire-grid">
            {getFilteredDocuments().length === 0 ? (
              <div className="dd-post-hire-card" style={{opacity: 0.6}}>
                <div className="dd-card-icon">
                  <i className="fa-solid fa-file-text"></i>
                </div>
                <div className="dd-card-status">
                  <span className="int-status-badge disconnected">{tr('documentVault.sample', 'Sample')}</span>
                </div>
                <h4 className="dd-card-title">{tr('documentVault.documentExample', 'Document Example')}</h4>
                <p className="dd-card-date">{tr('documentVault.updatedLabel', 'Updated:')} {tr('documentVault.notAvailable', 'Not Available')}</p>
                <p className="dd-card-expires">{tr('documentVault.expiresLabel', 'Expires:')} {tr('documentVault.notAvailable', 'Not Available')}</p>
                <div className="dd-card-actions">
                  <button className="dd-action-btn" disabled style={{opacity: 0.5}}>
                    <i className="fa-solid fa-eye"></i>
                    {tr('common.view', 'View')}
                  </button>
                  <button className="dd-action-btn" disabled style={{opacity: 0.5}}>
                    <i className="fa-solid fa-download"></i>
                    {tr('common.export', 'Export')}
                  </button>
                </div>
              </div>
            ) : (
              getFilteredDocuments().map((doc) => (
                <div key={doc.id} className="dd-post-hire-card">
                  <div className="dd-card-icon">
                    <i className="fa-solid fa-file-text"></i>
                  </div>
                  <div className="dd-card-status">
                    <span className={`int-status-badge ${getDocStatus(doc) === 'Valid' ? 'active' : getDocStatus(doc) === 'Expired' ? 'revoked' : 'warning'}`}>
                      {trDocStatus(getDocStatus(doc))}
                    </span>
                  </div>
                  <h4 className="dd-card-title">{doc.filename || tr('documentVault.documentFallback', 'Document')}</h4>
                  <p className="dd-card-date">{tr('documentVault.updatedLabel', 'Updated:')} {formatDate(doc.uploaded_at)}</p>
                  <p className="dd-card-expires">{tr('documentVault.expiresLabel', 'Expires:')} {formatDate(doc.expiry_date)}</p>
                  <div className="dd-card-actions">
                    <button className="dd-action-btn" onClick={() => handleViewDocument(doc)}>
                      <i className="fa-solid fa-eye"></i>
                      {tr('common.view', 'View')}
                    </button>
                    <button className="dd-action-btn" onClick={async () => {
                      if (!doc.download_url) {
                        alert(tr('documentVault.errors.documentUrlUnavailable', 'Document URL not available'));
                        return;
                      }
                      
                      try {
                        // Try method 1: Fetch and download as blob
                        const response = await fetch(doc.download_url, { mode: 'cors' });
                        if (!response.ok) throw new Error('Fetch failed');
                        const blob = await response.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = doc.filename || tr('documentVault.defaultDownloadFilename', 'document.pdf');
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      } catch (error) {
                        console.warn('Blob download failed, trying direct link:', error);
                        try {
                          // Fallback method 2: Direct link download
                          const a = document.createElement('a');
                          a.href = doc.download_url;
                          a.download = doc.filename || tr('documentVault.defaultDownloadFilename', 'document.pdf');
                          a.target = '_blank';
                          a.rel = 'noopener noreferrer';
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                        } catch (fallbackError) {
                          console.warn('Direct download failed, opening in new tab:', fallbackError);
                          // Final fallback: Open in new tab
                          window.open(doc.download_url, '_blank', 'noopener,noreferrer');
                        }
                      }
                    }}>
                      <i className="fa-solid fa-download"></i>
                      {tr('common.export', 'Export')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Trip Documents Section */}
        <div className="dd-post-hire-section">
          <div className="dd-section-header-post">
            <div className="dd-section-title-post">
              <h3>{tr('documentVault.tripDocuments.title', 'Trip Documents')}</h3>
            </div>
            <span className="dd-section-count">{(tripDocs || []).length} {tr('documentVault.documentsLabel', 'documents')}</span>
          </div>
          
          <div className="dd-post-hire-grid">
            {/* Add Document Card */}
            <div className="dd-post-hire-card dd-add-card">
              <div className="dd-add-icon">
                <i className="fa-solid fa-plus"></i>
              </div>
              <h4 className="dd-card-title">{tr('documentVault.tripDocuments.addDocumentTitle', 'Add Document')}</h4>
              <p className="dd-card-date">{tr('documentVault.tripDocuments.addDocumentLine1', 'Upload delivery reports or any')}</p>
              <p className="dd-card-carrier">{tr('documentVault.tripDocuments.addDocumentLine2', 'additional documents')}</p>
              <button className="btn small-cd" onClick={() => setShowTripUploadModal(true)}>
                <i className="fa-solid fa-upload"></i>
                {tr('common.upload', 'Upload')}
              </button>
            </div>
            
            {/* Show trip documents or dummy card */}
            {tripDocsLoading ? (
              <div className="dd-post-hire-card" style={{opacity: 0.6}}>
                <div className="dd-card-icon"><i className="fa-solid fa-spinner fa-spin"></i></div>
                <h4 className="dd-card-title">{tr('documentVault.tripDocuments.loading', 'Loading trip documents…')}</h4>
              </div>
            ) : (tripDocs || []).length === 0 ? (
              <div className="dd-post-hire-card" style={{opacity: 0.6}}>
                <div className="dd-card-icon">
                  <i className="fa-solid fa-file-text"></i>
                </div>
                <div className="dd-card-status">
                  <span className="int-status-badge disconnected">{tr('documentVault.sample', 'Sample')}</span>
                </div>
                <h4 className="dd-card-title">{tr('documentVault.tripDocuments.exampleTitle', 'Trip Document Example')}</h4>
                <p className="dd-card-date">{tr('documentVault.tripDocuments.loadLabel', 'Load #')}: {tr('documentVault.notAvailable', 'Not Available')}</p>
                <p className="dd-card-carrier">{tr('documentVault.tripDocuments.carrierLabel', 'Carrier')}: {tr('documentVault.notAvailable', 'Not Available')}</p>
                <div className="dd-card-actions">
                  <button className="dd-action-btn" disabled style={{opacity: 0.5}}>
                    <i className="fa-solid fa-eye"></i>
                    {tr('common.view', 'View')}
                  </button>
                  <button className="dd-action-btn" disabled style={{opacity: 0.5}}>
                    <i className="fa-solid fa-download"></i>
                    {tr('common.export', 'Export')}
                  </button>
                </div>
              </div>
            ) : (
              (tripDocs || []).map((doc) => (
                <div key={doc.id || doc.document_id || Math.random()} className="dd-post-hire-card">
                  <div className="dd-card-icon">
                    <i className="fa-solid fa-file-text"></i>
                  </div>
                  <div className="dd-card-status">
                    <span className="int-status-badge active">{tr('documentVault.tripDocuments.saved', 'Saved')}</span>
                  </div>
                  <h4 className="dd-card-title">{doc.filename || tr('documentVault.tripDocuments.documentFallback', 'Trip Document')}</h4>
                  <p className="dd-card-date">{tr('documentVault.updatedLabel', 'Updated:')} {formatDate(doc.uploaded_at)}</p>
                  <p className="dd-card-carrier">{tr('documentVault.typeLabel', 'Type:')} {(doc.content_type || tr('documentVault.fileLabel', 'file'))}</p>
                  <div className="dd-card-actions">
                    <button className="dd-action-btn" onClick={() => {
                      if (doc.download_url) window.open(doc.download_url, '_blank', 'noopener,noreferrer');
                    }}>
                      <i className="fa-solid fa-eye"></i>
                      {tr('common.view', 'View')}
                    </button>
                    <button className="dd-action-btn" onClick={() => {
                      if (doc.download_url) {
                        const a = document.createElement('a');
                        a.href = doc.download_url;
                        a.download = doc.filename || tr('documentVault.defaultDownloadFilename', 'document.pdf');
                        a.click();
                      }
                    }}>
                      <i className="fa-solid fa-download"></i>
                      {tr('common.export', 'Export')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <UploadComplianceModal />
        <UploadTripModal />
      </div>
    );
  }

  if (isPostHire) {
    return <PostHireDocumentView />;
  }

  return (
    <div className={`dd-document-vault ${isDarkMode ? 'dark' : ''}`}>
      {/* Header */}
      <div className="dd-vault-header">
        <h1>{tr('documentVault.title', 'Document Vault')}</h1>
        <p className="dd-vault-subtitle">{tr('documentVault.subtitle', 'Manage and organize all your important documents')}</p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setIsPostHire(true)} className="btn dd-post-hire-btn">{tr('documentVault.postHire', 'Post Hire')}</button>
          <button
            className="btn small ghost-cd"
            onClick={() => refreshAll({ showSpinner: true })}
            disabled={refreshing}
            title={tr('common.refresh', 'Refresh')}
          >
            <i className={`fa-solid ${refreshing ? 'fa-spinner fa-spin' : 'fa-rotate-right'}`}></i>
            {tr('common.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {/* Compliance Score & Document Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <div style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', borderRadius: '12px', padding: '20px', color: '#fff' }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>
            <i className="fa-solid fa-shield-halved" style={{ marginRight: '8px' }}></i>
            {tr('documentVault.complianceScore', 'Compliance Score')}
          </div>
          <div style={{ fontSize: '36px', fontWeight: '700' }}>
            {complianceScore ? `${complianceScore.compliance_score}%` : '—'}
          </div>
          <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>
            {complianceScore?.is_compliant
              ? tr('documentVault.compliant', '✓ Compliant')
              : tr('documentVault.reviewNeeded', 'Review needed')}
          </div>
        </div>
        <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '20px', boxShadow: isDarkMode ? 'none' : '0 1px 3px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
          <div style={{ fontSize: '14px', color: dvTheme.muted, marginBottom: '8px' }}>
            <i className="fa-solid fa-file" style={{ marginRight: '8px' }}></i>{tr('documentVault.totalDocuments', 'Total Documents')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: dvTheme.text }}>{docStats.total}</div>
        </div>
        <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '20px', boxShadow: isDarkMode ? 'none' : '0 1px 3px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
          <div style={{ fontSize: '14px', color: '#22c55e', marginBottom: '8px' }}>
            <i className="fa-solid fa-check-circle" style={{ marginRight: '8px' }}></i>{tr('documentVault.status.valid', 'Valid')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#22c55e' }}>{docStats.valid}</div>
        </div>
        <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '20px', boxShadow: isDarkMode ? 'none' : '0 1px 3px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
          <div style={{ fontSize: '14px', color: '#f59e0b', marginBottom: '8px' }}>
            <i className="fa-solid fa-clock" style={{ marginRight: '8px' }}></i>{tr('documentVault.status.expiringSoon', 'Expiring Soon')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#f59e0b' }}>{docStats.expiring}</div>
        </div>
        <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '20px', boxShadow: isDarkMode ? 'none' : '0 1px 3px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
          <div style={{ fontSize: '14px', color: '#ef4444', marginBottom: '8px' }}>
            <i className="fa-solid fa-exclamation-triangle" style={{ marginRight: '8px' }}></i>{tr('documentVault.status.expired', 'Expired')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#ef4444' }}>{docStats.expired}</div>
        </div>
      </div>

      {/* AI Marketplace Readiness Check */}
      {missingRequiredDocumentItems.length > 0 && (
        <div className="card" style={{ marginBottom: '20px', borderLeft: '4px solid #f59e0b' }}>
          <div style={{ padding: '16px' }}>
            <h4 style={{ margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <i className="fa-solid fa-robot" style={{ color: '#3b82f6' }}></i>
              {tr('documentVault.marketplaceReadiness.title', 'AI Marketplace Readiness Check')}
            </h4>
            <p style={{ margin: '0 0 12px', color: dvTheme.muted }}>
              {tr('documentVault.marketplaceReadiness.body', 'Documents needed for marketplace eligibility:')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {missingRequiredDocumentItems.map((item) => (
                <div key={String(item?.key || item?.title || Math.random())} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#dc2626' }}>
                  <i className="fa-solid fa-exclamation-circle"></i>
                  <span>{String(item?.title || item?.label || item?.key || tr('documentVault.documentFallback', 'Document'))}</span>
                </div>
              ))}
            </div>
            <button className="btn small-cd" style={{ marginTop: '16px' }} onClick={() => setShowUploadModal(true)}>
              {tr('documentVault.marketplaceReadiness.uploadMissing', 'Upload Missing Documents')}
            </button>
          </div>
        </div>
      )}

      {/* Document Grid */}
      <div className="dd-documents-grid">
        {/* Compliance Documents */}
        <div className="dd-document-section-new">
          <div className="dd-section-header-new">
            <h3>{tr('documentVault.complianceDocuments', 'Compliance Documents')}</h3>
          </div>
          
          <div className="dd-document-cards-grid">
            {complianceDocuments.map((doc) => {
              const hasDocument = !!doc.doc;
              const status = hasDocument ? getDocStatus(doc.doc) : 'Missing';
              const statusColor = hasDocument 
                ? (status === 'Valid' ? 'active' : status === 'Expired' ? 'revoked' : 'warning')
                : 'disconnected';
              
              return (
              <div key={doc.id} className={`dd-document-card ${!hasDocument ? 'dd-missing-doc' : ''}`}>
                <div className="dd-doc-header">
                  <i className={`${doc.icon} dd-doc-icon`}></i>
                  <span className={`int-status-badge ${statusColor}`}>
                    {status === 'Missing'
                      ? tr('documentVault.status.missing', 'Missing')
                      : trDocStatus(status)}
                  </span>
                </div>
                <h4 className="dd-doc-title-new">{doc.title}</h4>
                
                {hasDocument ? (
                  <>
                    <p className="dd-doc-expires-new">{tr('documentVault.expiresLabel', 'Expires:')} {formatDate(doc.doc.expiry_date)}</p>
                    <p className="dd-doc-updated-new">{tr('documentVault.lastUpdatedLabel', 'Last Updated:')} {formatDate(doc.doc.uploaded_at)}</p>
                    {doc.doc.extracted_fields && Object.keys(doc.doc.extracted_fields).length > 0 && (
                      <div style={{ marginTop: '8px', padding: '8px', background: dvTheme.surfaceAlt, border: `1px solid ${dvTheme.border}`, borderRadius: '6px', fontSize: '12px' }}>
                        {Object.entries(doc.doc.extracted_fields).slice(0, 3).map(([key, value]) => (
                          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <span style={{ color: dvTheme.muted, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}:</span>
                            <span style={{ color: dvTheme.text, fontWeight: '500' }}>{String(value).substring(0, 20)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="dd-doc-shared">
                      <span className="dd-shared-status">{tr('documentVault.notSharedYet', 'Not Shared Yet')}</span>
                      <div className="dd-doc-buttons">
                        <button className="btn small ghost-cd" onClick={() => handleViewDocument(doc.doc)}>{tr('common.view', 'View')}</button>
                        <button
                          className="btn small ghost-cd"
                          onClick={() => {
                            setSelectedDocType(doc.docType);
                            handleReplaceDocument(doc.doc.id || doc.doc.doc_id);
                          }}
                        >
                          {tr('documentVault.replace', 'Replace')}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="dd-doc-description">{tr('documentVault.requiredForMarketplaceEligibility', 'Required for marketplace eligibility')}</p>
                    <button className="btn small-cd" style={{width:"100%"}} onClick={() => handleQuickUpload(doc.docType)}>
                      <i className="fa-solid fa-upload" style={{marginRight: '6px'}}></i>
                      {tr('documentVault.uploadDocument', 'Upload Document')}
                    </button>
                  </>
                )}
              </div>
              );
            })}
          </div>
        </div>

        {/* Onboarding Documents */}
        <div className="dd-document-section-new">
          <div className="dd-section-header-new">
            <h3>{tr('documentVault.onboardingDocuments', 'Onboarding Documents')}</h3>
          </div>
          
          <div className="dd-document-cards-grid">
            {/* W-9 Tax Form */}
            <div className={`dd-document-card ${!onboardingW9Complete ? 'dd-missing-doc' : ''}`}>
              <div className="dd-doc-header">
                <i className="fa-solid fa-file-invoice dd-doc-icon"></i>
                <span className={`int-status-badge ${onboardingW9Complete ? 'active' : 'disconnected'}`}>
                  {onboardingW9Complete ? tr('common.complete', 'Complete') : tr('documentVault.status.missing', 'Missing')}
                </span>
              </div>
              <h4 className="dd-doc-title-new">{tr('documentVault.docTypes.w9', 'W-9 Tax Form')}</h4>

              {onboardingW9Complete ? (
                <>
                  <p className="dd-doc-updated-new">{tr('documentVault.lastUpdatedLabel', 'Last Updated:')} {formatDate(w9Doc?.uploaded_at)}</p>
                  <div className="dd-doc-shared">
                    <span className="dd-shared-status">{tr('documentVault.notSharedYet', 'Not Shared Yet')}</span>
                    <div className="dd-doc-buttons">
                      <button className="btn small ghost-cd" onClick={() => handleViewDocument(w9Doc)}>{tr('common.view', 'View')}</button>
                      <button
                        className="btn small ghost-cd"
                        onClick={() => {
                          setSelectedDocType('w9');
                          handleReplaceDocument(w9Doc?.id || w9Doc?.doc_id);
                        }}
                      >
                        {tr('documentVault.replace', 'Replace')}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="dd-doc-description">{tr('documentVault.w9.description', 'Upload your W-9 so carriers can verify tax information.')}</p>
                  <button className="btn small-cd" style={{ width: '100%' }} onClick={() => handleQuickUpload('w9')}>
                    <i className="fa-solid fa-upload" style={{ marginRight: '6px' }}></i>
                    {tr('documentVault.w9.upload', 'Upload W-9')}
                  </button>
                </>
              )}
            </div>

            {/* Data Sharing Consent */}
            <div className={`dd-document-card ${!onboardingConsentComplete ? 'dd-pending-doc' : ''}`}>
              <div className="dd-doc-header">
                <i className="fa-solid fa-handshake dd-doc-icon"></i>
                <span className={`int-status-badge ${onboardingConsentComplete ? 'active' : 'warning'}`}>
                  {onboardingConsentComplete ? tr('documentVault.consent.signed', 'Signed') : tr('common.pending', 'Pending')}
                </span>
              </div>
              <h4 className="dd-doc-title-new">{tr('documentVault.consent.dataSharingTitle', 'Data Sharing Consent')}</h4>

              {onboardingConsentComplete ? (
                <>
                  <p className="dd-doc-description">{tr('documentVault.consent.onFileDescription', 'Your consent is on file and will be used for onboarding and sharing rules.')}</p>
                  <button
                    className="btn small ghost-cd"
                    style={{ width: '100%' }}
                    onClick={() => {
                      if (typeof onNavigate === 'function') {
                        onNavigate('esign');
                        return;
                      }
                      try { window.location.href = '/driver-dashboard?nav=esign'; } catch { /* ignore */ }
                    }}
                  >
                    {tr('documentVault.consent.openEsign', 'Open E-Sign')}
                  </button>
                </>
              ) : (
                <>
                  <p className="dd-doc-description">{tr('documentVault.consent.requiredBeforeSharing', 'Required before sharing your profile with carriers.')}</p>
                  <button
                    className="btn small-cd"
                    style={{ width: '100%' }}
                    onClick={() => {
                      if (typeof onNavigate === 'function') {
                        onNavigate('esign');
                        return;
                      }
                      try { window.location.href = '/driver-dashboard?nav=esign'; } catch { /* ignore */ }
                    }}
                  >
                    {tr('documentVault.consent.signConsentForm', 'Sign Consent Form')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Upload Options */}
      <div className="card dd-upload-options-card">
        <div className="card-header">
          <h3>{tr('documentVault.quickUpload.title', 'Quick Upload Options')}</h3>
        </div>
        <div className="dd-upload-grid">
          <div className="dd-upload-option" onClick={() => handleQuickUpload('other')} style={{cursor: 'pointer'}}>
            <i className="fa-solid fa-id-card dd-upload-icon"></i>
            <div className="dd-upload-text">
              <h4>{tr('documentVault.quickUpload.stateDocument.title', 'State Document')}</h4>
              <p>{tr('documentVault.quickUpload.stateDocument.subtitle', 'DOT card & others')}</p>
            </div>
          </div>
          <div className="dd-upload-option" onClick={() => document.getElementById('bulk-upload-input').click()} style={{cursor: 'pointer'}}>
            <i className="fa-solid fa-upload dd-upload-icon"></i>
            <div className="dd-upload-text">
              <h4>{tr('documentVault.quickUpload.bulkUpload.title', 'Bulk Upload')}</h4>
              <p>{tr('documentVault.quickUpload.bulkUpload.subtitle', 'Multiple documents')}</p>
            </div>
            <input 
              id="bulk-upload-input" 
              type="file" 
              multiple 
              accept=".pdf,.jpg,.jpeg,.png" 
              style={{display: 'none'}}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleBulkUpload(Array.from(e.target.files));
                }
              }}
            />
          </div>
          <div className="dd-upload-option" onClick={() => {
            const toast = document.createElement('div');
            toast.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #3b82f6; color: white; padding: 16px 24px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); z-index: 9999;';
            toast.innerHTML = `<i class="fa-solid fa-info-circle" style="margin-right: 8px;"></i>${tr('documentVault.quickUpload.needsClarification', 'Needs clarification')}`;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
          }} style={{cursor: 'pointer'}}>
            <i className="fa-solid fa-file-lines dd-upload-icon"></i>
            <div className="dd-upload-text">
              <h4>{tr('documentVault.quickUpload.formPreview.title', 'Form Preview')}</h4>
              <p>{tr('documentVault.quickUpload.formPreview.subtitle', 'Available templates')}</p>
            </div>
          </div>
          <div className="dd-upload-option" onClick={() => setShowDocumentsModal(true)} style={{cursor: 'pointer'}}>
            <i className="fa-solid fa-folder dd-upload-icon"></i>
            <div className="dd-upload-text">
              <h4>{tr('documentVault.quickUpload.fileFolder.title', 'File Folder')}</h4>
              <p>{tr('documentVault.quickUpload.fileFolder.subtitle', 'Browse files')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Consent Request */}
      {!consentInfo?.eligible ? (
        <div className="card dd-consent-card">
          <div className="dd-consent-content">
            <i className="fa-solid fa-exclamation-triangle dd-consent-icon"></i>
            <div className="dd-consent-text">
              <h4>{tr('documentVault.consent.requiredTitle', 'Consent Required for Marketplace')}</h4>
              <p>{tr('documentVault.consent.requiredBody', 'You must provide consent to share your documents with carriers. This ensures your privacy and gives you control over your information.')}</p>
            </div>
          </div>
          <button
            className="btn dd-give-consent-btn"
            onClick={() => {
              if (typeof onNavigate === 'function') {
                onNavigate('esign');
                return;
              }
              try { window.location.href = '/driver-dashboard?nav=esign'; } catch { /* ignore */ }
            }}
          >
            {tr('documentVault.consent.giveConsent', 'Give Consent')}
          </button>
        </div>
      ) : (
        <div className="card dd-consent-card">
          <div className="dd-consent-content">
            <i className="fa-solid fa-circle-check dd-consent-icon"></i>
            <div className="dd-consent-text">
              <h4>{tr('documentVault.consent.grantedTitle', 'Marketplace Consent Granted')}</h4>
              <p>{tr('documentVault.consent.grantedBody', 'Your signed consent is on file. You can manage it in the E-Sign section.')}</p>
            </div>
          </div>
          <button
            className="btn dd-give-consent-btn"
            onClick={() => {
              if (typeof onNavigate === 'function') {
                onNavigate('esign');
                return;
              }
              try { window.location.href = '/driver-dashboard?nav=esign'; } catch { /* ignore */ }
            }}
          >
            {tr('documentVault.consent.viewConsent', 'View Consent')}
          </button>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '30px', maxWidth: '500px', width: '90%', boxShadow: isDarkMode ? 'none' : '0 20px 25px -5px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }}>
            <h3 style={{ margin: '0 0 20px', color: dvTheme.text }}>{replacingDocId ? tr('documentVault.replaceDocument', 'Replace Document') : tr('documentVault.uploadDocument', 'Upload Document')}</h3>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: dvTheme.text }}>{tr('documentVault.documentTypeRequired', 'Document Type *')}</label>
              <select value={selectedDocType} onChange={(e) => setSelectedDocType(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: `1px solid ${dvTheme.border}`, background: dvTheme.surfaceAlt, color: dvTheme.text }}>
                {DOCUMENT_TYPES.map(dt => (<option key={dt.value} value={dt.value}>{tr(dt.labelKey, dt.labelFallback)}</option>))}
              </select>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: dvTheme.text }}>{tr('documentVault.selectFileRequired', 'Select File *')}</label>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => { if (e.target.files[0]) setSelectedFile(e.target.files[0]); }} style={{ width: '100%' }} />
              {selectedFile && <p style={{ margin: '8px 0 0', fontSize: '14px', color: '#059669' }}><i className="fa-solid fa-file" style={{ marginRight: '6px' }}></i>{selectedFile.name}</p>}
              <p style={{ margin: '8px 0 0', fontSize: '12px', color: dvTheme.muted }}><i className="fa-solid fa-magic" style={{ marginRight: '6px' }}></i>{tr('documentVault.expiryAutoExtracted', 'Expiry date will be automatically extracted using AI.')}</p>
            </div>
            {uploadError && <div style={{ color: '#dc2626', marginBottom: '15px', fontSize: '14px' }}>{uploadError}</div>}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowUploadModal(false); setUploadError(''); setSelectedFile(null); setReplacingDocId(null); }} style={{ padding: '10px 20px', borderRadius: '8px', border: `1px solid ${dvTheme.border}`, background: dvTheme.surface, color: dvTheme.text, cursor: 'pointer' }}>{tr('common.cancel', 'Cancel')}</button>
              <button onClick={() => { if (selectedFile) handleFileUpload(selectedFile); else setUploadError(tr('documentVault.errors.selectFile', 'Please select a file')); }} disabled={uploading || !selectedFile} style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: uploading || !selectedFile ? '#9ca3af' : '#3b82f6', color: '#fff', cursor: uploading || !selectedFile ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {uploading ? <><i className="fa-solid fa-spinner fa-spin"></i>{tr('common.uploading', 'Uploading…')}</> : <><i className="fa-solid fa-upload"></i>{tr('common.upload', 'Upload')}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Documents List Modal */}
      {showDocumentsModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowDocumentsModal(false)}>
          <div style={{ background: dvTheme.surface, borderRadius: '12px', padding: '30px', maxWidth: '800px', width: '90%', maxHeight: '80vh', overflow: 'auto', boxShadow: isDarkMode ? 'none' : '0 20px 25px -5px rgba(0,0,0,0.1)', border: `1px solid ${dvTheme.border}` }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: dvTheme.text }}>{tr('documentVault.filter.all', 'All Documents')}</h3>
              <button onClick={() => setShowDocumentsModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: dvTheme.muted }}>×</button>
            </div>
            
            {docs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: dvTheme.muted }}>
                <i className="fa-regular fa-folder-open" style={{ fontSize: '3rem', marginBottom: '16px', display: 'block', color: '#cbd5e1' }}></i>
                <p>{tr('documentVault.noDocumentsUploadedYet', 'No documents uploaded yet')}</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {docs.map((doc) => (
                  <div key={doc.id} style={{ display: 'flex', alignItems: 'center', padding: '16px', background: dvTheme.surfaceAlt, border: `1px solid ${dvTheme.border}`, borderRadius: '8px', gap: '16px' }}>
                    <button 
                      onClick={() => handleViewDocument(doc)}
                      style={{ 
                        padding: '8px 16px', 
                        background: '#3b82f6', 
                        color: '#fff', 
                        border: 'none', 
                        borderRadius: '6px', 
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '14px',
                        fontWeight: '500'
                      }}
                    >
                      <i className="fa-solid fa-eye"></i>
                      {tr('common.view', 'View')}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: '600', color: dvTheme.text, marginBottom: '4px' }}>
                        {doc.filename || doc.file_name || doc.original_filename}
                      </div>
                      <div style={{ fontSize: '14px', color: dvTheme.muted }}>
                        {(doc.type || doc.document_type || tr('documentVault.docTypes.other', 'Other')).replace(/_/g, ' ').toUpperCase()} • {tr('documentVault.uploadedLabel', 'Uploaded')} {formatDate(doc.created_at || doc.uploaded_at)}
                      </div>
                    </div>
                    <span className={`int-status-badge ${getDocStatus(doc) === 'Valid' ? 'active' : getDocStatus(doc) === 'Expired' ? 'revoked' : 'warning'}`}>
                      {trDocStatus(getDocStatus(doc))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Uploaded Documents Table */}
      <div className="card" style={{ marginTop: '20px' }}>
        <div className="card-header">
          <h3>{tr('documentVault.uploadedDocumentsTitle', 'Your Uploaded Documents')}</h3>
          <span className="dd-section-count">{docs.length} {tr('documentVault.documentsLabel', 'documents')}</span>
        </div>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
            <p style={{ marginTop: '10px', color: dvTheme.muted }}>{tr('documentVault.loadingDocuments', 'Loading documents...')}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', color: dvTheme.text }}>
            <thead>
              <tr style={{ background: dvTheme.surfaceAlt, borderBottom: `1px solid ${dvTheme.border}` }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: dvTheme.muted }}>{tr('documentVault.table.fileName', 'File name')}</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: dvTheme.muted }}>{tr('documentVault.table.type', 'Type')}</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: dvTheme.muted }}>{tr('documentVault.table.expiryDate', 'Expiry date')}</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: dvTheme.muted }}>{tr('common.status', 'Status')}</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: dvTheme.muted }}>{tr('documentVault.table.uploaded', 'Uploaded')}</th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 ? (
                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: dvTheme.muted }}>
                  <i className="fa-regular fa-folder-open" style={{ fontSize: '2rem', marginBottom: '10px', display: 'block' }}></i>
                  {tr('documentVault.table.emptyPrefix', 'No documents uploaded yet. Click')} "{tr('documentVault.uploadDocuments', 'Upload Documents')}" {tr('documentVault.table.emptySuffix', 'to get started.')}
                </td></tr>
              ) : docs.map((d) => (
                <tr key={d.id} style={{ borderBottom: `1px solid ${dvTheme.border}` }}>
                  <td style={{ padding: '12px 16px' }}>{d.filename || d.file_name || d.original_filename}</td>
                  <td style={{ padding: '12px 16px' }}>{(d.type || d.document_type || tr('documentVault.docTypes.other', 'Other')).replace(/_/g, ' ').toUpperCase()}</td>
                  <td style={{ padding: '12px 16px' }}>{formatDate(d.expiry_date)}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span className={`int-status-badge ${getDocStatus(d) === 'Valid' ? 'active' : getDocStatus(d) === 'Expired' ? 'revoked' : 'warning'}`}>
                      {trDocStatus(getDocStatus(d))}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>{formatDate(d.created_at || d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}