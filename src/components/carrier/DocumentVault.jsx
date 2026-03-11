import React, { useEffect, useRef, useState, useCallback } from 'react';
import useMediaQuery from '../../hooks/useMediaQuery';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import { AUTO_REFRESH_MS } from '../../constants/refresh';
import Toast from '../common/Toast';
import '../../styles/carrier/DocumentVault.css';

const folders = [
  { name: 'Company', type: 'company', docTypes: ['w9_carrier', 'broker_w9', 'other'] },
  { name: 'Insurance', type: 'insurance', docTypes: ['coi_carrier', 'broker_coi'] },
  { name: 'Authority', type: 'authority', docTypes: ['mc_cert', 'broker_authority'] },
  { name: 'Banking', type: 'banking', docTypes: ['voided_check_carrier', 'broker_banking'] },
  { name: 'Safety', type: 'safety', docTypes: ['mvr', 'mvr_release', 'clearinghouse_consent'] },
  { name: 'Equipment', type: 'equipment', docTypes: ['truck_reg', 'trailer_reg', 'cab_card', 'irp_ifta_letter'] },
  { name: 'Drivers', type: 'driver', docTypes: ['cdl', 'medical', 'driver_registration'] },
  { name: 'Load Documents', type: 'load', docTypes: ['rate_confirmation', 'bol', 'pod'] },
  { name: 'IFTA / 2290', type: 'ifta', docTypes: ['ifta_license', 'irp_ifta_letter', 'cab_card'] }
];

// Document type mapping
const DOCUMENT_TYPES = [
  { value: 'coi', label: 'Certificate of Insurance (COI)' },
  { value: 'w9', label: 'W-9 Tax Form' },
  { value: 'mc_authority', label: 'MC Authority' },
  { value: 'cdl', label: 'CDL License' },
  { value: 'mvr', label: 'Motor Vehicle Record (MVR)' },
  { value: 'medical_card', label: 'Medical Card' },
  { value: 'rate_confirmation', label: 'Rate Confirmation' },
  { value: 'bol', label: 'Bill of Lading (BOL)' },
  { value: 'pod', label: 'Proof of Delivery (POD)' },
  { value: 'consent', label: 'Consent Form' },
  { value: 'carrier_broker_agreement', label: 'Broker Agreement' },
  { value: 'other', label: 'Other' }
];

function StatusBadge({ status }) {
  const cls = status === 'Valid' ? 'cd-badge green' : status === 'Expired' ? 'cd-badge red' : 'cd-badge yellow';
  return <span className={cls}>{status}</span>;
}

