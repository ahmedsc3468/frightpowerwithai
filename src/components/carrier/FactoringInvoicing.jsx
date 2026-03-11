import React, { useCallback, useEffect, useMemo, useState } from 'react';
import '../../styles/carrier/FactoringInvoicing.css';
import {
  createInvoice,
  emailInvoice,
  downloadInvoicePackageZip,
  getFinanceForecast,
  getFinanceSummary,
  getInvoicePdfContext,
  issueInvoice,
  listEligibleLoads,
  listInvoices,
  recordInvoicePayment,
  resolveInvoiceDispute,
  sendInvoice,
  voidInvoice,
} from '../../api/finance';
import InvoicePreview from '../shipper/InvoicePreview';
import { copyText, downloadInvoicePdf, generateInvoicePdfDataUri, saveInvoiceDraftToLocal } from '../../utils/invoiceActions';

const FactoringInvoicing = () => {
  const [selectedStatus, setSelectedStatus] = useState('All Status');
  const [selectedFactoring, setSelectedFactoring] = useState('All Factoring');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('invoices'); // 'invoices' | 'drafts'

  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [sortBy, setSortBy] = useState('created_at'); // created_at | due_date | amount
  const [sortDir, setSortDir] = useState('desc'); // asc | desc
  const [payerRoleFilter, setPayerRoleFilter] = useState('all');
  const [issuerRoleFilter, setIssuerRoleFilter] = useState('all');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [invoices, setInvoices] = useState([]);
  const [summary, setSummary] = useState(null);
  const [forecast, setForecast] = useState(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [previewInvoice, setPreviewInvoice] = useState(null);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailTarget, setEmailTarget] = useState(null); // row-like { invoiceId, raw, status, ... }
  const [emailForm, setEmailForm] = useState({ to: '', subject: '', body: '' });
  const [emailSending, setEmailSending] = useState(false);
  const [eligibleLoads, setEligibleLoads] = useState([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [createForm, setCreateForm] = useState({
    loadId: '',
    invoiceNumber: '',
    invoiceDate: '',
    dueDate: '',
    dueInDays: '',

    billToName: '',
    billToEmail: '',
    reference: '',

    lineItems: [{ description: 'Line Haul', quantity: 1, rate: '' }],
    fuelSurcharge: '',
    otherCharges: '',
    discount: '',
    useTotalOverride: false,
    totalOverride: '',

    notes: '',

    recipientEmail: '',
    emailSubject: '',
    emailMessage: '',
  });

  const createTotals = useMemo(() => {
    const items = Array.isArray(createForm.lineItems) ? createForm.lineItems : [];
    const subtotal = items.reduce((sum, it) => {
      const qty = Number(it?.quantity || 0);
      const rate = Number(it?.rate || 0);
      if (!Number.isFinite(qty) || !Number.isFinite(rate)) return sum;
      return sum + qty * rate;
    }, 0);
    const fuel = Number(createForm.fuelSurcharge || 0);
    const other = Number(createForm.otherCharges || 0);
    const discount = Number(createForm.discount || 0);

    const charges = (Number.isFinite(fuel) ? fuel : 0) + (Number.isFinite(other) ? other : 0);
    const computedTotal = subtotal + charges - (Number.isFinite(discount) ? discount : 0);

    let total = computedTotal;
    if (createForm.useTotalOverride) {
      const override = Number(createForm.totalOverride);
      if (Number.isFinite(override) && override > 0) total = override;
    }

    return {
      subtotal,
      charges,
      fuel: Number.isFinite(fuel) ? fuel : 0,
      other: Number.isFinite(other) ? other : 0,
      discount: Number.isFinite(discount) ? discount : 0,
      computedTotal,
      total,
    };
  }, [createForm]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [invRes, sumRes, fcRes] = await Promise.all([
        listInvoices({ limit: 250 }),
        getFinanceSummary(),
        getFinanceForecast({ rangeDays: 30 }),
      ]);
      setInvoices(invRes?.invoices || []);
      setSummary(sumRes || null);
      setForecast(fcRes || null);
    } catch (e) {
      setError(e?.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Filter UI is a fixed overlay modal; no click-outside ref needed.

  const rows = useMemo(() => {
    return (invoices || []).map((inv) => {
      const invoiceNumber = inv.invoice_number || inv.invoice_id || '—';
      const dueDate = inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString() : '—';
      const payerShort = inv.payer_uid ? `${String(inv.payer_uid).slice(0, 8)}…` : '—';

      return {
        id: invoiceNumber,
        invoiceId: inv.invoice_id,
        loadId: inv.load_number || inv.load_id || '—',
        customer: inv.payer_role ? `${inv.payer_role} (${payerShort})` : payerShort,
        amount: Number(inv.amount_total || 0),
        dueDate,
        status: String(inv.status || 'unknown').toLowerCase(),
        factoring: inv.factoring_enabled ? 'yes' : 'no',
        raw: inv,
      };
    });
  }, [invoices]);

  const draftInvoices = useMemo(() => {
    return (rows || []).filter((r) => String(r.status || '').toLowerCase() === 'draft');
  }, [rows]);

  const _matchesSearchAndFactoring = (invoice) => {
    const q = String(searchTerm || '').toLowerCase();
    const matchesSearch =
      String(invoice.customer || '').toLowerCase().includes(q) ||
      String(invoice.id || '').toLowerCase().includes(q) ||
      String(invoice.loadId || '').toLowerCase().includes(q);

    const matchesFactoring =
      selectedFactoring === 'All Factoring' ||
      (selectedFactoring === 'Yes' && invoice.factoring === 'yes') ||
      (selectedFactoring === 'No' && invoice.factoring === 'no');

    return matchesSearch && matchesFactoring;
  };

  const filteredInvoices = rows.filter((invoice) => {
    const matchesStatus = selectedStatus === 'All Status' || invoice.status === selectedStatus.toLowerCase();
    return _matchesSearchAndFactoring(invoice) && matchesStatus;
  });

  const filteredDrafts = useMemo(() => {
    return (draftInvoices || []).filter(_matchesSearchAndFactoring);
  }, [draftInvoices, searchTerm, selectedFactoring]);

  const tabRows = useMemo(() => {
    if (activeTab === 'drafts') return filteredDrafts;
    return filteredInvoices;
  }, [activeTab, filteredDrafts, filteredInvoices]);

  const visibleRows = useMemo(() => {
    const base = Array.isArray(tabRows) ? tabRows : [];

    const roleFiltered = base.filter((r) => {
      const payerRole = String(r?.raw?.payer_role || '').toLowerCase();
      const issuerRole = String(r?.raw?.issuer_role || '').toLowerCase();

      const payerOk = payerRoleFilter === 'all' || payerRole === String(payerRoleFilter).toLowerCase();
      const issuerOk = issuerRoleFilter === 'all' || issuerRole === String(issuerRoleFilter).toLowerCase();
      return payerOk && issuerOk;
    });

    const dir = String(sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const key = String(sortBy || 'created_at');
    const sorted = [...roleFiltered].sort((a, b) => {
      let av;
      let bv;

      if (key === 'amount') {
        av = Number(a?.amount || 0);
        bv = Number(b?.amount || 0);
      } else if (key === 'due_date') {
        av = Number(a?.raw?.due_date || 0);
        bv = Number(b?.raw?.due_date || 0);
      } else {
        // created_at
        av = Number(a?.raw?.created_at || 0);
        bv = Number(b?.raw?.created_at || 0);
      }

      if (!Number.isFinite(av)) av = 0;
      if (!Number.isFinite(bv)) bv = 0;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });

    return sorted;
  }, [tabRows, issuerRoleFilter, payerRoleFilter, sortBy, sortDir]);

  const getTotalAmount = () => {
    return (visibleRows || []).reduce((sum, invoice) => sum + invoice.amount, 0);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'paid': return 'green';
      case 'disputed': return 'purple';
      case 'sent': return 'yellow';
      case 'overdue': return 'red';
      default: return 'gray';
    }
  };

  const _openEmailModal = (row, { defaultTo, defaultSubject, defaultBody } = {}) => {
    if (!row?.invoiceId || !row?.raw) return;
    const invoiceNumber = row.raw?.invoice_number || row.raw?.invoice_id || 'Invoice';
    const to = (defaultTo ?? row.raw?.metadata?.bill_to?.email ?? '').toString().trim();

    const subject = (defaultSubject ?? `Invoice ${invoiceNumber}`).toString().trim() || `Invoice ${invoiceNumber}`;
    const body = (defaultBody ?? [
      `Invoice: ${invoiceNumber}`,
      `Load: ${row.raw?.load_id || '—'}`,
      `Amount: ${Number(row.raw?.amount_total || 0).toFixed(2)} ${row.raw?.currency || 'USD'}`,
      `Due: ${row.raw?.due_date ? new Date(row.raw?.due_date * 1000).toLocaleDateString() : '—'}`,
      '',
      'Please see attached PDF.',
    ].join('\n')).toString();

    setEmailTarget(row);
    setEmailForm({ to, subject, body });
    setShowEmailModal(true);
  };

  const _closeEmailModal = () => {
    setShowEmailModal(false);
    setEmailTarget(null);
    setEmailForm({ to: '', subject: '', body: '' });
    setEmailSending(false);
  };

  const _rowFromRawInvoice = (inv) => {
    if (!inv) return null;
    const invoiceNumber = inv.invoice_number || inv.invoice_id || '—';
    const dueDate = inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString() : '—';
    const payerShort = inv.payer_uid ? `${String(inv.payer_uid).slice(0, 8)}…` : '—';
    return {
      id: invoiceNumber,
      invoiceId: inv.invoice_id,
      loadId: inv.load_id || '—',
      customer: inv.payer_role ? `${inv.payer_role} (${payerShort})` : payerShort,
      amount: Number(inv.amount_total || 0),
      dueDate,
      status: String(inv.status || 'unknown').toLowerCase(),
      factoring: inv.factoring_enabled ? 'yes' : 'no',
      raw: inv,
    };
  };

  const handleSendEmail = async () => {
    if (!emailTarget?.invoiceId || !emailTarget?.raw) return;
    const currentStatus = String(emailTarget.status || emailTarget.raw?.status || '').toLowerCase();
    if (currentStatus === 'void') {
      setError('Cannot email a void invoice');
      return;
    }

    const to = String(emailForm.to || '').trim();
    const subject = String(emailForm.subject || '').trim();
    const body = String(emailForm.body || '');
    if (!to) {
      setError('Missing recipient email');
      return;
    }
    if (!subject) {
      setError('Missing email subject');
      return;
    }

    setError('');
    setEmailSending(true);
    try {
      let status = currentStatus;
      let invoiceRaw = emailTarget.raw;

      if (status === 'draft') {
        const ok = window.confirm('This invoice is a draft. Issue it now before emailing?');
        if (!ok) {
          setError('Draft invoice was not issued');
          return;
        }
        await issueInvoice(emailTarget.invoiceId);
        status = 'issued';
        // Refresh to get latest raw state (timestamps/status)
        await refresh();
      }

      const invoiceNumber = emailTarget.raw?.invoice_number || emailTarget.raw?.invoice_id || 'Invoice';
      let ctx = null;
      try {
        ctx = await getInvoicePdfContext(emailTarget.invoiceId);
      } catch {
        ctx = { invoice: invoiceRaw };
      }
      const pdfDataUri = generateInvoicePdfDataUri(ctx);
      await emailInvoice(emailTarget.invoiceId, {
        to,
        subject,
        body,
        pdf_base64: pdfDataUri,
        filename: `${invoiceNumber}.pdf`,
      });

      // Mark as sent after successful email send
      if (status === 'issued') {
        await sendInvoice(emailTarget.invoiceId);
      }

      _closeEmailModal();
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to send email');
    } finally {
      setEmailSending(false);
    }
  };

  const handleEmailWithPdf = (invoice) => {
    _openEmailModal(invoice);
  };

  const handleIssue = async (invoiceId) => {
    if (!invoiceId) return;
    setError('');
    try {
      await issueInvoice(invoiceId);
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to issue invoice');
    }
  };

  const handleVoid = async (invoiceId) => {
    if (!invoiceId) return;
    const ok = window.confirm('Void this invoice? This cannot be undone.');
    if (!ok) return;
    setError('');
    try {
      await voidInvoice(invoiceId);
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to void invoice');
    }
  };

  const handleSubmitFactoring = async (invoiceId) => {
    // Placeholder only (factoring intentionally de-scoped for now).
    if (!invoiceId) return;
    setError('Factoring is coming soon (placeholder).');
  };

  const handleRecordPayment = async (invoiceId) => {
    if (!invoiceId) return;
    const raw = window.prompt('Payment amount (USD)?', '');
    if (!raw) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Invalid payment amount');
      return;
    }
    setError('');
    try {
      await recordInvoicePayment(invoiceId, { amount, currency: 'USD', method: 'other' });
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to record payment');
    }
  };

  const _loadLabel = (l) => {
    if (!l) return '—';
    const o = l.origin?.city || l.origin?.name || l.origin?.address || '';
    const d = l.destination?.city || l.destination?.name || l.destination?.address || '';
    const route = [o, d].filter(Boolean).join(' → ');
    const status = l.status ? String(l.status).toUpperCase() : '';
    const ref = l.load_number || l.load_id;
    const terms = String(l?.payment_terms || '').trim();
    const termsBadge = terms ? ` · Terms: ${terms}` : '';
    return `${ref}${route ? ` — ${route}` : ''}${status ? ` (${status})` : ''}${termsBadge}`;
  };

  const handleDownloadPackage = async (row) => {
    const invoiceId = row?.invoiceId;
    if (!invoiceId) return;
    setError('');
    try {
      const blob = await downloadInvoicePackageZip(invoiceId);
      const filename = `${row?.raw?.invoice_number || invoiceId}_package.zip`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError(e?.message || 'Failed to download invoice package');
    }
  };

  const handleResolveDispute = async (row) => {
    const invoiceId = row?.invoiceId;
    if (!invoiceId) return;
    const ok = window.confirm('Resolve this dispute and return invoice to SENT?');
    if (!ok) return;
    setError('');
    try {
      await resolveInvoiceDispute(invoiceId);
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to resolve dispute');
    }
  };

  const openCreateModal = async () => {
    setError('');
    setShowCreateModal(true);
    setEligibleLoading(true);
    try {
      const res = await listEligibleLoads({ limit: 200 });
      setEligibleLoads(res?.loads || []);
      setCreateForm((f) => ({ ...f, loadId: (res?.loads || [])?.[0]?.load_id || '' }));
    } catch (e) {
      setError(e?.message || 'Failed to load eligible loads');
      setEligibleLoads([]);
    } finally {
      setEligibleLoading(false);
    }
  };

  const selectedEligibleLoad = useMemo(() => {
    const id = String(createForm.loadId || '').trim();
    if (!id) return null;
    return (eligibleLoads || []).find((l) => String(l?.load_id || '').trim() === id) || null;
  }, [eligibleLoads, createForm.loadId]);

  const selectedLoadHasPod = Boolean(selectedEligibleLoad?.has_pod);

  const closeCreateModal = () => {
    setShowCreateModal(false);
    setEligibleLoads([]);
    setEligibleLoading(false);
    setCreateForm({
      loadId: '',
      invoiceNumber: '',
      invoiceDate: '',
      dueDate: '',
      dueInDays: '',
      billToName: '',
      billToEmail: '',
      reference: '',
      lineItems: [{ description: 'Line Haul', quantity: 1, rate: '' }],
      fuelSurcharge: '',
      otherCharges: '',
      discount: '',
      useTotalOverride: false,
      totalOverride: '',
      notes: '',
      recipientEmail: '',
      emailSubject: '',
      emailMessage: '',
    });
  };

  const submitCreateInvoice = async (mode, e) => {
    e?.preventDefault?.();
    setError('');

    const loadId = String(createForm.loadId || '').trim();
    if (!loadId) {
      setError('Please select a completed load');
      return;
    }

    if (mode !== 'draft' && !selectedLoadHasPod) {
      const ok = window.confirm('This load has no POD on file yet. Save as a draft instead?');
      if (ok) return submitCreateInvoice('draft', e);
      setError('POD is required to issue/send. Save as draft until POD is uploaded.');
      return;
    }

    const amountTotal = Number(createTotals.total);
    if (!Number.isFinite(amountTotal) || amountTotal <= 0) {
      setError('Please enter valid line items / totals');
      return;
    }

    let dueInDays = null;
    if (String(createForm.dueInDays || '').trim()) {
      const v = Number(createForm.dueInDays);
      if (!Number.isFinite(v) || v < 1 || v > 120 || !Number.isInteger(v)) {
        setError('Due in days must be a whole number between 1 and 120');
        return;
      }
      dueInDays = v;
    }

    let dueDate = null;
    if (String(createForm.dueDate || '').trim()) {
      const t = new Date(String(createForm.dueDate)).getTime();
      if (!Number.isFinite(t)) {
        setError('Please enter a valid due date');
        return;
      }
      dueDate = Math.floor(t / 1000);
    }

    const normalizedLineItems = (Array.isArray(createForm.lineItems) ? createForm.lineItems : [])
      .map((it) => {
        const description = String(it?.description || '').trim();
        const quantity = Number(it?.quantity || 0);
        const rate = Number(it?.rate || 0);
        if (!description) return null;
        if (!Number.isFinite(quantity) || quantity <= 0) return null;
        if (!Number.isFinite(rate) || rate < 0) return null;
        return {
          description,
          quantity,
          rate,
          amount: quantity * rate,
        };
      })
      .filter(Boolean);

    setLoading(true);
    try {
      const res = await createInvoice({
        load_id: loadId,
        amount_total: amountTotal,
        currency: 'USD',
        due_in_days: dueInDays,
        due_date: dueDate,
        invoice_number: String(createForm.invoiceNumber || '').trim() || null,
        notes: String(createForm.notes || '').trim() || null,
        save_as_draft: mode === 'draft',
        metadata: {
          bill_to: {
            name: String(createForm.billToName || '').trim() || null,
            email: String(createForm.billToEmail || '').trim() || null,
          },
          reference: String(createForm.reference || '').trim() || null,
          invoice_date: String(createForm.invoiceDate || '').trim() || null,
          line_items: normalizedLineItems,
          charges: {
            fuel_surcharge: createTotals.fuel || 0,
            other: createTotals.other || 0,
            discount: createTotals.discount || 0,
          },
          email: {
            to: String(createForm.recipientEmail || '').trim() || null,
            subject: String(createForm.emailSubject || '').trim() || null,
            message: String(createForm.emailMessage || '').trim() || null,
          },
        },
      });

      if (mode === 'issue_send') {
        const row = {
          id: res?.invoice_number || res?.invoice_id || '—',
          invoiceId: res?.invoice_id,
          loadId: res?.load_id || createForm.loadId || '—',
          customer: res?.metadata?.bill_to?.name || 'Customer',
          amount: Number(res?.amount_total || 0),
          dueDate: res?.due_date ? new Date(res.due_date * 1000).toLocaleDateString() : '—',
          status: String(res?.status || 'issued').toLowerCase(),
          factoring: res?.factoring_enabled ? 'yes' : 'no',
          raw: res,
        };

        // Close create modal and open a proper email modal.
        closeCreateModal();
        _openEmailModal(row, {
          defaultTo: String(createForm.recipientEmail || createForm.billToEmail || '').trim(),
          defaultSubject: String(createForm.emailSubject || '').trim() || undefined,
          defaultBody: String(createForm.emailMessage || '').trim() || undefined,
        });
        await refresh();
        return;
      }

      closeCreateModal();
      await refresh();
    } catch (err) {
      setError(err?.message || 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  };

  const _csvEscape = (value) => {
    const s = String(value ?? '');
    if (/[\n\r,"]/g.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const handleExport = () => {
    try {
      const headers = ['Invoice #', 'Invoice ID', 'Load ID', 'Customer', 'Amount', 'Due Date', 'Status', 'Factoring'];
      const lines = [headers.map(_csvEscape).join(',')];

      for (const row of visibleRows) {
        lines.push(
          [
            row.id,
            row.invoiceId,
            row.loadId,
            row.customer,
            row.amount,
            row.dueDate,
            row.status,
            row.factoring,
          ].map(_csvEscape).join(',')
        );
      }

      const csv = lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `invoices_${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e?.message || 'Export failed');
    }
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  return (
    <div className="factoring-invoicing">
      {/* Header Section */}
      <div className="factoring-header">
        <div className="factoring-header-content">
          <h1>Factoring & Invoicing</h1>
          <p className="factoring-subtitle">Manage invoices, payments, and factoring operations</p>
        </div>
        <div className="factoring-actions">
          <button className="btn small ghost-cd" onClick={handleExport} disabled={loading}>
            <i className="fas fa-download"></i>
            Export
          </button>
          <button className="btn small-cd" onClick={openCreateModal} disabled={loading}>
            <i className="fas fa-plus"></i>
            Create Invoice
          </button>
        </div>
      </div>

      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fp-dark-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeCreateModal();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 16,
            overflow: 'auto',
            zIndex: 60,
          }}
        >
          <form
            onSubmit={(e) => submitCreateInvoice('issue', e)}
            className="fp-dark-modal"
            style={{
              width: 'min(1280px, 100%)',
              background: '#0b1220',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              borderRadius: 14,
              padding: 16,
              boxShadow: '0 10px 35px rgba(0,0,0,0.35)',
              maxHeight: 'calc(100vh - 32px)',
              overflow: 'auto',
              overflowX: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>Create Invoice</div>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>
                  Drafts can be saved without POD. Issuing/sending requires POD.
                </div>
              </div>
              <button type="button" className="btn small ghost-cd" onClick={closeCreateModal}>
                Close
              </button>
            </div>

            <div className="fp-invoice-create-grid" style={{ display: 'grid', gap: 14, marginTop: 14 }}>
              {/* Left: form */}
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.18)', background: 'rgba(15, 23, 42, 0.55)' }}>
                  <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Load & Invoice</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Load</span>
                      <select
                        value={createForm.loadId}
                        onChange={(e) => setCreateForm((f) => ({ ...f, loadId: e.target.value }))}
                        disabled={eligibleLoading}
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      >
                        {(eligibleLoads || []).length === 0 && (
                          <option value="">{eligibleLoading ? 'Loading…' : 'No eligible completed loads found'}</option>
                        )}
                        {(eligibleLoads || []).map((l) => (
                          <option key={l.load_id} value={l.load_id}>
                            {_loadLabel(l)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Invoice # (optional)</span>
                      <input
                        value={createForm.invoiceNumber}
                        onChange={(e) => setCreateForm((f) => ({ ...f, invoiceNumber: e.target.value }))}
                        placeholder="e.g. INV-2101"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>

                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Invoice Date (optional)</span>
                      <input
                        type="date"
                        value={createForm.invoiceDate}
                        onChange={(e) => setCreateForm((f) => ({ ...f, invoiceDate: e.target.value }))}
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>

                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Due Date (optional)</span>
                      <input
                        type="date"
                        value={createForm.dueDate}
                        onChange={(e) => setCreateForm((f) => ({ ...f, dueDate: e.target.value }))}
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>

                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Due In Days (optional)</span>
                      <input
                        value={createForm.dueInDays}
                        onChange={(e) => setCreateForm((f) => ({ ...f, dueInDays: e.target.value }))}
                        placeholder="e.g. 30"
                        inputMode="numeric"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.18)', background: 'rgba(15, 23, 42, 0.55)' }}>
                  <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Bill To</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Company / Name</span>
                      <input
                        value={createForm.billToName}
                        onChange={(e) => setCreateForm((f) => ({ ...f, billToName: e.target.value }))}
                        placeholder="e.g. ACME Logistics"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Email</span>
                      <input
                        value={createForm.billToEmail}
                        onChange={(e) => setCreateForm((f) => ({ ...f, billToEmail: e.target.value }))}
                        placeholder="e.g. ap@acme.com"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Reference / PO (optional)</span>
                      <input
                        value={createForm.reference}
                        onChange={(e) => setCreateForm((f) => ({ ...f, reference: e.target.value }))}
                        placeholder="e.g. PO-1234"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.18)', background: 'rgba(15, 23, 42, 0.55)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, color: '#e2e8f0' }}>Line Items</div>
                    <button
                      type="button"
                      className="btn small ghost-cd"
                      onClick={() =>
                        setCreateForm((f) => ({
                          ...f,
                          lineItems: [...(Array.isArray(f.lineItems) ? f.lineItems : []), { description: '', quantity: 1, rate: '' }],
                        }))
                      }
                    >
                      + Add
                    </button>
                  </div>

                  <div className="fp-lineitems-grid" style={{ display: 'grid', gap: 10 }}>
                    <div style={{ color: '#94a3b8', fontSize: 12 }}>Description</div>
                    <div style={{ color: '#94a3b8', fontSize: 12 }}>Qty</div>
                    <div style={{ color: '#94a3b8', fontSize: 12 }}>Rate</div>
                    <div />
                    {(Array.isArray(createForm.lineItems) ? createForm.lineItems : []).map((it, idx) => (
                      <React.Fragment key={idx}>
                        <input
                          value={it.description}
                          onChange={(e) =>
                            setCreateForm((f) => {
                              const next = [...(Array.isArray(f.lineItems) ? f.lineItems : [])];
                              next[idx] = { ...next[idx], description: e.target.value };
                              return { ...f, lineItems: next };
                            })
                          }
                          placeholder="e.g. Line Haul"
                          style={{
                            background: '#0f172a',
                            color: '#e2e8f0',
                            border: '1px solid rgba(148, 163, 184, 0.22)',
                            borderRadius: 10,
                            padding: '10px 12px',
                            minWidth: 0,
                          }}
                        />
                        <input
                          value={it.quantity}
                          onChange={(e) =>
                            setCreateForm((f) => {
                              const next = [...(Array.isArray(f.lineItems) ? f.lineItems : [])];
                              next[idx] = { ...next[idx], quantity: e.target.value };
                              return { ...f, lineItems: next };
                            })
                          }
                          inputMode="numeric"
                          style={{
                            background: '#0f172a',
                            color: '#e2e8f0',
                            border: '1px solid rgba(148, 163, 184, 0.22)',
                            borderRadius: 10,
                            padding: '10px 12px',
                            minWidth: 0,
                          }}
                        />
                        <input
                          value={it.rate}
                          onChange={(e) =>
                            setCreateForm((f) => {
                              const next = [...(Array.isArray(f.lineItems) ? f.lineItems : [])];
                              next[idx] = { ...next[idx], rate: e.target.value };
                              return { ...f, lineItems: next };
                            })
                          }
                          inputMode="decimal"
                          placeholder="0.00"
                          style={{
                            background: '#0f172a',
                            color: '#e2e8f0',
                            border: '1px solid rgba(148, 163, 184, 0.22)',
                            borderRadius: 10,
                            padding: '10px 12px',
                            minWidth: 0,
                          }}
                        />
                        <button
                          type="button"
                          className="btn small ghost-cd"
                          onClick={() =>
                            setCreateForm((f) => {
                              const next = [...(Array.isArray(f.lineItems) ? f.lineItems : [])];
                              next.splice(idx, 1);
                              return { ...f, lineItems: next.length ? next : [{ description: 'Line Haul', quantity: 1, rate: '' }] };
                            })
                          }
                          title="Remove"
                        >
                          ×
                        </button>
                      </React.Fragment>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Fuel surcharge</span>
                      <input
                        value={createForm.fuelSurcharge}
                        onChange={(e) => setCreateForm((f) => ({ ...f, fuelSurcharge: e.target.value }))}
                        inputMode="decimal"
                        placeholder="0.00"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Other charges</span>
                      <input
                        value={createForm.otherCharges}
                        onChange={(e) => setCreateForm((f) => ({ ...f, otherCharges: e.target.value }))}
                        inputMode="decimal"
                        placeholder="0.00"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Discount</span>
                      <input
                        value={createForm.discount}
                        onChange={(e) => setCreateForm((f) => ({ ...f, discount: e.target.value }))}
                        inputMode="decimal"
                        placeholder="0.00"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>

                    <label style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Total override (optional)</span>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#cbd5e1', fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={!!createForm.useTotalOverride}
                            onChange={(e) => setCreateForm((f) => ({ ...f, useTotalOverride: e.target.checked }))}
                          />
                          Use override
                        </label>
                        <input
                          value={createForm.totalOverride}
                          onChange={(e) => setCreateForm((f) => ({ ...f, totalOverride: e.target.value }))}
                          inputMode="decimal"
                          placeholder="0.00"
                          disabled={!createForm.useTotalOverride}
                          style={{
                            flex: 1,
                            background: '#0f172a',
                            color: '#e2e8f0',
                            border: '1px solid rgba(148, 163, 184, 0.22)',
                            borderRadius: 10,
                            padding: '10px 12px',
                            opacity: createForm.useTotalOverride ? 1 : 0.6,
                          }}
                        />
                      </div>
                    </label>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.18)', background: 'rgba(15, 23, 42, 0.55)' }}>
                  <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Email (optional)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Recipient</span>
                      <input
                        value={createForm.recipientEmail}
                        onChange={(e) => setCreateForm((f) => ({ ...f, recipientEmail: e.target.value }))}
                        placeholder="ap@customer.com"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Subject</span>
                      <input
                        value={createForm.emailSubject}
                        onChange={(e) => setCreateForm((f) => ({ ...f, emailSubject: e.target.value }))}
                        placeholder="Invoice from FreightPower"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>Message</span>
                      <textarea
                        value={createForm.emailMessage}
                        onChange={(e) => setCreateForm((f) => ({ ...f, emailMessage: e.target.value }))}
                        rows={3}
                        placeholder="Optional message to the recipient"
                        style={{
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          borderRadius: 10,
                          padding: '10px 12px',
                          resize: 'vertical',
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.18)', background: 'rgba(15, 23, 42, 0.55)' }}>
                  <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Notes</div>
                  <textarea
                    value={createForm.notes}
                    onChange={(e) => setCreateForm((f) => ({ ...f, notes: e.target.value }))}
                    rows={3}
                    placeholder="Optional notes (e.g., payment instructions)"
                    style={{
                      width: '100%',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      borderRadius: 10,
                      padding: '10px 12px',
                      resize: 'vertical',
                    }}
                  />
                </div>
              </div>

              {/* Right: summary */}
              <aside style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.18)', background: 'rgba(15, 23, 42, 0.55)', height: 'fit-content' }}>
                <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 10 }}>Invoice Summary</div>
                {!selectedLoadHasPod ? (
                  <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(245, 158, 11, 0.35)', background: 'rgba(245, 158, 11, 0.08)', color: '#fde68a', fontSize: 13 }}>
                    POD not detected for this load yet. You can save a draft now, then issue/send after POD is uploaded.
                  </div>
                ) : null}
                <div style={{ display: 'grid', gap: 8, color: '#e2e8f0', fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>Subtotal</span><span>${createTotals.subtotal.toFixed(2)}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>Charges</span><span>${createTotals.charges.toFixed(2)}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>Discount</span><span>-${createTotals.discount.toFixed(2)}</span></div>
                  <div style={{ height: 1, background: 'rgba(148, 163, 184, 0.18)', margin: '8px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 15 }}>
                    <span>Total</span>
                    <span>${Number(createTotals.total || 0).toFixed(2)}</span>
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn small ghost-cd"
                    onClick={() => {
                      try {
                        const synthetic = {
                          invoice_number: String(createForm.invoiceNumber || '').trim() || 'DRAFT',
                          invoice_id: 'draft',
                          load_id: createForm.loadId,
                          status: 'draft',
                          currency: 'USD',
                          amount_total: createTotals.total,
                          due_date: createForm.dueDate ? Math.floor(new Date(String(createForm.dueDate)).getTime() / 1000) : null,
                          issued_at: null,
                          notes: createForm.notes,
                          metadata: {
                            bill_to: { name: createForm.billToName, email: createForm.billToEmail },
                            line_items: createForm.lineItems,
                            charges: { fuel_surcharge: createForm.fuelSurcharge, other: createForm.otherCharges, discount: createForm.discount },
                          },
                        };
                        downloadInvoicePdf(synthetic);
                      } catch (err) {
                        setError(err?.message || 'PDF preview failed');
                      }
                    }}
                    disabled={loading}
                  >
                    Preview / Download PDF
                  </button>

                  <button
                    type="button"
                    style={{ color: '#fff' }}
                    className="btn small ghost-cd"
                    onClick={(e) => submitCreateInvoice('draft', e)}
                    disabled={loading || eligibleLoading || !createForm.loadId}
                  >
                    Save Draft
                  </button>

                  <button
                    type="submit"
                    className="btn small-cd"
                    disabled={loading || eligibleLoading || !createForm.loadId || !selectedLoadHasPod}
                  >
                    {loading ? 'Working…' : 'Issue Invoice'}
                  </button>

                  <button
                    type="button"
                    className="btn small-cd"
                    onClick={(e) => submitCreateInvoice('issue_send', e)}
                    disabled={loading || eligibleLoading || !createForm.loadId || !selectedLoadHasPod}
                    style={{ background: '#16a34a', color: '#fff' }}
                  >
                    Issue & Send (Email + PDF)
                  </button>

                  <button type="button" className="btn small ghost-cd" onClick={closeCreateModal} disabled={loading}>
                    Cancel
                  </button>
                </div>
              </aside>
            </div>
          </form>
        </div>
      )}

      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.12)', color: '#fecaca', padding: '12px 16px', borderRadius: 10, marginBottom: 16, border: '1px solid rgba(239, 68, 68, 0.25)' }}>
          {error}
        </div>
      )}

      {/* Metrics Cards */}
      <div className="factoring-metrics">
        <div className="metric-card">
          <div className="metric-icon">
            <i className="fas fa-file-invoice-dollar"></i>
          </div>
          <div className="metric-content">
            <div className="metric-number">{formatCurrency(summary?.outstanding_amount || 0)}</div>
            <div className="metric-label">Outstanding Invoices</div>
          </div>
        </div>
        
        <div className="metric-card">
          <div className="metric-icon">
            <i className="fas fa-bolt"></i>
          </div>
          <div className="metric-content">
            <div className="metric-number">{formatCurrency(summary?.factoring_outstanding_amount || 0)}</div>
            <div className="metric-label">Factoring Advances</div>
          </div>
        </div>
        
        <div className="metric-card">
          <div className="metric-icon">
            <i className="fas fa-check-circle"></i>
          </div>
          <div className="metric-content">
            <div className="metric-number">{formatCurrency(summary?.paid_amount_30d || 0)}</div>
            <div className="metric-label">This Month Paid</div>
          </div>
        </div>
        
        <div className="metric-card">
          <div className="metric-icon">
            <i className="fas fa-chart-line"></i>
          </div>
          <div className="metric-content">
            <div className="metric-number">{formatCurrency(getTotalAmount())}</div>
            <div className="metric-label">Visible Total</div>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="factoring-controls">
        <div className="search-container">
          <i className="fas fa-search search-icon"></i>
          <input
            type="text"
            placeholder="Search invoices..."
            className="factoring-search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="factoring-filters-container">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginRight: 8 }}>
            <button
              type="button"
              className={activeTab === 'invoices' ? 'btn small-cd' : 'btn small ghost-cd'}
              onClick={() => setActiveTab('invoices')}
              disabled={loading}
            >
              Invoices
            </button>
            <button
              type="button"
              className={activeTab === 'drafts' ? 'btn small-cd' : 'btn small ghost-cd'}
              onClick={() => setActiveTab('drafts')}
              disabled={loading}
            >
              Drafts ({draftInvoices.length})
            </button>
          </div>
          <select 
            className="filter-selected"
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            disabled={activeTab === 'drafts'}
          >
            <option>All Status</option>
            <option>Paid</option>
            <option>Sent</option>
            <option>Overdue</option>
          </select>
          <select 
            className="filter-selected"
            value={selectedFactoring}
            onChange={(e) => setSelectedFactoring(e.target.value)}
          >
            <option>All Factoring</option>
            <option>Yes</option>
            <option>No</option>
          </select>
          <button
            type="button"
            className="btn-filter"
            onClick={() => setShowFilterMenu(true)}
            aria-label="Filters"
            aria-expanded={showFilterMenu}
          >
            <i className="fas fa-filter"></i>
          </button>
          <button className="btn-refresh" onClick={refresh} disabled={loading}>
            <i className="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>

      {showFilterMenu ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fp-dark-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowFilterMenu(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 16,
            overflow: 'auto',
            zIndex: 90,
          }}
        >
          <div
            className="fp-dark-modal"
            style={{
              width: 'min(720px, 100%)',
              marginTop: 70,
              background: '#0b1220',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              borderRadius: 14,
              padding: 16,
              boxShadow: '0 10px 35px rgba(0,0,0,0.35)',
              maxHeight: 'calc(100vh - 32px)',
              overflow: 'auto',
              overflowX: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#e2e8f0' }}>Filters & Sort</div>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Sort results and filter by role.</div>
              </div>
              <button type="button" className="btn small ghost-cd" onClick={() => setShowFilterMenu(false)}>
                Close
              </button>
            </div>

            <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 13 }}>Sort by</span>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    style={{
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      borderRadius: 10,
                      padding: '10px 12px',
                    }}
                  >
                    <option value="created_at">Date created</option>
                    <option value="due_date">Due date</option>
                    <option value="amount">Amount</option>
                  </select>
                </label>

                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 13 }}>Direction</span>
                  <select
                    value={sortDir}
                    onChange={(e) => setSortDir(e.target.value)}
                    style={{
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      borderRadius: 10,
                      padding: '10px 12px',
                    }}
                  >
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                  </select>
                </label>
              </div>

              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 13 }}>Payer role</span>
                  <select
                    value={payerRoleFilter}
                    onChange={(e) => setPayerRoleFilter(e.target.value)}
                    style={{
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      borderRadius: 10,
                      padding: '10px 12px',
                    }}
                  >
                    <option value="all">All</option>
                    <option value="shipper">Shipper</option>
                    <option value="broker">Broker</option>
                    <option value="driver">Driver</option>
                    <option value="carrier">Carrier</option>
                  </select>
                </label>

                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 13 }}>Issuer role</span>
                  <select
                    value={issuerRoleFilter}
                    onChange={(e) => setIssuerRoleFilter(e.target.value)}
                    style={{
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      borderRadius: 10,
                      padding: '10px 12px',
                    }}
                  >
                    <option value="all">All</option>
                    <option value="carrier">Carrier</option>
                    <option value="driver">Driver</option>
                    <option value="shipper">Shipper</option>
                    <option value="broker">Broker</option>
                  </select>
                </label>
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn small ghost-cd"
                  onClick={() => {
                    setSortBy('created_at');
                    setSortDir('desc');
                    setPayerRoleFilter('all');
                    setIssuerRoleFilter('all');
                  }}
                >
                  Reset
                </button>
                <button type="button" className="btn small-cd" onClick={() => setShowFilterMenu(false)}>
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {loading && (
        <div style={{ padding: 12, color: '#64748b' }}>Loading invoices…</div>
      )}

      {/* Invoices Table */}
      <div className="invoices-table-container">
        <table className="invoices-table">
          <thead>
            <tr>
              <th>
                <input type="checkbox" className="select-all-checkbox" />
              </th>
              <th>Invoice #</th>
              <th>Load #</th>
              <th>Customer</th>
              <th>Amount</th>
              <th>Due Date</th>
              <th>Status</th>
              <th>Factoring</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <input type="checkbox" className="row-checkbox" />
                </td>
                <td className="invoice-id">{invoice.id}</td>
                <td className="load-id">{invoice.loadId}</td>
                <td className="customer-name">{invoice.customer}</td>
                <td className="amount">{formatCurrency(invoice.amount)}</td>
                <td className="due-date">{invoice.dueDate}</td>
                <td>
                  <span className={`cd-in-status-badge ${getStatusColor(invoice.status)}`}>
                    {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                  </span>
                </td>
                <td>
                  <span className={`factoring-badge ${invoice.factoring === 'yes' ? 'yes' : 'no'}`}>
                    {invoice.factoring === 'yes' ? 'Yes' : 'No'}
                  </span>
                </td>
                <td className="actions">
                  <button
                    className="btn-action view"
                    title="View"
                    onClick={() => setPreviewInvoice(invoice.raw)}
                  >
                    <i className="fas fa-eye"></i>
                  </button>

                  <button
                    className="btn-action download"
                    title="Export PDF"
                    onClick={async () => {
                      try {
                        const ctx = await getInvoicePdfContext(invoice.invoiceId);
                        downloadInvoicePdf(ctx);
                      } catch (e) {
                        // Fallback to minimal PDF if context fetch fails
                        try {
                          downloadInvoicePdf(invoice.raw);
                        } catch {
                          setError(e?.message || 'PDF export failed');
                        }
                      }
                    }}
                    disabled={loading}
                  >
                    <i className="fas fa-file-pdf"></i>
                  </button>

                  <button
                    className="btn-action download"
                    title="Download package ZIP"
                    onClick={() => handleDownloadPackage(invoice)}
                    disabled={loading}
                  >
                    <i className="fas fa-file-archive"></i>
                  </button>

                  {String(invoice.status || '') === 'disputed' ? (
                    <button
                      className="btn-action edit"
                      title="Resolve dispute"
                      onClick={() => handleResolveDispute(invoice)}
                      disabled={loading}
                    >
                      <i className="fas fa-check"></i>
                    </button>
                  ) : null}

                  <button
                    className="btn-action download"
                    title="Email (PDF attached)"
                    onClick={() => {
                      handleEmailWithPdf(invoice);
                    }}
                    disabled={loading}
                  >
                    <i className="fas fa-envelope"></i>
                  </button>

                  <button
                    className="btn-action download"
                    title="Copy invoice #"
                    onClick={async () => {
                      try {
                        await copyText(invoice.id);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    <i className="fas fa-copy"></i>
                  </button>

                  <button
                    className="btn-action download"
                    title="Save local draft copy"
                    onClick={() => {
                      try {
                        saveInvoiceDraftToLocal(invoice.raw);
                      } catch (e) {
                        setError(e?.message || 'Failed to save draft');
                      }
                    }}
                  >
                    <i className="fas fa-bookmark"></i>
                  </button>

                  {String(invoice.status || '') === 'draft' ? (
                    <button
                      className="btn-action edit"
                      title="Issue"
                      onClick={() => handleIssue(invoice.invoiceId)}
                      disabled={loading}
                    >
                      <i className="fas fa-stamp"></i>
                    </button>
                  ) : null}

                  <button
                    className="btn-action edit"
                    title="Send (Email + PDF)"
                    onClick={() => _openEmailModal(invoice)}
                    disabled={loading || String(invoice.status || '') !== 'issued'}
                  >
                    <i className="fas fa-paper-plane"></i>
                  </button>

                  <button
                    className="btn-action download"
                    title="Void"
                    onClick={() => handleVoid(invoice.invoiceId)}
                    disabled={loading || !['draft', 'issued'].includes(String(invoice.status || ''))}
                  >
                    <i className="fas fa-ban"></i>
                  </button>

                  <button
                    className="btn-action download"
                    title="Submit to factoring"
                    onClick={() => handleSubmitFactoring(invoice.invoiceId)}
                    disabled={true}
                  >
                    <i className="fas fa-bolt"></i>
                  </button>
                  <button
                    className="btn-action download"
                    title="Record payment"
                    onClick={() => handleRecordPayment(invoice.invoiceId)}
                    disabled={loading}
                  >
                    <i className="fas fa-dollar-sign"></i>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showEmailModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fp-dark-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) _closeEmailModal();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 16,
            overflow: 'auto',
            zIndex: 70,
          }}
        >
          <div
            className="fp-dark-modal"
            style={{
              width: 'min(860px, 100%)',
              background: '#0b1220',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              borderRadius: 14,
              padding: 16,
              boxShadow: '0 10px 35px rgba(0,0,0,0.35)',
              maxHeight: 'calc(100vh - 32px)',
              overflow: 'auto',
              overflowX: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#e2e8f0' }}>Email Invoice</div>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Sends via backend SMTP with a PDF attached.</div>
              </div>
              <button type="button" className="btn small ghost-cd" onClick={_closeEmailModal} disabled={emailSending}>
                Close
              </button>
            </div>

            <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: '#cbd5e1', fontSize: 13 }}>To</span>
                <input
                  value={emailForm.to}
                  onChange={(e) => setEmailForm((f) => ({ ...f, to: e.target.value }))}
                  placeholder="ap@customer.com"
                  style={{
                    background: '#0f172a',
                    color: '#e2e8f0',
                    border: '1px solid rgba(148, 163, 184, 0.22)',
                    borderRadius: 10,
                    padding: '10px 12px',
                  }}
                />
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: '#cbd5e1', fontSize: 13 }}>Subject</span>
                <input
                  value={emailForm.subject}
                  onChange={(e) => setEmailForm((f) => ({ ...f, subject: e.target.value }))}
                  placeholder="Invoice from FreightPower"
                  style={{
                    background: '#0f172a',
                    color: '#e2e8f0',
                    border: '1px solid rgba(148, 163, 184, 0.22)',
                    borderRadius: 10,
                    padding: '10px 12px',
                  }}
                />
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: '#cbd5e1', fontSize: 13 }}>Message</span>
                <textarea
                  value={emailForm.body}
                  onChange={(e) => setEmailForm((f) => ({ ...f, body: e.target.value }))}
                  rows={7}
                  style={{
                    background: '#0f172a',
                    color: '#e2e8f0',
                    border: '1px solid rgba(148, 163, 184, 0.22)',
                    borderRadius: 10,
                    padding: '10px 12px',
                    resize: 'vertical',
                  }}
                />
              </label>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button type="button" className="btn small ghost-cd" onClick={_closeEmailModal} disabled={emailSending}>
                  Cancel
                </button>
                <button type="button" className="btn small-cd" onClick={handleSendEmail} disabled={emailSending} style={{ color: '#fff' }}>
                  {emailSending ? 'Sending…' : 'Send Email'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {previewInvoice ? (
        <InvoicePreview
          invoice={previewInvoice}
          onClose={() => setPreviewInvoice(null)}
          onDownloadPdf={async () => {
            try {
              const invoiceId = previewInvoice?.invoice_id;
              if (invoiceId) {
                const ctx = await getInvoicePdfContext(invoiceId);
                downloadInvoicePdf(ctx);
                return;
              }
              downloadInvoicePdf(previewInvoice);
            } catch (e) {
              setError(e?.message || 'PDF export failed');
            }
          }}
          onDownloadPackage={async () => {
            const row = _rowFromRawInvoice(previewInvoice);
            if (!row) return;
            await handleDownloadPackage(row);
          }}
          onShare={async () => {
            try {
              const invNum = previewInvoice?.invoice_number || previewInvoice?.invoice_id || '';
              const invId = previewInvoice?.invoice_id || '';
              await copyText(`Invoice ${invNum} (${invId})`);
            } catch {
              // ignore
            }
          }}
          onResend={() => {
            const row = _rowFromRawInvoice(previewInvoice);
            if (row) _openEmailModal(row);
          }}
          onResolveDispute={async () => {
            const row = _rowFromRawInvoice(previewInvoice);
            if (!row) return;
            await handleResolveDispute(row);
          }}
          onSubmitFactoring={() => setError('Factoring is coming soon (placeholder).')}
          onSaveToVault={() => setError('Save to Vault is coming soon (placeholder).')}
          onSaveNote={() => setError('Notes saving is coming soon (placeholder).')}
        />
      ) : null}

      {/* Table Footer */}
      <div className="table-footer">
        <div className="table-info">
          <span>Showing 1-3 of {tabRows.length} invoices</span>
        </div>
        <div className="pagination">
          <button className="btn-page prev" disabled>Pre</button>
          <button className="btn-page active">1</button>
          <button className="btn-page">2</button>
          <button className="btn-page next">Next</button>
        </div>
      </div>

      {/* Cash Forecast Section */}
      <div className="cash-forecast">
        <h3>Cash Forecast - Next 30 Days</h3>
        <div className="forecast-metrics">
          <div className="forecast-item">
            <div className="forecast-label">Expected Direct Payments</div>
            <div className="forecast-amount green">{formatCurrency(forecast?.expected_direct_payments || 0)}</div>
          </div>
          <div className="forecast-item">
            <div className="forecast-label">Factoring Advances</div>
            <div className="forecast-amount blue">{formatCurrency(forecast?.expected_factoring_advances || 0)}</div>
          </div>
          <div className="forecast-item">
            <div className="forecast-label">Overdue Collections</div>
            <div className="forecast-amount red">{formatCurrency(forecast?.overdue_collections || 0)}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FactoringInvoicing;