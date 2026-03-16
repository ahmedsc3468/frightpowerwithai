import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../../config';
import { auth } from '../../firebase';
import { useTr } from '../../i18n/useTr';

export default function LoadDetailsModal({ load, onClose }) {
  const { language, tr } = useTr();
  const locale = language === 'Spanish' ? 'es-ES' : language === 'Arabic' ? 'ar' : 'en-US';
  const fmtMoney = (amt) => {
    const n = Number(amt);
    if (!Number.isFinite(n)) return tr('common.na', 'N/A');
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  };

  const [loadDetails, setLoadDetails] = useState(load || null);
  const [loadLoading, setLoadLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState('');
  const [documents, setDocuments] = useState([]);

  const loadId = String(loadDetails?.load_id || loadDetails?.id || load?.load_id || load?.id || '').trim();

  const openDocumentUrl = useCallback(
    async (rawUrl) => {
      const url = String(rawUrl || '').trim();
      if (!url) return;
      if (url.toLowerCase().startsWith('epod:')) return;

      // Backend download endpoints require Authorization; clicking a normal <a> won't include it.
      let pathname = '';
      try {
        pathname = new URL(url, window.location.href).pathname;
      } catch {
        pathname = '';
      }
      const isBackendDownload = /\/loads\/[^/]+\/documents\/[^/]+\/download$/.test(pathname);

      if (!isBackendDownload) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }

      const user = auth.currentUser;
      if (!user) {
        setDocsError(tr('auth.notAuthenticated', 'Not authenticated'));
        return;
      }
      try {
        const token = await user.getIdToken();
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          setDocsError(`${tr('loadDetails.errors.openDocumentFailed', 'Failed to open document')} (${res.status})`);
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, '_blank', 'noopener,noreferrer');
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } catch (e) {
        setDocsError(e?.message || tr('loadDetails.errors.openDocumentFailed', 'Failed to open document'));
      }
    },
    [setDocsError, tr]
  );

  const workflowDisplay = useMemo(() => {
    const wf = String(loadDetails?.workflow_status || '').trim();
    if (wf) return wf;
    const st = String(loadDetails?.status || '').trim();
    if (!st) return tr('common.na', 'N/A');
    return st.replace(/_/g, ' ');
  }, [loadDetails?.workflow_status, loadDetails?.status, tr]);

  const docsByKind = useMemo(() => {
    const map = new Map();
    (documents || []).forEach((d) => {
      const kind = String(d?.kind || '').toUpperCase().trim();
      if (!kind) return;
      if (!map.has(kind)) map.set(kind, d);
    });
    return map;
  }, [documents]);

  const rcDoc = useMemo(() => {
    const doc = docsByKind.get('RATE_CONFIRMATION');
    if (doc) return doc;
    const url = String(loadDetails?.rate_confirmation_url || '').trim();
    return url ? { kind: 'RATE_CONFIRMATION', url, filename: tr('loadDetails.docs.rateConfirmation', 'Rate Confirmation') } : null;
  }, [docsByKind, loadDetails?.rate_confirmation_url, tr]);

  const bolDoc = useMemo(() => {
    return docsByKind.get('BOL') || docsByKind.get('BILL_OF_LADING') || null;
  }, [docsByKind]);

  const podDoc = useMemo(() => {
    return docsByKind.get('POD') || docsByKind.get('PROOF_OF_DELIVERY') || null;
  }, [docsByKind]);

  const refreshLoad = async () => {
    if (!loadId) return;
    const user = auth.currentUser;
    if (!user) return;
    setLoadLoading(true);
    setLoadError('');
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${API_URL}/loads/${encodeURIComponent(loadId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        setLoadError(tr('loadDetails.errors.loadDetailsFailed', 'Failed to load details'));
        return;
      }
      const data = await res.json();
      setLoadDetails(data?.load || data);
    } catch (e) {
      setLoadError(e?.message || tr('loadDetails.errors.loadDetailsFailed', 'Failed to load details'));
    } finally {
      setLoadLoading(false);
    }
  };

  const fetchDocs = async () => {
    if (!loadId) return;
    const user = auth.currentUser;
    if (!user) return;
    setDocsLoading(true);
    setDocsError('');
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${API_URL}/loads/${encodeURIComponent(loadId)}/documents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setDocuments([]);
        setDocsError(tr('loadDetails.errors.loadDocumentsFailed', 'Failed to load documents'));
        return;
      }
      const data = await res.json();
      setDocuments(Array.isArray(data?.documents) ? data.documents : []);
    } catch (e) {
      setDocuments([]);
      setDocsError(e?.message || tr('loadDetails.errors.loadDocumentsFailed', 'Failed to load documents'));
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => {
    setLoadDetails(load || null);
  }, [load]);

  useEffect(() => {
    refreshLoad();
    fetchDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadId]);

  if (!loadId) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 10000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 12,
          width: 'min(920px, 100%)',
          maxHeight: '85vh',
          overflow: 'auto',
          border: '1px solid #e5e7eb',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 16,
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>{tr('loadDetails.title', 'Load Details')}</div>
            <div style={{ marginTop: 2, color: '#6b7280', fontSize: 13 }}>
              {tr('loadDetails.loadPrefix', 'Load:')} {loadId}{loadLoading ? ` · ${tr('common.loading', 'Loading…')}` : ''}
            </div>
          </div>
          <button className="btn small ghost-cd" onClick={onClose} type="button">
            {tr('common.close', 'Close')}
          </button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loadError && (
            <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8 }}>{loadError}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Info label={tr('loadDetails.fields.status', 'Status')} value={String(loadDetails?.status || tr('common.na', 'N/A'))} />
            <Info label={tr('loadDetails.fields.workflow', 'Workflow')} value={workflowDisplay} />
            <Info
              label={tr('loadDetails.fields.assignedDriver', 'Assigned Driver')}
              value={String(
                loadDetails?.assigned_driver_name || (loadDetails?.assigned_driver ? tr('myLoads.status.assigned', 'Assigned') : tr('common.na', 'N/A'))
              )}
            />
            <Info
              label={tr('loadDetails.fields.shipper', 'Shipper')}
              value={String(loadDetails?.shipper_company_name || loadDetails?.shipper_name || tr('common.na', 'N/A'))}
            />
            <Info label={tr('loadDetails.fields.origin', 'Origin')} value={String(loadDetails?.origin || tr('common.na', 'N/A'))} />
            <Info label={tr('loadDetails.fields.destination', 'Destination')} value={String(loadDetails?.destination || tr('common.na', 'N/A'))} />
            <Info label={tr('loadDetails.fields.pickup', 'Pickup')} value={String(loadDetails?.pickup_date || tr('common.tbd', 'TBD'))} />
            <Info label={tr('loadDetails.fields.delivery', 'Delivery')} value={String(loadDetails?.delivery_date || tr('common.tbd', 'TBD'))} />
            <Info label={tr('loadDetails.fields.equipment', 'Equipment')} value={String(loadDetails?.equipment_type || tr('common.na', 'N/A'))} />
            <Info
              label={tr('loadDetails.fields.weight', 'Weight')}
              value={loadDetails?.weight != null ? String(loadDetails.weight) : tr('common.na', 'N/A')}
            />
            <Info
              label={tr('loadDetails.fields.rate', 'Rate')}
              value={
                loadDetails?.total_rate != null
                  ? fmtMoney(loadDetails.total_rate)
                  : (loadDetails?.rate != null ? fmtMoney(loadDetails.rate) : tr('common.na', 'N/A'))
              }
            />
          </div>

          <section style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 800, color: '#111827' }}>{tr('loadDetails.docs.title', 'Documents')}</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>{tr('loadDetails.docs.subtitle', 'Rate Confirmation, BoL, and PoD for this load.')}</div>
              </div>
              <button className="btn small ghost-cd" type="button" onClick={fetchDocs} disabled={docsLoading}>
                {docsLoading ? tr('loadDetails.docs.refreshing', 'Refreshing…') : tr('common.refresh', 'Refresh')}
              </button>
            </div>

            {docsError && (
              <div style={{ marginTop: 10, padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8 }}>{docsError}</div>
            )}

            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <PrimaryDoc label={tr('loadDetails.docs.rateConfirmation', 'Rate Confirmation')} doc={rcDoc} onOpen={openDocumentUrl} tr={tr} />
              <PrimaryDoc label={tr('loadDetails.docs.bol', 'BoL')} doc={bolDoc} onOpen={openDocumentUrl} tr={tr} />
              <PrimaryDoc label={tr('loadDetails.docs.pod', 'PoD')} doc={podDoc} onOpen={openDocumentUrl} tr={tr} />
            </div>

            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(documents || []).length === 0 ? (
                <div style={{ color: '#6b7280' }}>{tr('loadDetails.docs.empty', 'No documents uploaded yet.')}</div>
              ) : (
                (documents || []).map((d) => {
                  const url = String(d?.url || '').trim();
                  const isEpodPointer = url.toLowerCase().startsWith('epod:');
                  const kind = String(d?.kind || 'OTHER');
                  const filename = String(d?.filename || '').trim();
                  return (
                    <div
                      key={String(d?.doc_id || d?.id || `${kind}-${filename}`)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        padding: 10,
                        border: '1px solid #e5e7eb',
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: '#111827' }}>{kind}</div>
                        <div style={{ color: '#6b7280', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {filename || (isEpodPointer ? tr('loadDetails.docs.epodRecorded', 'ePOD recorded') : '—')}
                        </div>
                      </div>
                      {url && !isEpodPointer ? (
                        <button className="btn small ghost-cd" type="button" onClick={() => openDocumentUrl(url)}>
                          {tr('common.open', 'Open')}
                        </button>
                      ) : isEpodPointer ? (
                        <span style={{ color: '#6b7280' }}>{tr('loadDetails.docs.recorded', 'Recorded')}</span>
                      ) : (
                        <span style={{ color: '#6b7280' }}>{tr('loadDetails.docs.noUrl', 'No URL')}</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function PrimaryDoc({ label, doc, onOpen, tr }) {
  const url = String(doc?.url || '').trim();
  const filename = String(doc?.filename || '').trim();
  const isEpodPointer = url.toLowerCase().startsWith('epod:');
  const openable = !!url && !isEpodPointer;
  return (
    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 800, color: '#111827' }}>{label}</div>
      <div style={{ color: '#6b7280', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {filename || (isEpodPointer ? tr('loadDetails.docs.epodRecorded', 'ePOD recorded') : (url ? tr('loadDetails.docs.available', 'Document available') : tr('loadDetails.docs.notAvailable', 'Not available')))}
      </div>
      <div style={{ marginTop: 'auto' }}>
        {openable ? (
          <button className="btn small ghost-cd" type="button" onClick={() => onOpen && onOpen(url)}>
            {tr('common.open', 'Open')}
          </button>
        ) : (
          <span style={{ color: '#6b7280', fontSize: 13 }}>—</span>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 10 }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280' }}>{label}</div>
      <div style={{ marginTop: 4, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