function RowActions({ doc, onRefresh }) {
  const isCompact = useMediaQuery('(max-width: 1024px)');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (open && ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  const handleView = () => {
    // Open Firebase Storage URL directly in new tab
    if (doc.file_url || doc.download_url) {
      window.open(doc.file_url || doc.download_url, '_blank');
    } else {
      alert(`Document: ${doc.file_name || doc.name}\nType: ${doc.document_type}\nStatus: ${doc.status}\nExpiry: ${doc.expiry_date || 'N/A'}`);
    }
  };

  const handleDownload = () => {
    // Direct download from Firebase Storage URL
    if (doc.file_url || doc.download_url) {
      const link = document.createElement('a');
      link.href = doc.file_url || doc.download_url;
      link.download = doc.file_name || doc.name || 'document.pdf';
      link.target = '_blank';
      link.click();
    } else {
      alert('Download URL not available. Please contact support.');
    }
  };

  const handleShare = async () => {
    const shareText = `Document: ${doc.file_name || doc.name}\nType: ${doc.document_type}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: doc.file_name || doc.name, text: shareText });
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Error sharing:', err);
        }
      }
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(shareText);
      alert('Document details copied to clipboard!');
    }
  };

  const handleRefresh = () => {
    if (onRefresh) onRefresh();
  };

  // Desktop: show inline icons. Compact: show ellipsis menu that reveals the same actions.
  const actionsInline = (
    <>
      <button className="action" title="View" onClick={handleView}><i className="fa-regular fa-eye" aria-hidden="true" /></button>
      <button className="action" title="Download" onClick={handleDownload}><i className="fa-solid fa-download" aria-hidden="true" /></button>
      <button className="action" title="Share" onClick={handleShare}><i className="fa-solid fa-share-from-square" aria-hidden="true" /></button>
      {/* Refresh intentionally disabled per requirement */}
      {/* <button className="action" title="Refresh" onClick={handleRefresh}><i className="fa-solid fa-rotate-right" aria-hidden="true" /></button> */}
    </>
  );

  const actionsPopover = (
    <div className="row-actions-popover" role="menu">
      <button className="action" onClick={handleView} title="View"><i className="fa-regular fa-eye" aria-hidden="true" /> <span>View</span></button>
      <button className="action" onClick={handleDownload} title="Download"><i className="fa-solid fa-download" aria-hidden="true" /> <span>Download</span></button>
      <button className="action" onClick={handleShare} title="Share"><i className="fa-solid fa-share-from-square" aria-hidden="true" /> <span>Share</span></button>
      {/* Refresh intentionally disabled per requirement */}
      {/* <button className="action" onClick={handleRefresh} title="Refresh"><i className="fa-solid fa-rotate-right" aria-hidden="true" /> <span>Refresh</span></button> */}
    </div>
  );

  if (!isCompact) return actionsInline;

  return (
    <div className="row-actions" ref={ref}>
      <button
        className="row-actions-menu"
        aria-expanded={open}
        aria-label="Show actions"
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((s) => !s); }}
      >
        <i className="fa-solid fa-ellipsis" aria-hidden="true" />
      </button>
      {open && actionsPopover}
    </div>
  );
}

export default function DocumentVault() {
  const { currentUser } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedDocType, setSelectedDocType] = useState('other');
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
  const [complianceScore, setComplianceScore] = useState(null);
  const dropzoneRef = useRef(null);

  const [toast, setToast] = useState(null);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [previewDoc, setPreviewDoc] = useState(null);

  const showToast = useCallback((type, message) => {
    setToast({ type, message, isVisible: true });
  }, []);

  const normalizeDocType = useCallback((rawType) => {
    const t = String(rawType || '').trim();
    if (!t) return '';
    const upper = t.toUpperCase();
    const map = {
      COI: 'coi_carrier',
      COI_CARRIER: 'coi_carrier',
      BROKER_COI: 'broker_coi',
      W9: 'w9_carrier',
      'W-9': 'w9_carrier',
      W9_CARRIER: 'w9_carrier',
      BROKER_W9: 'broker_w9',
      MC_AUTHORITY: 'mc_cert',
      MC_CERT: 'mc_cert',
      BROKER_AUTHORITY: 'broker_authority',
      VOIDED_CHECK: 'voided_check_carrier',
      VOIDED_CHECK_CARRIER: 'voided_check_carrier',
      BROKER_BANKING: 'broker_banking',
      CDL: 'cdl',
      MEDICAL: 'medical',
      DRIVER_REGISTRATION: 'driver_registration',
      MVR: 'mvr',
      MVR_RELEASE: 'mvr_release',
      CLEARINGHOUSE_CONSENT: 'clearinghouse_consent',
      IFTA_LICENSE: 'ifta_license',
      IRP_IFTA_LETTER: 'irp_ifta_letter',
      CAB_CARD: 'cab_card',
      TRUCK_REG: 'truck_reg',
      TRAILER_REG: 'trailer_reg',
      CARRIER_BROKER_AGREEMENT: 'carrier_broker_agreement',
      OTHER: 'other',
    };
    const mapped = map[upper];
    return (mapped || upper.toLowerCase()).trim();
  }, []);

  const docLabel = useCallback((normalizedType) => {
    const t = normalizeDocType(normalizedType);
    const map = {
      w9_carrier: 'W-9 Tax Form',
      broker_w9: 'Broker W-9',
      coi_carrier: 'Certificate of Insurance (COI)',
      broker_coi: 'Broker COI',
      mc_cert: 'MC Authority',
      broker_authority: 'Broker Authority',
      voided_check_carrier: 'Voided Check',
      broker_banking: 'Broker Banking',
      cdl: 'CDL License',
      medical: 'Medical Card',
      driver_registration: 'Driver Registration',
      mvr: 'Motor Vehicle Record (MVR)',
      mvr_release: 'MVR Release',
      clearinghouse_consent: 'Clearinghouse Consent',
      ifta_license: 'IFTA License',
      irp_ifta_letter: 'IRP/IFTA Letter',
      cab_card: 'CAB Card',
      truck_reg: 'Truck Registration',
      trailer_reg: 'Trailer Registration',
      carrier_broker_agreement: 'Broker Agreement',
      rate_confirmation: 'Rate Confirmation',
      bol: 'Bill of Lading (BOL)',
      pod: 'Proof of Delivery (POD)',
      other: 'Other',
    };
    return map[t] || String(t || '').replace(/_/g, ' ').toUpperCase();
  }, [normalizeDocType]);

  const getDocUrl = useCallback((doc) => {
    return doc?.file_url || doc?.download_url || '';
  }, []);

  // Calculate folder counts based on AI-classified document types
  const getFolderCount = (folder) => {
    if (!folder.docTypes || folder.docTypes.length === 0) return 0;
    return docs.filter(d => {
      const raw = d.document_type || d.type || d.doc_type || d.extracted_fields?.document_type;
      const docType = normalizeDocType(raw);
      return folder.docTypes.includes(docType);
    }).length;
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
        console.log('📊 Compliance Score Data:', data);
        console.log('📄 Documents:', data.documents);
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
      const response = await fetch(`${API_URL}/documents`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const rawDocs = data.documents || [];
        const mapped = rawDocs.map((d) => {
          const rawType = d.document_type || d.type || d.doc_type || d.extracted_fields?.document_type;
          return {
            ...d,
            id: d.id || d.doc_id || d.document_id,
            file_name: d.file_name || d.filename || d.name,
            document_type: normalizeDocType(rawType),
            expiry_date: d.expiry_date || d.expiry || d.extracted_fields?.expiry_date,
            uploaded_at: d.uploaded_at || d.created_at || d.updated_at,
            download_url: d.download_url || d.file_url,
          };
        });
        setDocs(mapped);
      }
    } catch (error) {
      console.error('Error fetching documents:', error);
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

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
  const handleFileUpload = async (file, options = {}) => {
    if (!currentUser || !file) return;

    const expectedFolder = options.expectedFolder || null;
    const requestedDocumentType = options.requestedDocumentType || selectedDocType;

    // Validate file type
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowedTypes.includes(file.type)) {
      setUploadError('Only PDF, JPG, and PNG files are allowed');
      return;
    }

    // Validate file size (25MB max)
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('File size must be less than 25MB');
      return;
    }

    setUploading(true);
    setUploadError('');
    setUploadSuccess('');

    try {
      const token = await currentUser.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('document_type', requestedDocumentType);
      // Expiry date is now automatically extracted from the document by AI

      const response = await fetch(`${API_URL}/documents`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const result = await response.json();

      if (response.ok) {
        const extractedRaw = result?.doc_type || result?.extraction?.document_type || result?.extraction?.document_type_code;
        const extractedNormalized = normalizeDocType(extractedRaw);

        if (expectedFolder?.docTypes?.length) {
          const folderAllowed = expectedFolder.docTypes;
          const okForFolder = folderAllowed.includes(extractedNormalized);

          if (!okForFolder) {
            showToast('error', `${docLabel(extractedNormalized)} can not be added to the ${expectedFolder.name} folder.`);
          }
        }

        const expiryMsg = result.expiry_date
          ? ` Expiry date detected: ${result.expiry_date}`
          : '';
        setUploadSuccess(`Document uploaded successfully!${expiryMsg}`);
        setShowUploadModal(false);
        setSelectedFile(null);
        setSelectedDocType('other');
        fetchDocuments();
        setTimeout(() => setUploadSuccess(''), 5000);
      } else {
        setUploadError(result.detail || 'Failed to upload document');
      }
    } catch (error) {
      console.error('Error uploading document:', error);
      setUploadError('Failed to upload document. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  // Handle drag and drop
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropzoneRef.current) {
      dropzoneRef.current.classList.add('drag-over');
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropzoneRef.current) {
      dropzoneRef.current.classList.remove('drag-over');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropzoneRef.current) {
      dropzoneRef.current.classList.remove('drag-over');
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      setShowUploadModal(true);
      // Store file for upload after type selection
      setSelectedFile(files[0]);
    }
  };

  const openFolderModal = (folder) => {
    setSelectedFolder(folder);
    setFolderModalOpen(true);
    setPreviewDoc(null);
  };

  const closeFolderModal = () => {
    setFolderModalOpen(false);
    setSelectedFolder(null);
    setPreviewDoc(null);
  };

  const folderDocs = selectedFolder?.docTypes?.length
    ? docs.filter((d) => selectedFolder.docTypes.includes(normalizeDocType(d.document_type || d.type || d.doc_type)))
    : [];

  const handleFolderDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0 || !selectedFolder) return;

    const file = files[0];
    const requested = (selectedFolder.docTypes && selectedFolder.docTypes[0]) ? selectedFolder.docTypes[0] : 'other';
    handleFileUpload(file, { expectedFolder: selectedFolder, requestedDocumentType: requested });
  };

  const handleBulkDownload = async () => {
    if (!currentUser) return;
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/documents/package.zip`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        setUploadError('Bulk download failed. Please try again.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'documents.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Bulk download error:', e);
      setUploadError('Bulk download failed. Please try again.');
    }
  };

  // Get status based on expiry date
  const getDocStatus = (doc) => {
    if (!doc.expiry_date) return 'Valid';
    const expiry = new Date(doc.expiry_date);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) return 'Expired';
    if (daysUntilExpiry <= 30) return 'Expiring Soon';
    return 'Valid';
  };

  // Format date
  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  };

  // Format timestamp for upload time
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    }) + ' ' + date.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="dv-root">
      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          isVisible={toast.isVisible}
          onClose={() => setToast(null)}
        />
      )}
      <header className="fp-header">
        <div className="fp-header-titles">
          <h2>Document Vault</h2>
          <p className="fp-subtitle">Organize and manage your company's documents and compliance files</p>
        </div>
      </header>

      {/* Success/Error Messages */}
      {uploadSuccess && (
        <div style={{ background: '#dcfce7', color: '#166534', padding: '12px 20px', borderRadius: '8px', margin: '0 20px 20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <i className="fa-solid fa-check-circle"></i> {uploadSuccess}
        </div>
      )}
      {uploadError && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '12px 20px', borderRadius: '8px', margin: '0 20px 20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <i className="fa-solid fa-exclamation-circle"></i> {uploadError}
          <button onClick={() => setUploadError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
        </div>
      )}

      {/* Compliance Score & Document Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', margin: '0 20px 20px' }}>
        <div style={{ background: 'linear-gradient(#7FA4F6 0%, #3B57A7 100%)', borderRadius: '12px', padding: '20px', color: '#fff' }}>
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
        <div className="div-style-comp">
          <div style={{ fontSize: '14px', marginBottom: '8px' }}>
            <i className="fa-solid fa-file" style={{ marginRight: '8px' }}></i>Total Documents
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700' }}>{docStats.total}</div>
        </div>
        <div className="div-style-comp">
          <div style={{ fontSize: '14px', color: '#22c55e', marginBottom: '8px' }}>
            <i className="fa-solid fa-check-circle" style={{ marginRight: '8px' }}></i>Valid
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#22c55e' }}>{docStats.valid}</div>
        </div>
        <div className="div-style-comp">
          <div style={{ fontSize: '14px', color: '#f59e0b', marginBottom: '8px' }}>
            <i className="fa-solid fa-clock" style={{ marginRight: '8px' }}></i>Expiring Soon
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#f59e0b' }}>{docStats.expiring}</div>
        </div>
        <div className="div-style-comp">
          <div style={{ fontSize: '14px', color: '#ef4444', marginBottom: '8px' }}>
            <i className="fa-solid fa-exclamation-triangle" style={{ marginRight: '8px' }}></i>Expired
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#ef4444' }}>{docStats.expired}</div>
        </div>
      </div>

      <main className="dv-main">
        {/* Folder cards rendered above the main content (replace left sidebar) */}
        <div className="dv-folders-grid">
              {folders.map((f) => {
                const count = getFolderCount(f);
                return (
                  <button key={f.name} className="folder-card" type="button" onClick={() => openFolderModal(f)}>
                    <div className="folder-card-left">
                      <i className="fa-regular fa-folder" aria-hidden="true"></i>
                      <span className="folder-card-title">{f.name}</span>
                    </div>
                    <div className="folder-card-count">{count} docs</div>
                  </button>
                );
              })}
            </div>
        <div className="dv-toprow">
          <div className="dv-breadcrumb">Document Vault <span className="muted">/ All Documents</span></div>
          <div className="dv-actions">
            <button className="btn small-cd" onClick={() => setShowUploadModal(true)}>
              <i className="fa-solid fa-upload" style={{ marginRight: '8px' }}></i>
              Upload Documents
            </button>
            <button
              className="btn small ghost-cd"
              onClick={() => refreshAll({ showSpinner: true })}
              disabled={refreshing}
              title="Refresh"
            >
              <i className={`fa-solid ${refreshing ? 'fa-spinner fa-spin' : 'fa-rotate-right'}`} style={{ marginRight: '6px' }}></i>
              Refresh
            </button>
            <button className="btn small ghost-cd" onClick={handleBulkDownload}>Bulk Download</button>
          </div>
        </div>

        <div
          className="dv-dropzone"
          ref={dropzoneRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => setShowUploadModal(true)}
          style={{ cursor: 'pointer' }}
        >
          <div className="dv-drop-inner">
            <div className="dv-cloud"><i className="fa-solid fa-cloud-upload" aria-hidden="true" /></div>
            <div className="dv-drop-text">Drag and drop files here</div>
            <div className="dv-drop-sub muted">or click to browse files (PDF, JPG, PNG up to 25MB)</div>
          </div>
        </div>

        {/* Upload Modal */}
        {showUploadModal && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: '#fff', borderRadius: '12px', padding: '30px',
              maxWidth: '500px', width: '90%', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)'
            }}>
              <h3 style={{ margin: '0 0 20px', color: '#1e293b' }}>Upload Document</h3>

              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>
                  Document Type *
                </label>
                <select
                  value={selectedDocType}
                  onChange={(e) => setSelectedDocType(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db' }}
                >
                  {DOCUMENT_TYPES.map(dt => (
                    <option key={dt.value} value={dt.value}>{dt.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>
                  Select File *
                </label>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={(e) => {
                    if (e.target.files[0]) {
                      setSelectedFile(e.target.files[0]);
                    }
                  }}
                  style={{ width: '100%' }}
                />
                {selectedFile && (
                  <p style={{ margin: '8px 0 0', fontSize: '14px', color: '#059669' }}>
                    <i className="fa-solid fa-file" style={{ marginRight: '6px' }}></i>
                    {selectedFile.name}
                  </p>
                )}
                <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#6b7280' }}>
                  <i className="fa-solid fa-magic" style={{ marginRight: '6px' }}></i>
                  Expiry date will be automatically extracted from the document using AI.
                </p>
              </div>

              {uploadError && (
                <div style={{ color: '#dc2626', marginBottom: '15px', fontSize: '14px' }}>
                  {uploadError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { setShowUploadModal(false); setUploadError(''); setSelectedFile(null); }}
                  style={{ padding: '10px 20px', borderRadius: '8px', border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (selectedFile) {
                      handleFileUpload(selectedFile);
                    } else {
                      setUploadError('Please select a file to upload');
                    }
                  }}
                  disabled={uploading || !selectedFile}
                  style={{
                    padding: '10px 20px',
                    borderRadius: '8px',
                    border: 'none',
                    background: uploading || !selectedFile ? '#9ca3af' : '#3b82f6',
                    color: '#fff',
                    cursor: uploading || !selectedFile ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  {uploading ? (
                    <>
                      <i className="fa-solid fa-spinner fa-spin"></i>
                      Uploading...
                    </>
                  ) : (
                    <>
                      <i className="fa-solid fa-upload"></i>
                      Upload
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="dv-table-wrap">
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
              <p style={{ marginTop: '10px', color: '#64748b' }}>Loading documents...</p>
            </div>
          ) : (
          <table className="dv-table">
            <thead>
              <tr>
                <th>File name</th>
                <th>Type</th>
                <th>Expiry date</th>
                <th>Status</th>
                <th>Last updated</th>
                <th className="c-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 ? (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                    <i className="fa-regular fa-folder-open" style={{ fontSize: '2rem', marginBottom: '10px', display: 'block' }}></i>
                    No documents uploaded yet. Click "Upload Documents" to get started.
                  </td>
                </tr>
              ) : (
              docs.map((d) => (
                <tr key={d.id || d.name}>
                  <td className="file-name">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="#E74C3C"/></svg>
                    <span>{d.file_name || d.name}</span>
                  </td>
                  <td>{docLabel(d.document_type || d.type || 'other')}</td>
                  <td>{formatDate(d.expiry_date || d.expiry)}</td>
                  <td><StatusBadge status={getDocStatus(d)} /></td>
                  <td>{formatTimestamp(d.uploaded_at || d.created_at || d.updated_at || d.updated)}</td>
                  <td className="c-actions">
                    <RowActions doc={d} onRefresh={fetchDocuments} />
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
          )}
        </div>

        {/* Folder Modal */}
        {folderModalOpen && selectedFolder && (
          <div
            role="dialog"
            aria-modal="true"
            onClick={closeFolderModal}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              padding: '20px'
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: '#fff',
                borderRadius: '12px',
                width: 'min(1100px, 96vw)',
                height: 'min(80vh, 800px)',
                boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
              }}
            >
              <div style={{ padding: '16px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ fontWeight: 700, color: '#111827' }}>
                  {selectedFolder.name} ({folderDocs.length})
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <button className="btn small ghost-cd" type="button" onClick={closeFolderModal}>Close</button>
                </div>
              </div>

              <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb' }}>
                <div
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={handleFolderDrop}
                  style={{
                    border: '2px dashed #d1d5db',
                    borderRadius: '10px',
                    padding: '14px',
                    color: '#374151',
                    background: '#fafafa'
                  }}
                >
                  Drag and drop a file here to upload into this folder
                </div>
              </div>

              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '360px 1fr', minHeight: 0 }}>
                <div style={{ borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
                  {folderDocs.length === 0 ? (
                    <div style={{ padding: '18px', color: '#64748b' }}>No documents in this folder.</div>
                  ) : (
                    folderDocs.map((d) => {
                      const active = (previewDoc?.id || previewDoc?.doc_id) === (d.id || d.doc_id);
                      return (
                        <button
                          key={d.id || d.doc_id || d.filename}
                          type="button"
                          onClick={() => setPreviewDoc(d)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            border: 'none',
                            background: active ? '#f3f4f6' : '#fff',
                            padding: '12px 14px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #f1f5f9'
                          }}
                        >
                          <div style={{ fontWeight: 600, color: '#111827', marginBottom: 4 }}>
                            {d.file_name || d.filename || d.name}
                          </div>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>{docLabel(d.document_type || d.type)}</div>
                        </button>
                      );
                    })
                  )}
                </div>

                <div style={{ padding: '14px', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  {!previewDoc ? (
                    <div style={{ color: '#64748b', padding: '10px' }}>Select a document to preview.</div>
                  ) : (
                    <div style={{ flex: 1, minHeight: 0, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                      {getDocUrl(previewDoc) ? (
                        <iframe
                          title={previewDoc.file_name || previewDoc.filename || 'Document Preview'}
                          src={getDocUrl(previewDoc)}
                          style={{ width: '100%', height: '100%', border: 'none' }}
                        />
                      ) : (
                        <div style={{ padding: '14px', color: '#64748b' }}>Preview not available for this document.</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
