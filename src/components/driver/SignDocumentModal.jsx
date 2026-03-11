import React, { useEffect, useMemo, useRef, useState } from 'react'
import '../../styles/driver/SignDocumentModal.css'
import { useAuth } from '../../contexts/AuthContext'
import { useUserSettings } from '../../contexts/UserSettingsContext'
import { API_URL } from '../../config'
import { t } from '../../i18n/translate'

export default function SignDocumentModal({ documentItem, onClose, onSigned, mode = 'view' }){
  const [templateHtml, setTemplateHtml] = useState('')
  const [templateLoading, setTemplateLoading] = useState(false)
  const [templateError, setTemplateError] = useState('')

  const [driverName, setDriverName] = useState('')
  const [signMethod, setSignMethod] = useState('typed') // typed | image
  const [signatureExists, setSignatureExists] = useState(false)
  const [signaturePreviewUrl, setSignaturePreviewUrl] = useState('')
  const [uploadingSignature, setUploadingSignature] = useState(false)

  const [exportingPdf, setExportingPdf] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const { currentUser } = useAuth()
  const { settings } = useUserSettings()
  const language = settings?.language || 'en'
  const tr = (key, fallback) => t(language, key, fallback)

  useEffect(()=>{
    // lock background scroll while modal open
    document.body.classList.add('fpdd-modal-open')
    const onKey = (e) => { if(e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return ()=>{ document.body.classList.remove('fpdd-modal-open'); window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const iframeRef = useRef(null)

  const iframeSrcDoc = useMemo(() => {
    // Always render server-generated template HTML (isolated in iframe).
    const loadingText = tr('signDocumentModal.preview.loadingHtml', 'Loading…')
    return templateHtml || `<html><body style="font-family: Arial, sans-serif; padding: 16px;">${loadingText}</body></html>`
  }, [templateHtml, language])

  const apiFetch = async (path, init = {}) => {
    if (!currentUser) throw new Error(tr('signDocumentModal.errors.notSignedIn', 'Not signed in'))
    const token = await currentUser.getIdToken()
    const headers = new Headers(init.headers || {})
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(`${API_URL}${path}`, { ...init, headers })
  }

  const emitNotification = (notif) => {
    try {
      if (!notif || typeof notif !== 'object') return
      const id = String(notif?.id || '').trim()
      if (!id) return
      window.dispatchEvent(new CustomEvent('fp-notification', { detail: { notification: notif } }))
    } catch (_) {
      // noop
    }
  }

  const loadTemplateAndSignature = async () => {
    if (!currentUser || !documentItem?.key) return
    setTemplateLoading(true)
    setTemplateError('')
    setError('')
    try {
      const wantsSigned = Boolean(documentItem?.signed_at)
      if (wantsSigned) {
        const signedRes = await apiFetch(`/consents/${encodeURIComponent(documentItem.key)}/signed-document`, { method: 'GET' })
        if (signedRes.ok) {
          const signedData = await signedRes.json()
          setTemplateHtml(String(signedData?.html || ''))
        } else {
          // Fallback to template if signed doc not found (older records).
          const res = await apiFetch(`/consents/${encodeURIComponent(documentItem.key)}/template`, { method: 'GET' })
          if (!res.ok) {
            const text = await res.text()
            throw new Error(text || 'Failed to load template')
          }
          const data = await res.json()
          setTemplateHtml(String(data?.html || ''))
          setDriverName(String(data?.driver?.name || ''))
        }
      } else {
        const res = await apiFetch(`/consents/${encodeURIComponent(documentItem.key)}/template`, {
          method: 'GET'
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || 'Failed to load template')
        }
        const data = await res.json()
        setTemplateHtml(String(data?.html || ''))
        setDriverName(String(data?.driver?.name || ''))
      }

      const sigRes = await apiFetch('/consents/signature-image', { method: 'GET' })
      if (sigRes.ok) {
        const sigData = await sigRes.json()
        const exists = Boolean(sigData?.exists)
        setSignatureExists(exists)
        if (exists) {
          const rawRes = await apiFetch('/consents/signature-image/raw', { method: 'GET' })
          if (rawRes.ok) {
            const blob = await rawRes.blob()
            const url = URL.createObjectURL(blob)
            setSignaturePreviewUrl(url)
          } else {
            setSignaturePreviewUrl('')
          }
        } else {
          setSignaturePreviewUrl('')
        }
      }
    } catch (e) {
      console.error('Template/signature load error:', e)
      setTemplateError(tr('signDocumentModal.errors.previewLoadFailed', 'Could not load the document preview.'))
    } finally {
      setTemplateLoading(false)
    }
  }

  useEffect(() => {
    loadTemplateAndSignature()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentItem?.key])

  useEffect(() => {
    return () => {
      if (signaturePreviewUrl) {
        try { URL.revokeObjectURL(signaturePreviewUrl) } catch (_) { /* noop */ }
      }
    }
  }, [signaturePreviewUrl])

  if(!documentItem) return null

  const canSign = Boolean(documentItem?.key) && Boolean(documentItem?.version) && documentItem?.status !== 'Signed'

  const isViewOnly = mode === 'view'
  const titleText = documentItem.title || tr('signDocumentModal.defaults.documentTitle', 'Consent Document')

  const SIGN_METHOD_LABELS = {
    typed: { key: 'signDocumentModal.signMethod.typed', fallback: 'Type name (auto-filled)' },
    image: { key: 'signDocumentModal.signMethod.image', fallback: 'Signature image (stored)' },
  }

  const methodLabel = (value) => {
    const config = SIGN_METHOD_LABELS[value]
    return config ? tr(config.key, config.fallback) : String(value || '')
  }

  const handleUploadSignature = async (file) => {
    if (!file) return
    if (!currentUser) {
      setError(tr('signDocumentModal.errors.mustBeSignedInToUpload', 'You must be signed in to upload a signature image.'))
      return
    }
    if (file.type && file.type !== 'image/png') {
      setError(tr('signDocumentModal.errors.onlyPngAllowed', 'Only PNG signature images are allowed.'))
      return
    }
    setUploadingSignature(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await apiFetch('/consents/signature-image', {
        method: 'POST',
        body: form
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || 'Upload failed')
      }
      try {
        const data = await res.json()
        emitNotification(data?.notification)
      } catch (_) {
        // ignore
      }
      await loadTemplateAndSignature()
    } catch (e) {
      console.error('Signature upload error:', e)
      setError(tr('signDocumentModal.errors.signatureUploadFailed', 'Could not upload signature image. Please try again.'))
    } finally {
      setUploadingSignature(false)
    }
  }

  const handleConfirmSign = async () => {
    if (!canSign) {
      setError(tr('signDocumentModal.errors.cannotSignNow', 'This document cannot be signed right now.'))
      return
    }
    if (!currentUser) {
      setError(tr('signDocumentModal.errors.mustBeSignedInToSign', 'You must be signed in to sign documents.'))
      return
    }
    if (!documentItem?.version) {
      setError(tr('signDocumentModal.errors.missingVersion', 'Missing consent version. Please close and reopen.'))
      return
    }
    if (signMethod === 'image' && !signatureExists) {
      setError(tr('signDocumentModal.errors.signatureImageMissing', 'Signature image not found. Upload a PNG signature image first.'))
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const res = await apiFetch(`/consents/${encodeURIComponent(documentItem.key)}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: documentItem.version,
          method: signMethod,
          gps_lat: null,
          gps_lng: null
        })
      })
      if (!res.ok) {
        let msg = 'Sign request failed'
        try {
          const data = await res.json()
          const detail = data?.detail
          if (typeof detail === 'string') msg = detail
          if (detail && typeof detail === 'object') {
            msg = String(detail.message || msg)
          }
        } catch (_) {
          const text = await res.text()
          if (text) msg = text
        }
        throw new Error(msg)
      }
      try {
        const data = await res.json()
        emitNotification(data?.notification)
      } catch (_) {
        // ignore
      }
      if (typeof onSigned === 'function') {
        await onSigned()
      }
      onClose()
    } catch (e) {
      console.error('Sign error:', e)
      setError(e?.message || tr('signDocumentModal.errors.signFailed', 'Could not sign the document. Please try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevoke = async () => {
    if (!documentItem?.key) return
    if (!currentUser) {
      setError(tr('signDocumentModal.errors.mustBeSignedInToRevoke', 'You must be signed in to revoke consents.'))
      return
    }
    const ok = window.confirm(tr('signDocumentModal.confirms.revoke', 'Revoke this consent? This may immediately block marketplace access.'))
    if (!ok) return

    setSubmitting(true)
    setError('')
    try {
      const res = await apiFetch(`/consents/${encodeURIComponent(documentItem.key)}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: null })
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || 'Revoke failed')
      }
      try {
        const data = await res.json()
        emitNotification(data?.notification)
      } catch (_) {
        // ignore
      }
      if (typeof onSigned === 'function') {
        await onSigned()
      }
      onClose()
    } catch (e) {
      console.error('Revoke error:', e)
      setError(tr('signDocumentModal.errors.revokeFailed', 'Could not revoke consent. Please try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  const buildPdfFromIframe = async () => {
    const body = iframeRef.current?.contentDocument?.body
    if (!body) throw new Error(tr('signDocumentModal.errors.previewNotReady', 'Document preview is not ready yet.'))

    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })

    // Render the HTML content as a PDF.
    await doc.html(body, {
      x: 24,
      y: 24,
      width: 560,
      windowWidth: 900
    })
    return doc
  }

  const handleExportPdf = async () => {
    setExportingPdf(true)
    setError('')
    try {
      const doc = await buildPdfFromIframe()
      const safeKey = String(documentItem?.key || 'document').replace(/[^a-z0-9._-]/gi, '_')
      doc.save(`freightpower_${safeKey}.pdf`)
    } catch (e) {
      console.error('Export PDF error:', e)
      setError(e?.message || tr('signDocumentModal.errors.exportPdfFailed', 'Could not export PDF.'))
    } finally {
      setExportingPdf(false)
    }
  }

  const handleSharePdf = async () => {
    setExportingPdf(true)
    setError('')
    try {
      const doc = await buildPdfFromIframe()
      const safeKey = String(documentItem?.key || 'document').replace(/[^a-z0-9._-]/gi, '_')
      const blob = doc.output('blob')
      const file = new File([blob], `freightpower_${safeKey}.pdf`, { type: 'application/pdf' })

      if (navigator?.canShare && navigator.canShare({ files: [file] }) && navigator?.share) {
        await navigator.share({
          title: documentItem?.title || tr('signDocumentModal.share.defaultTitle', 'Signed Document'),
          text: tr('signDocumentModal.share.defaultText', 'Signed document attachment'),
          files: [file]
        })
      } else {
        // Fallback: download if share-with-attachment is not supported.
        doc.save(`freightpower_${safeKey}.pdf`)
      }
    } catch (e) {
      console.error('Share PDF error:', e)
      setError(e?.message || tr('signDocumentModal.errors.sharePdfFailed', 'Could not share PDF.'))
    } finally {
      setExportingPdf(false)
    }
  }

  return (
    <div className="fpdd-sig-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="fpdd-sig-modal" onClick={e => e.stopPropagation()}>
        <div className="fpdd-sig-header">
          <div className="fpdd-sig-header-left">
            <div className="fpdd-sig-titles">
              <h3>{isViewOnly ? tr('signDocumentModal.header.view', 'View Document') : tr('signDocumentModal.header.sign', 'Sign Document')}</h3>
              <div className="fpdd-sig-doctitle">{titleText}</div>
              <div className="fpdd-sig-subsmall">{tr('signDocumentModal.subheader.legalLine', 'Legally binding digital signature — ESIGN/UETA compliant')}</div>
            </div>
          </div>
          <button className="fpdd-sig-close" onClick={onClose} aria-label={tr('common.close', 'Close')}>✕</button>
        </div>

        <div className="fpdd-sig-body">
          <div className="fpdd-sig-left">
            <h4 className="fpdd-section-title">{tr('signDocumentModal.preview.title', 'Document Preview')}</h4>
            <div className="fpdd-sig-preview" style={{ padding: 0 }}>
              {templateError ? (
                <div style={{ padding: 14 }} className="fpdd-preview-row">{templateError}</div>
              ) : (
                <iframe
                  title={tr('signDocumentModal.preview.iframeTitle', 'Consent template')}
                  ref={iframeRef}
                  srcDoc={iframeSrcDoc}
                  style={{ width: '100%', height: 430, border: 'none', display: 'block' }}
                />
              )}
            </div>

            {!isViewOnly && (
              <>
                <h4 className="fpdd-section-title" style={{ marginTop: 12 }}>{tr('signDocumentModal.signature.title', 'Signature')}</h4>
                <div className="fpdd-info-card">
                  <div className="fpdd-sig-fields" style={{ alignItems: 'flex-end' }}>
                    <div className="fpdd-sig-field" style={{ flex: 1 }}>
                      <label>{tr('signDocumentModal.signature.signingMethod', 'Signing Method')}</label>
                      <select value={signMethod} onChange={e => setSignMethod(e.target.value)}>
                        <option value="typed">{methodLabel('typed')}</option>
                        <option value="image">{methodLabel('image')}</option>
                      </select>
                    </div>
                    <div className="fpdd-sig-field" style={{ flex: 1 }}>
                      <label>{tr('signDocumentModal.signature.driverName', 'Driver Name (auto-fetched)')}</label>
                      <input value={driverName || tr('signDocumentModal.defaults.driverName', 'Driver')} readOnly />
                    </div>
                  </div>

                  {signMethod === 'image' && (
                    <div style={{ marginTop: 10 }}>
                      {signatureExists && signaturePreviewUrl ? (
                        <div>
                          <div className="fpdd-preview-row" style={{ marginBottom: 8 }}>{tr('signDocumentModal.signature.imageOnFile', 'Signature image on file:')}</div>
                          <img
                            src={signaturePreviewUrl}
                            alt={tr('signDocumentModal.signature.storedAlt', 'Stored signature')}
                            style={{ maxWidth: '100%', maxHeight: 120, borderRadius: 8 }}
                          />
                        </div>
                      ) : (
                        <div>
                          <div className="fpdd-preview-row" style={{ marginBottom: 8 }}>
                            {tr('signDocumentModal.signature.noImageFound', 'No signature image found. Upload a PNG signature image to continue.')}
                          </div>
                          <input
                            type="file"
                            accept="image/png"
                            disabled={uploadingSignature}
                            onChange={e => handleUploadSignature(e.target.files?.[0] || null)}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="fpdd-sig-footer">
          {error ? <div className="fpdd-sig-subsmall" style={{ color: '#dc2626' }}>{error}</div> : null}

          {!isViewOnly && (
            <button className="btn small-cd" onClick={handleConfirmSign} disabled={submitting || templateLoading || !canSign}>
              {submitting ? tr('signDocumentModal.actions.signing', 'Signing…') : tr('signDocumentModal.actions.confirmSign', 'Confirm & Sign')}
            </button>
          )}

          {documentItem?.status === 'Signed' && (
            <button className="btn small ghost-cd" onClick={handleRevoke} disabled={submitting}>
              {tr('signDocumentModal.actions.revokeConsent', 'Revoke Consent')}
            </button>
          )}

          {isViewOnly && (
            <div className="fpdd-sig-secondary" style={{marginTop:12}}>
              <button className="btn small ghost-cd" onClick={handleExportPdf} disabled={exportingPdf || templateLoading}>
                {exportingPdf ? tr('signDocumentModal.actions.preparing', 'Preparing…') : tr('signDocumentModal.actions.exportPdf', 'Export as PDF')}
              </button>
              <button className="btn small ghost-cd" onClick={handleSharePdf} disabled={exportingPdf || templateLoading}>
                {exportingPdf ? tr('signDocumentModal.actions.preparing', 'Preparing…') : tr('signDocumentModal.actions.sharePdf', 'Share (PDF attachment)')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
