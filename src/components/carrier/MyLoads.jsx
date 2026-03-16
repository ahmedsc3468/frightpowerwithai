import React, { useState, useEffect, useMemo } from 'react';
import '../../styles/carrier/MyLoads.css';
import AddLoads from './AddLoads';
import LoadDetailsModal from './LoadDetailsModal';
import { API_URL } from '../../config';
import { auth } from '../../firebase';
import { useTr } from '../../i18n/useTr';

const LOAD_COLUMN_KEYS = ['draft', 'tendered', 'accepted', 'inTransit', 'delivered', 'pod', 'invoiced', 'settled'];

function matchesLoadSearch(load, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystack = [
    load?.id,
    load?.origin,
    load?.destination,
    load?.status,
    load?.statusLabel,
    load?.driver,
    load?.equipment,
    load?.pickup,
    load?.invoice,
    load?.broker,
    load?.priceAmount,
    load?.fullData?.reference_number,
    load?.fullData?.commodity,
    load?.fullData?.load_type,
    load?.fullData?.equipment_type,
    load?.fullData?.assigned_driver_name,
    load?.fullData?.workflow_status,
    load?.fullData?.workflow_status_text,
    load?.fullData?.status,
    load?.fullData?.load_status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

// Modal to display all loads in a grid
function LoadsModal({ title, items, onClose, onLoadClick, tr, fmtMoney }) {
  return (
    <div className="loads-modal-overlay" onClick={onClose}>
      <div className="loads-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="loads-modal-header">
          <h3>{title}</h3>
          <button className="loads-modal-close" onClick={onClose}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div className="loads-modal-grid">
          {items.length === 0 ? (
            <div style={{padding: '40px', textAlign: 'center', color: '#9ca3af', gridColumn: '1 / -1'}}>
              {tr('myLoads.empty.noLoadsAvailable', 'No loads available')}
            </div>
          ) : (
            items.map((it) => (
              <div
                className="loads-modal-card"
                key={it.id}
                role="button"
                tabIndex={0}
                onClick={() => onLoadClick && onLoadClick(it)}
                onKeyDown={(e) => {
                  if (!onLoadClick) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onLoadClick(it);
                  }
                }}
              >
                <div className="ml-card-top">
                  <div className="ml-id">{it.id}</div>
                  <div className="ml-tag">{it.statusLabel}</div>
                </div>
                <div className="ml-card-body">
                  <div className="ml-route"><span className="ml-dot green" />{it.origin}</div>
                  <div className="ml-route"><span className="ml-dot red" />{it.destination}</div>
                  
                  {it.equipment && (
                    <div className="ml-broker">
                      {it.equipment} • {it.weight ? `${it.weight} ${tr('common.lbs', 'lbs')}` : tr('common.na', 'N/A')}
                    </div>
                  )}

                  {it.driver && (
                    <div className="ml-driver-row">
                      <div className="muted">{tr('common.driver', 'Driver')}: {it.driver}</div>
                      <div className="ml-price">{it.priceAmount != null ? fmtMoney(it.priceAmount) : tr('common.na', 'N/A')}</div>
                    </div>
                  )}

                  {it.invoice && <div className="muted">{tr('common.invoice', 'Invoice')}: {it.invoice}</div>}

                  {it.pickup && (
                    <div className="ml-pickup-row">
                      <div className="ml-pickup muted">{tr('common.pickup', 'Pickup')}: {it.pickup}</div>
                      <div className="ml-price">{it.priceAmount != null ? fmtMoney(it.priceAmount) : tr('common.na', 'N/A')}</div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Column({ columnKey, title, items, isLoading, onCardClick, tr, fmtMoney }) {
  const isTender = columnKey === 'tendered';
  const isAccepted = columnKey === 'accepted';
  const isInTransit = columnKey === 'inTransit';
  const isDelivered = columnKey === 'delivered';
  const isPod = columnKey === 'pod';
  const isInvoiced = columnKey === 'invoiced';
  const isSettled = columnKey === 'settled';
  const isDraft = columnKey === 'draft';
  
  // Show only the first load in the card
  const displayItem = items.length > 0 ? items[0] : null;
  const hasMore = items.length > 1;
  
  return (
    <div 
      className={`ml-column ${isTender ? 'tender-column' : ''} ${isAccepted ? 'accepted-column' : ''} ${isInTransit ? 'in-transit-column' : ''} ${isDelivered ? 'delivered-column' : ''} ${isPod ? 'pod-column' : ''} ${isInvoiced ? 'invoiced-column' : ''} ${isSettled ? 'settled-column' : ''} ${isDraft ? 'draft-column' : ''}`}
      onClick={() => items.length > 0 && onCardClick && onCardClick()}
      style={{ cursor: items.length > 0 ? 'pointer' : 'default' }}
    >
      <div className="ml-column-inner">
        <div className="ml-column-header">
          <h4>{title}</h4>
          <span className="ml-count">{items.length}</span>
        </div>
        <div className="ml-column-list">
          {isLoading ? (
            <div style={{padding: '20px', textAlign: 'center', color: '#6b7280'}}>{tr('common.loading', 'Loading…')}</div>
          ) : !displayItem ? (
            <div style={{padding: '20px', textAlign: 'center', color: '#9ca3af'}}>{tr('myLoads.empty.noLoads', 'No loads')}</div>
          ) : (
            <>
              <div 
                className={`ml-card ${isTender ? 'tender-card' : ''} ${isAccepted ? 'accepted-card' : ''} ${isInTransit ? 'in-transit-card' : ''} ${isDelivered ? 'delivered-card' : ''} ${isPod ? 'pod-card' : ''} ${isInvoiced ? 'invoiced-card' : ''} ${isSettled ? 'settled-card' : ''} ${isDraft ? 'draft-card' : ''}`} 
                role="article"
              >
                <div className="ml-card-top">
                  <div className="ml-id">{displayItem.id}</div>
                  <div className="ml-tag">{displayItem.statusLabel}</div>
                </div>
                <div className="ml-card-body">
                  <div className="ml-route"><span className="ml-dot green" />{displayItem.origin}</div>
                  <div className="ml-route"><span className="ml-dot red" />{displayItem.destination}</div>
                  
                  {displayItem.equipment && (
                    <div className="ml-broker">
                      {displayItem.equipment} • {displayItem.weight ? `${displayItem.weight} ${tr('common.lbs', 'lbs')}` : tr('common.na', 'N/A')}
                    </div>
                  )}

                  {!isTender && displayItem.driver && (
                    <div className="ml-driver-row">
                      <div className="muted">{tr('common.driver', 'Driver')}: {displayItem.driver}</div>
                      <div className="ml-price">{displayItem.priceAmount != null ? fmtMoney(displayItem.priceAmount) : tr('common.na', 'N/A')}</div>
                    </div>
                  )}

                  {displayItem.invoice && <div className="muted">{tr('common.invoice', 'Invoice')}: {displayItem.invoice}</div>}

                  {isTender && displayItem.pickup && (
                    <div className="ml-pickup-row">
                      <div className="ml-pickup muted">{tr('common.pickup', 'Pickup')}: {displayItem.pickup}</div>
                      <div className="ml-price">{displayItem.priceAmount != null ? fmtMoney(displayItem.priceAmount) : tr('common.na', 'N/A')}</div>
                    </div>
                  )}
                </div>
              </div>
              {hasMore && (
                <div className="ml-view-more">
                  {tr('myLoads.actions.clickToViewAllPrefix', 'Click to view all')} {items.length} {tr('common.loads', 'loads')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MyLoads() {
  const { language, tr } = useTr();
  const locale = language === 'Spanish' ? 'es-ES' : language === 'Arabic' ? 'ar' : 'en-US';
  const fmtMoney = (amt) => {
    const n = Number(amt || 0);
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  };

  const [showAddLoads, setShowAddLoads] = useState(false);
  const [resumeLoad, setResumeLoad] = useState(null); // For resuming draft loads
  const [detailsLoad, setDetailsLoad] = useState(null); // For viewing load details from modal cards
  const [searchTerm, setSearchTerm] = useState('');
  const [loads, setLoads] = useState({
    draft: [],
    tendered: [],
    accepted: [],
    inTransit: [],
    delivered: [],
    pod: [],
    invoiced: [],
    settled: []
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(null); // Track which modal is open

  const COLUMN_DEFS = [
    { key: 'tendered', title: tr('myLoads.columns.tendered', 'Tendered') },
    { key: 'accepted', title: tr('myLoads.columns.accepted', 'Accepted') },
    { key: 'inTransit', title: tr('myLoads.columns.inTransit', 'In Transit') },
    { key: 'delivered', title: tr('myLoads.columns.delivered', 'Delivered') },
    { key: 'pod', title: tr('myLoads.columns.pod', 'POD') },
    { key: 'invoiced', title: tr('myLoads.columns.invoiced', 'Invoiced') },
  ];

  const filteredLoads = useMemo(() => {
    return LOAD_COLUMN_KEYS.reduce((accumulator, columnKey) => {
      accumulator[columnKey] = (loads[columnKey] || []).filter((load) => matchesLoadSearch(load, searchTerm));
      return accumulator;
    }, {});
  }, [loads, searchTerm]);

  // Fetch loads from backend
  useEffect(() => {
    fetchLoads();
  }, []);

  const fetchLoads = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const user = auth.currentUser;
      if (!user) {
        throw new Error(tr('auth.notAuthenticated', 'Not authenticated'));
      }
      
      const token = await user.getIdToken();
      const response = await fetch(`${API_URL}/loads?page_size=200&exclude_drafts=false`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(tr('myLoads.errors.fetchFailed', 'Failed to fetch loads'));
      }

      const data = await response.json();
      
      // Group loads by status into columns
      const grouped = {
        draft: [],
        tendered: [],
        accepted: [],
        inTransit: [],
        delivered: [],
        pod: [],
        invoiced: [],
        settled: []
      };

      data.loads.forEach(load => {
        // Prefer workflow_status for lifecycle columns (POD / Invoiced), fallback to status.
        let statusFlag = 'unassigned';
        let column = 'tendered'; // default

        const status = String(load.status || load.load_status || '').toLowerCase().trim();
        const workflowRaw = String(load.workflow_status || load.workflowStatus || load.workflow_status_text || '').trim();
        const workflowNorm = workflowRaw.toLowerCase().replace(/_/g, ' ').trim();

        if (status === 'draft') {
          column = 'draft';
          statusFlag = 'draft';
        } else if (workflowNorm === 'payment settled' || status === 'completed') {
          column = 'settled';
          statusFlag = 'settled';
        } else if (workflowNorm === 'invoiced') {
          column = 'invoiced';
          statusFlag = 'invoiced';
        } else if (workflowNorm === 'pod submitted') {
          column = 'pod';
          statusFlag = 'pod submitted';
        } else if (workflowNorm === 'in transit' || status === 'in_transit') {
          column = 'inTransit';
          statusFlag = 'in transit';
        } else if (['awarded', 'dispatched'].includes(workflowNorm) || status === 'accepted' || status === 'covered') {
          column = 'accepted';
          statusFlag = 'accepted';
        } else if (workflowNorm === 'tendered' || workflowNorm === 'posted') {
          column = 'tendered';
          statusFlag = 'tendered';
        } else if (status === 'delivered') {
          column = 'delivered';
          statusFlag = 'delivered';
        } else if (load.assigned_driver || load.assigned_driver_id) {
          const das = String(load.driver_assignment_status || '').toLowerCase();
          if (das === 'accepted') {
            statusFlag = 'accepted';
            column = 'accepted';
          } else {
            statusFlag = 'assigned';
            column = 'tendered';
          }
        } else {
          statusFlag = 'unassigned';
          column = 'tendered';
        }

        const statusLabel = String(workflowRaw || load.workflow_status || load.status || statusFlag || 'N/A');
        
        // Get driver name if assigned
        let driverName = null;
        if (load.assigned_driver_name) {
          driverName = load.assigned_driver_name;
        } else if (load.assigned_driver || load.assigned_driver_id) {
          driverName = tr('myLoads.driverAssigned', 'Driver Assigned');
        }

        const statusLabelTranslated = (() => {
          const code = String(statusFlag || '').toLowerCase();
          if (code === 'draft') return tr('myLoads.status.draft', 'Draft');
          if (code === 'tendered') return tr('myLoads.status.tendered', 'Tendered');
          if (code === 'accepted') return tr('myLoads.status.accepted', 'Accepted');
          if (code === 'in transit') return tr('myLoads.status.inTransit', 'In Transit');
          if (code === 'delivered') return tr('myLoads.status.delivered', 'Delivered');
          if (code === 'pod submitted') return tr('myLoads.status.podSubmitted', 'POD Submitted');
          if (code === 'invoiced') return tr('myLoads.status.invoiced', 'Invoiced');
          if (code === 'settled') return tr('myLoads.status.settled', 'Settled');
          if (code === 'assigned') return tr('myLoads.status.assigned', 'Assigned');
          if (code === 'unassigned') return tr('myLoads.status.unassigned', 'Unassigned');
          return statusLabel || tr('common.na', 'N/A');
        })();
        
        grouped[column].push({
          id: load.load_id,
          origin: load.origin,
          destination: load.destination,
          broker: 'FreightPower',
          equipment: load.equipment_type?.replace('_', ' '),
          weight: load.weight,
          priceAmount: (typeof load.total_rate !== 'undefined' && load.total_rate !== null) ? Number(load.total_rate) : null,
          pickup: load.pickup_date,
          status: statusLabel,
          statusLabel: statusLabelTranslated,
          driver: driverName,
          fullData: load // Store full load data
        });
      });

      setLoads(grouped);
    } catch (err) {
      setError(err.message);
      console.error('Fetch loads error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadAdded = () => {
    // Refresh loads after adding new one
    fetchLoads();
    setShowAddLoads(false);
    setResumeLoad(null); // Clear resume state
  };

  const openModal = (columnKey) => {
    setModalOpen(columnKey);
  };

  const closeModal = () => {
    setModalOpen(null);
  };

  const openDetailsFromModalCard = (card) => {
    // card.fullData is the raw backend payload from /loads
    const payload = card?.fullData || card;
    if (!payload) return;
    setDetailsLoad(payload);
  };

  const closeDetailsModal = () => {
    setDetailsLoad(null);
  };

  return (
    <div className="myloads-root">
      {error && (
        <div style={{backgroundColor: '#fee2e2', color: '#991b1b', padding: '12px', borderRadius: '8px', marginBottom: '16px'}}>
          {tr('common.errorPrefix', 'Error:')} {error}
        </div>
      )}
      
      <div className="ml-header">
        <div className="fp-header-titles">
          <h2>{tr('myLoads.title', 'My Loads')}</h2>
          <p className="fp-subtitle">{tr('myLoads.subtitle', 'Track and manage your active loads')}</p>
        </div>
        <div className="ml-actions">
          <div className="ml-toolbar">
            <input
              className="ml-search"
              placeholder={tr('myLoads.search.placeholder', 'Search loads...')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {/* <button className="btn small-cd" onClick={() => setShowAddLoads(true)}>+ Add Load</button> */}
          </div>
        </div>
      </div>

      <div className="ml-board">
        {/* <Column 
          title="Draft" 
          items={loads.draft} 
          isLoading={isLoading} 
          onItemClick={handleDraftClick}
          onCardClick={() => openModal('draft')}
        /> */}
        {COLUMN_DEFS.map((col) => (
          <Column
            key={col.key}
            columnKey={col.key}
            title={col.title}
            items={filteredLoads[col.key] || []}
            isLoading={isLoading}
            onCardClick={() => openModal(col.key)}
            tr={tr}
            fmtMoney={fmtMoney}
          />
        ))}
        {/* <Column 
          title="Settled" 
          items={loads.settled} 
          isLoading={isLoading}
          onCardClick={() => openModal('settled')}
        /> */}
      </div>

      {/* Modals for each load type */}
      {modalOpen === 'draft' && (
        <LoadsModal title={tr('myLoads.modalTitle.draft', 'Draft Loads')} items={filteredLoads.draft} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'tendered' && (
        <LoadsModal title={tr('myLoads.modalTitle.tendered', 'Tendered Loads')} items={filteredLoads.tendered} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'accepted' && (
        <LoadsModal title={tr('myLoads.modalTitle.accepted', 'Accepted Loads')} items={filteredLoads.accepted} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'inTransit' && (
        <LoadsModal title={tr('myLoads.modalTitle.inTransit', 'In Transit Loads')} items={filteredLoads.inTransit} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'delivered' && (
        <LoadsModal title={tr('myLoads.modalTitle.delivered', 'Delivered Loads')} items={filteredLoads.delivered} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'pod' && (
        <LoadsModal title={tr('myLoads.modalTitle.pod', 'POD Loads')} items={filteredLoads.pod} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'invoiced' && (
        <LoadsModal title={tr('myLoads.modalTitle.invoiced', 'Invoiced Loads')} items={filteredLoads.invoiced} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}
      {modalOpen === 'settled' && (
        <LoadsModal title={tr('myLoads.modalTitle.settled', 'Settled Loads')} items={filteredLoads.settled} onClose={closeModal} onLoadClick={openDetailsFromModalCard} tr={tr} fmtMoney={fmtMoney} />
      )}

      {/* Nested modal: open when user clicks a specific load card inside the grid modal */}
      {detailsLoad && <LoadDetailsModal load={detailsLoad} onClose={closeDetailsModal} />}

      {showAddLoads && <AddLoads onClose={handleLoadAdded} draftLoad={resumeLoad} />}
    </div>
  );
}

