import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../../config';
import { auth } from '../../firebase';

export default function LoadDetailsModal({ load, onClose }) {
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
        setDocsError('Not authenticated');
        return;
      }
      try {
        const token = await user.getIdToken();
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          setDocsError(`Failed to open document (${res.status})`);
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, '_blank', 'noopener,noreferrer');
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } catch (e) {
        setDocsError(e?.message || 'Failed to open document');
      }
    },
    [setDocsError]
  );

  const workflowDisplay = useMemo(() => {
    const wf = String(loadDetails?.workflow_status || '').trim();
    if (wf) return wf;
    const st = String(loadDetails?.status || '').trim();
    if (!st) return 'N/A';
    return st.replace(/_/g, ' ');
  }, [loadDetails?.workflow_status, loadDetails?.status]);

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
    return url ? { kind: 'RATE_CONFIRMATION', url, filename: 'Rate Confirmation' } : null;
  }, [docsByKind, loadDetails?.rate_confirmation_url]);

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
        setLoadError('Failed to load details');
        return;
      }
      const data = await res.json();
      setLoadDetails(data?.load || data);
    } catch (e) {
      setLoadError(e?.message || 'Failed to load details');
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
        setDocsError('Failed to load documents');
        return;
      }
      const data = await res.json();
      setDocuments(Array.isArray(data?.documents) ? data.documents : []);
    } catch (e) {
      setDocuments([]);
      setDocsError(e?.message || 'Failed to load documents');
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
            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>Load Details</div>
            <div style={{ marginTop: 2, color: '#6b7280', fontSize: 13 }}>
              Load: {loadId}{loadLoading ? ' · Loading…' : ''}
            </div>
          </div>
          <button className="btn small ghost-cd" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loadError && (
            <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8 }}>{loadError}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Info label="Status" value={String(loadDetails?.status || 'N/A')} />
            <Info label="Workflow" value={workflowDisplay} />
            <Info label="Assigned Driver" value={String(loadDetails?.assigned_driver_name || (loadDetails?.assigned_driver ? 'Assigned' : 'N/A'))} />
            <Info label="Shipper" value={String(loadDetails?.shipper_company_name || loadDetails?.shipper_name || 'N/A')} />
            <Info label="Origin" value={String(loadDetails?.origin || 'N/A')} />
            <Info label="Destination" value={String(loadDetails?.destination || 'N/A')} />
            <Info label="Pickup" value={String(loadDetails?.pickup_date || 'TBD')} />
            <Info label="Delivery" value={String(loadDetails?.delivery_date || 'TBD')} />
            <Info label="Equipment" value={String(loadDetails?.equipment_type || 'N/A')} />
            <Info label="Weight" value={loadDetails?.weight != null ? String(loadDetails.weight) : 'N/A'} />
            <Info label="Rate" value={loadDetails?.total_rate != null ? `$${Number(loadDetails.total_rate).toLocaleString()}` : (loadDetails?.rate != null ? `$${Number(loadDetails.rate).toLocaleString()}` : 'N/A')} />
          </div>

          <section style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 800, color: '#111827' }}>Documents</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>Rate Confirmation, BoL, and PoD for this load.</div>
              </div>
              <button className="btn small ghost-cd" type="button" onClick={fetchDocs} disabled={docsLoading}>
                {docsLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {docsError && (
              <div style={{ marginTop: 10, padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8 }}>{docsError}</div>
            )}

            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <PrimaryDoc label="Rate Confirmation" doc={rcDoc} onOpen={openDocumentUrl} />
              <PrimaryDoc label="BoL" doc={bolDoc} onOpen={openDocumentUrl} />
              <PrimaryDoc label="PoD" doc={podDoc} onOpen={openDocumentUrl} />
            </div>

            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(documents || []).length === 0 ? (
                <div style={{ color: '#6b7280' }}>No documents uploaded yet.</div>
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
                          {filename || (isEpodPointer ? 'ePOD recorded' : '—')}
                        </div>
                      </div>
                      {url && !isEpodPointer ? (
                        <button className="btn small ghost-cd" type="button" onClick={() => openDocumentUrl(url)}>
                          Open
                        </button>
                      ) : isEpodPointer ? (
                        <span style={{ color: '#6b7280' }}>Recorded</span>
                      ) : (
                        <span style={{ color: '#6b7280' }}>No URL</span>
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

function PrimaryDoc({ label, doc, onOpen }) {
  const url = String(doc?.url || '').trim();
  const filename = String(doc?.filename || '').trim();
  const isEpodPointer = url.toLowerCase().startsWith('epod:');
  const openable = !!url && !isEpodPointer;
  return (
    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 800, color: '#111827' }}>{label}</div>
      <div style={{ color: '#6b7280', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {filename || (isEpodPointer ? 'ePOD recorded' : (url ? 'Document available' : 'Not available'))}
      </div>
      <div style={{ marginTop: 'auto' }}>
        {openable ? (
          <button className="btn small ghost-cd" type="button" onClick={() => onOpen && onOpen(url)}>
            Open
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
