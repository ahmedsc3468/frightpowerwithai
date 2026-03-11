import React, { useEffect, useMemo, useState } from 'react';
import '../../styles/shipper/Finance.css';
import RateConfirmationPanel from './RateConfirmationPanel';
import InvoicePreview from './InvoicePreview';
import { disputeInvoice, downloadInvoicePackageZip, getFinanceSummary, getInvoicePdfContext, listInvoices, recordInvoicePayment } from '../../api/finance';
import { useAuth } from '../../contexts/AuthContext';
import { downloadInvoicePdf, openInvoiceMailto } from '../../utils/invoiceActions';

export default function Finance() {
  const { currentUser, userRole } = useAuth();

  const [selectedRange, setSelectedRange] = useState('30 Days');
  const [selectedPartner, setSelectedPartner] = useState('All Partners');
  const [selectedStatus, setSelectedStatus] = useState('All Status');

  const ranges = ['7 Days', '30 Days', '90 Days', 'Year to Date'];
  const partners = ['All Partners', 'Atlas Freight', 'Prime Logistics', 'Apex'];
  const statuses = ['All Status', 'Paid', 'Pending', 'Overdue', 'Disputed'];

  const [activeTab, setActiveTab] = useState('Overview');
  const tabs = ['Overview', 'Invoices', 'Payments', 'Factoring'];
  const [showRatePanel, setShowRatePanel] = useState(false);
  const [activeFactoringAgent, setActiveFactoringAgent] = useState('Apex Financial');

  const [financeLoading, setFinanceLoading] = useState(true);
  const [financeError, setFinanceError] = useState('');
  const [invoiceList, setInvoiceList] = useState([]);
  const [summary, setSummary] = useState(null);

  const [previewInvoice, setPreviewInvoice] = useState(null);

  const [disputeModal, setDisputeModal] = useState({ open: false, invoiceId: '', reason: '' });
  const [paymentModal, setPaymentModal] = useState({ open: false, invoiceId: '', amount: '' });
  const [modalError, setModalError] = useState('');

  const factoringAgents = [
    {
      name: 'Apex Financial',
      email: 'ops@apexfinancial.com',
      phone: '(888) 555-0142',
      response: 'Avg response: 15 min',
      status: 'Active',
    },
    {
      name: 'TrueRate Capital',
      email: 'support@trueratecapital.com',
      phone: '(877) 555-0135',
      response: 'Avg response: 25 min',
      status: 'Active',
    },
    {
      name: 'QuickPay Freight',
      email: 'agents@quickpayfreight.com',
      phone: '(866) 555-0187',
      response: 'Avg response: 35 min',
      status: 'Available',
    },
  ];

  const getInvoiceId = (inv) => {
    const id = inv?.invoice_id || inv?.invoiceId || inv?.id || inv?.invoice_number;
    return id ? String(id) : '';
  };

  const roleLower = String(userRole || '').toLowerCase();
  const currentUid = currentUser?.uid || '';

  const formatCurrency = (amount) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(amount || 0));

  const formatDate = (tsSeconds) => {
    if (!tsSeconds) return '—';
    try {
      return new Date(Number(tsSeconds) * 1000).toLocaleDateString();
    } catch {
      return '—';
    }
  };

  const refresh = async () => {
    setFinanceLoading(true);
    setFinanceError('');
    try {
      const [invRes, sumRes] = await Promise.all([
        listInvoices({ limit: 250 }),
        getFinanceSummary(),
      ]);
      setInvoiceList(invRes?.invoices || []);
      setSummary(sumRes || null);
    } catch (e) {
      setFinanceError(e?.message || 'Failed to load finance data');
    } finally {
      setFinanceLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleRecordPayment = async (invoiceId, amountRaw) => {
    if (!invoiceId) {
      setFinanceError('Missing invoice id; cannot record payment. Please refresh.');
      return;
    }
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Invalid payment amount');
    }
    await recordInvoicePayment(invoiceId, { amount, currency: 'USD', method: 'other' });
  };

  const receivedInvoices = useMemo(() => {
    const list = invoiceList || [];

    // Shippers: backend already scopes to payer_uid.
    // Brokers: backend returns issuer+payer invoices; we only want payer-side received invoices.
    if (roleLower === 'broker' && currentUid) {
      return list.filter((inv) => String(inv?.payer_uid || '') === String(currentUid));
    }
    return list;
  }, [invoiceList, roleLower, currentUid]);

  const visibleInvoicesByStatus = useMemo(() => {
    return (receivedInvoices || []).filter((inv) => {
      const s = String(inv?.status || '').toLowerCase();
      const bucket = s === 'paid' ? 'Paid' : s === 'overdue' ? 'Overdue' : s === 'disputed' ? 'Disputed' : 'Pending';
      return selectedStatus === 'All Status' || bucket === selectedStatus;
    });
  }, [receivedInvoices, selectedStatus]);

  const handleDispute = async (invoiceId, reasonRaw) => {
    if (!invoiceId) {
      setFinanceError('Missing invoice id; cannot dispute. Please refresh.');
      return;
    }
    const reason = String(reasonRaw || '').trim();
    if (!reason) {
      throw new Error('Dispute reason is required');
    }
    await disputeInvoice(invoiceId, { reason });
  };

  const _actionBtnStyle = { marginRight: 8, pointerEvents: 'auto', position: 'relative', zIndex: 2 };

  const handleDownloadPackage = async (inv) => {
    const invoiceId = inv?.invoice_id;
    if (!invoiceId) return;
    setFinanceError('');
    try {
      const blob = await downloadInvoicePackageZip(invoiceId);
      const filename = `${inv?.invoice_number || invoiceId}_package.zip`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setFinanceError(e?.message || 'Failed to download invoice package');
    }
  };

  const receivedTotal = useMemo(() => {
    return (receivedInvoices || []).reduce((sum, inv) => sum + Number(inv?.amount_total || 0), 0);
  }, [receivedInvoices]);

  const overdueCount = useMemo(() => {
    return (receivedInvoices || []).filter((inv) => String(inv?.status || '').toLowerCase() === 'overdue').length;
  }, [receivedInvoices]);

  return (
    <div className="finance-root">
      {showRatePanel ? (
        <RateConfirmationPanel onClose={() => setShowRatePanel(false)} />
      ) : null}

      {previewInvoice ? (
        <InvoicePreview
          invoice={previewInvoice}
          onClose={() => setPreviewInvoice(null)}
          onShare={() => {
            try {
              openInvoiceMailto(previewInvoice);
            } catch (e) {
              setFinanceError(e?.message || 'Email action failed');
            }
          }}
          onDownloadPdf={async () => {
            try {
              const ctx = await getInvoicePdfContext(previewInvoice?.invoice_id);
              downloadInvoicePdf(ctx);
            } catch (e) {
              try {
                downloadInvoicePdf(previewInvoice);
              } catch {
                setFinanceError(e?.message || 'PDF export failed');
              }
            }
          }}
          onDownloadPackage={() => handleDownloadPackage(previewInvoice)}
          onDispute={() => handleDispute(previewInvoice?.invoice_id)}
        />
      ) : null}

      {disputeModal.open ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1400, padding: 16 }}
          onClick={() => {
            setDisputeModal({ open: false, invoiceId: '', reason: '' });
            setModalError('');
          }}
        >
          <div
            style={{ width: 'min(520px, 100%)', background: '#0b1220', border: '1px solid rgba(148,163,184,0.18)', borderRadius: 12, padding: 16, color: '#e2e8f0' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 800 }}>Dispute Invoice</div>
              <button
                type="button"
                className="btn small ghost-cd"
                onClick={() => {
                  setDisputeModal({ open: false, invoiceId: '', reason: '' });
                  setModalError('');
                }}
              >
                Close
              </button>
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>Invoice: {disputeModal.invoiceId || '—'}</div>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: '#cbd5e1' }}>Reason (required)</label>
            <textarea
              value={disputeModal.reason}
              onChange={(e) => setDisputeModal((m) => ({ ...m, reason: e.target.value }))}
              rows={4}
              style={{ width: '100%', borderRadius: 10, border: '1px solid rgba(148,163,184,0.22)', background: 'rgba(15,23,42,0.65)', color: '#e2e8f0', padding: 10, resize: 'vertical' }}
              placeholder="e.g., Amount mismatch / missing documents / incorrect accessorial"
            />
            {modalError ? (
              <div style={{ marginTop: 10, background: 'rgba(239, 68, 68, 0.12)', color: '#fecaca', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                {modalError}
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                className="btn small-cd"
                onClick={async () => {
                  setModalError('');
                  setFinanceError('');
                  try {
                    await handleDispute(disputeModal.invoiceId, disputeModal.reason);
                    setDisputeModal({ open: false, invoiceId: '', reason: '' });
                    await refresh();
                  } catch (e) {
                    setModalError(e?.message || 'Failed to dispute invoice');
                  }
                }}
              >
                Submit Dispute
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {paymentModal.open ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1400, padding: 16 }}
          onClick={() => {
            setPaymentModal({ open: false, invoiceId: '', amount: '' });
            setModalError('');
          }}
        >
          <div
            style={{ width: 'min(520px, 100%)', background: '#0b1220', border: '1px solid rgba(148,163,184,0.18)', borderRadius: 12, padding: 16, color: '#e2e8f0' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 800 }}>Record Payment</div>
              <button
                type="button"
                className="btn small ghost-cd"
                onClick={() => {
                  setPaymentModal({ open: false, invoiceId: '', amount: '' });
                  setModalError('');
                }}
              >
                Close
              </button>
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>Invoice: {paymentModal.invoiceId || '—'}</div>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: '#cbd5e1' }}>Amount (USD)</label>
            <input
              value={paymentModal.amount}
              onChange={(e) => setPaymentModal((m) => ({ ...m, amount: e.target.value }))}
              inputMode="decimal"
              placeholder="e.g., 1250.00"
              style={{ width: '100%', borderRadius: 10, border: '1px solid rgba(148,163,184,0.22)', background: 'rgba(15,23,42,0.65)', color: '#e2e8f0', padding: 10 }}
            />
            {modalError ? (
              <div style={{ marginTop: 10, background: 'rgba(239, 68, 68, 0.12)', color: '#fecaca', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                {modalError}
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                className="btn small-cd"
                onClick={async () => {
                  setModalError('');
                  setFinanceError('');
                  try {
                    await handleRecordPayment(paymentModal.invoiceId, paymentModal.amount);
                    setPaymentModal({ open: false, invoiceId: '', amount: '' });
                    await refresh();
                  } catch (e) {
                    setModalError(e?.message || 'Failed to record payment');
                  }
                }}
              >
                Record
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <header className="fp-header">
        <div className="fp-header-titles">
          <h2>Finance</h2>
          <div className="muted" style={{ marginTop: 4 }}>
            {roleLower === 'broker' ? 'Broker' : 'Shipper'} · Received invoices
          </div>
        </div>
      </header>

      {/* Controls row */}
      <div className="dv-top-row">
        <div className="dv-controls">
          <div className="dv-search">
            <input placeholder="Search invoices" disabled />
          </div>
          <select
            className="sb-carrier-filter-select"
            value={selectedPartner}
            onChange={(e) => setSelectedPartner(e.target.value)}
          >
            {partners.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            className="sb-carrier-filter-select"
            value={selectedRange}
            onChange={(e) => setSelectedRange(e.target.value)}
          >
            {ranges.map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            className="sb-carrier-filter-select"
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
          >
            {statuses.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <section className="finance-top-cards">
        <div className="card finance-card">
          <div className="card-icon"><i className="fa-solid fa-dollar-sign"></i></div>
          <div>
            <div className="muted">Total Received Invoices</div>
            <div className="finance-num">{formatCurrency(receivedTotal)}</div>
          </div>
        </div>
        <div className="card finance-card">
          <div className="card-icon"><i className="fa-solid fa-clock"></i></div>
          <div>
            <div className="muted">Pending Invoices</div>
            <div className="finance-num">{formatCurrency(summary?.outstanding_amount || 0)}</div>
          </div>
        </div>
        <div className="card finance-card">
          <div className="card-icon"><i className="fa-solid fa-coins"></i></div>
          <div>
            <div className="muted">Factoring (Seller-side)</div>
            <div className="finance-num">{formatCurrency(summary?.factoring_outstanding_amount || 0)}</div>
          </div>
        </div>
        <div className="card finance-card">
          <div className="card-icon"><i className="fa-solid fa-triangle-exclamation"></i></div>
          <div>
            <div className="muted">Overdue Invoices</div>
            <div className="finance-num">{overdueCount}</div>
          </div>
        </div>
        <div className="card finance-card">
          <div className="card-icon"><i className="fa-solid fa-chart-line"></i></div>
          <div>
            <div className="muted">Cash Flow Trend</div>
            <div className="finance-num green">+7.2%</div>
          </div>
        </div>
      </section>

      {financeError && (
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: 10, marginBottom: 16 }}>
          {financeError}
        </div>
      )}

      <nav className="tabs" role="tablist" aria-label="Finance navigation" style={{marginBottom: '20px'}}>
        {tabs.map(t => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={activeTab === t}
            tabIndex={0}
            className={`tab ${activeTab === t ? 'active' : ''}`}
            onClick={() => setActiveTab(t)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(t); } }}
          >
            {t}
          </button>
        ))}
      </nav>

      {activeTab === 'Overview' ? (
        <div className="finance-main">
          <div className="finance-left">
            <div className="card recent-activity-card" style={{ padding: 16 }}>
              <h3>Overview</h3>
              <div className="muted" style={{ marginTop: 8 }}>
                Use the Invoices tab to review and record payments.
              </div>
              <div style={{ marginTop: 12 }}>
                <button className="btn small-cd" onClick={() => setActiveTab('Invoices')}>Go to Invoices</button>
                <button className="btn ghost-cd small" style={{ marginLeft: 10 }} onClick={refresh} disabled={financeLoading}>Refresh</button>
              </div>
            </div>
          </div>

          <aside className="finance-right">
            <div className="card quick-actions">
              <h4>Quick Actions</h4>
              <button className="btn small-cd" style={{width:'100%',marginBottom:12}} onClick={refresh} disabled={financeLoading}>
                Refresh
              </button>
              <button className="btn ghost-cd small" style={{width:'100%',marginBottom:8}} onClick={() => setActiveTab('Invoices')}>
                Generate Rate Confirmation
              </button>
              <button
                className="btn ghost-cd small"
                style={{width:'100%',marginBottom:8}}
                onClick={() => {
                  setActiveFactoringAgent('Apex Financial');
                  setActiveTab('Factoring');
                }}
              >
                Send Payment Reminder
              </button>
            </div>
          </aside>
        </div>
      ) : activeTab === 'Invoices' ? (
        <div className="finance-left">
          <div className="invoices-alert">
            <div className="muted">Invoices received from carriers for your loads.</div>
            <button className="btn small-cd" onClick={refresh} disabled={financeLoading}>Refresh</button>
          </div>
          <div className="card invoices-card">
            <div className="table-wrap">
              <table className="invoices-table">
                <thead>
                  <tr className="headings-table-finance">
                    <th><input type="checkbox"/></th>
                    <th>INVOICE #</th>
                    <th>LOAD #</th>
                    <th>FROM</th>
                    <th>AMOUNT</th>
                    <th>STATUS</th>
                    <th>DUE DATE</th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {financeLoading ? (
                    <tr className="invoices-row">
                      <td className="cell" colSpan={8} style={{ padding: 16, color: '#64748b' }}>Loading invoices…</td>
                    </tr>
                  ) : (visibleInvoicesByStatus || []).length === 0 ? (
                    <tr className="invoices-row">
                      <td className="cell" colSpan={8} style={{ padding: 16, color: '#64748b' }}>No received invoices found.</td>
                    </tr>
                  ) : (
                    (visibleInvoicesByStatus || []).map((inv) => {
                      const from = inv?.issuer_role
                        ? `${inv.issuer_role} (${String(inv?.issuer_uid || '').slice(0, 8)}…)`
                        : (String(inv?.issuer_uid || '').slice(0, 8) || '—');
                      const statusLower = String(inv?.status || '').toLowerCase();
                      const status =
                        statusLower === 'paid'
                          ? 'Paid'
                          : statusLower === 'overdue'
                            ? 'Overdue'
                            : statusLower === 'disputed'
                              ? 'Disputed'
                              : statusLower === 'void'
                                ? 'Void'
                                : 'Pending';
                      const canRecordPayment = !['paid', 'void', 'disputed'].includes(statusLower);
                      const canDispute = !['paid', 'void', 'disputed'].includes(statusLower);

                      const invoiceKey = inv?.invoice_id || inv?.invoice_number || Math.random().toString(36);

                      return (
                        <tr key={invoiceKey} className="invoices-row">
                          <td className="cell"><input type="checkbox"/></td>
                          <td className="cell strong">{inv?.invoice_number || inv?.invoice_id || '—'}</td>
                          <td className="cell">{inv?.load_number || inv?.load_id || '—'}</td>
                          <td className="cell">{from}</td>
                          <td className="cell">{formatCurrency(inv?.amount_total || 0)}</td>
                          <td className="cell">
                            {status === 'Paid' && <span className="int-status-badge active">Paid</span>}
                            {status === 'Pending' && <span className="int-status-badge pending">Pending</span>}
                            {status === 'Overdue' && <span className="int-status-badge revoked">Overdue</span>}
                            {status === 'Disputed' && <span className="int-status-badge blue">Disputed</span>}
                            {status === 'Void' && <span className="int-status-badge revoked">Void</span>}
                          </td>
                          <td className="cell">{formatDate(inv?.due_date)}</td>
                          <td className="cell">
                            <button
                              type="button"
                              className="btn small ghost-cd"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setPreviewInvoice(inv);
                              }}
                              disabled={financeLoading}
                              style={_actionBtnStyle}
                            >
                              View
                            </button>

                            <button
                              type="button"
                              className="btn small ghost-cd"
                              onClick={async () => {
                                try {
                                  const ctx = await getInvoicePdfContext(getInvoiceId(inv));
                                  downloadInvoicePdf(ctx);
                                } catch (e) {
                                  try {
                                    downloadInvoicePdf(inv);
                                  } catch {
                                    setFinanceError(e?.message || 'PDF export failed');
                                  }
                                }
                              }}
                              disabled={financeLoading}
                              style={_actionBtnStyle}
                            >
                              Export PDF
                            </button>

                            <button
                              type="button"
                              className="btn small ghost-cd"
                              onClick={() => {
                                try {
                                  openInvoiceMailto(inv);
                                } catch (e) {
                                  setFinanceError(e?.message || 'Email action failed');
                                }
                              }}
                              disabled={financeLoading}
                              style={_actionBtnStyle}
                            >
                              Email
                            </button>

                            <button
                              type="button"
                              className="btn small ghost-cd"
                              onClick={() => handleDownloadPackage(inv)}
                              disabled={financeLoading}
                              style={_actionBtnStyle}
                            >
                              Package ZIP
                            </button>

                            <button
                              type="button"
                              className="btn small ghost-cd"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setModalError('');
                                setFinanceError('');

                                if (!canDispute) {
                                  setFinanceError(`This invoice cannot be disputed (status: ${statusLower || 'unknown'}).`);
                                  return;
                                }

                                setDisputeModal({ open: true, invoiceId: getInvoiceId(inv), reason: '' });
                              }}
                              disabled={financeLoading}
                              style={_actionBtnStyle}
                            >
                              Dispute
                            </button>

                            <button
                              type="button"
                              className="btn small ghost-cd"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setModalError('');
                                setFinanceError('');

                                if (!canRecordPayment) {
                                  setFinanceError(`This invoice cannot record a payment (status: ${statusLower || 'unknown'}).`);
                                  return;
                                }

                                setPaymentModal({ open: true, invoiceId: getInvoiceId(inv), amount: '' });
                              }}
                              disabled={financeLoading}
                              style={_actionBtnStyle}
                            >
                              Record Payment
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="invoices-footer">
              <div className="muted">Showing {Math.min(visibleInvoicesByStatus.length, 250)} of {visibleInvoicesByStatus.length} results</div>
              <div className="pagination-buttons">
                <button className="btn-num" disabled>Pre</button>
                <button className="btn-num-active">1</button>
                <button className="btn-num" disabled>Next</button>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === 'Factoring' ? (
        <div className="finance-left">
          <div className="card invoices-card" style={{ padding: 16 }}>
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>Factoring Agents</h3>
            <div className="muted" style={{ marginBottom: 12 }}>
              Select an agent to send a payment reminder and coordinate invoice follow-up.
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {factoringAgents.map((agent) => {
                const isActive = activeFactoringAgent === agent.name;
                return (
                  <div
                    key={agent.name}
                    style={{
                      border: isActive ? '2px solid #3B57A7' : '1px solid #e5e7eb',
                      background: isActive ? 'rgba(59, 87, 167, 0.08)' : '#fff',
                      borderRadius: 10,
                      padding: 12,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{agent.name}</div>
                      <div className="muted" style={{ fontSize: 13 }}>{agent.email} · {agent.phone}</div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{agent.response}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`int-status-badge ${agent.status === 'Active' ? 'active' : 'pending'}`}>{agent.status}</span>
                      <button
                        className="btn small ghost-cd"
                        type="button"
                        onClick={() => setActiveFactoringAgent(agent.name)}
                      >
                        {isActive ? 'Active' : 'Set Active'}
                      </button>
                      <button
                        className="btn small-cd"
                        type="button"
                        onClick={() => {
                          window.location.href = `mailto:${agent.email}?subject=${encodeURIComponent('Payment Reminder')}&body=${encodeURIComponent('Hello, please provide an update on outstanding payment processing for our pending invoices.')}`;
                        }}
                      >
                        Send Reminder
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="finance-left">
          <div className="card invoices-card" style={{ padding: 16 }}>
            <div className="muted">This section is coming soon.</div>
          </div>
        </div>
      )}
    </div>
  );
}
