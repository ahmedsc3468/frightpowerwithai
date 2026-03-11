import React, { useState, useEffect } from 'react';
import '../../styles/carrier/MyLoads.css';
import AddLoads from './AddLoads';
import LoadDetailsModal from './LoadDetailsModal';
import { API_URL } from '../../config';
import { auth } from '../../firebase';

// Modal to display all loads in a grid
function LoadsModal({ title, items, onClose, onLoadClick }) {
  return (
    <div className="loads-modal-overlay" onClick={onClose}>
      <div className="loads-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="loads-modal-header">
          <h3>{title} Loads</h3>
          <button className="loads-modal-close" onClick={onClose}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div className="loads-modal-grid">
          {items.length === 0 ? (
            <div style={{padding: '40px', textAlign: 'center', color: '#9ca3af', gridColumn: '1 / -1'}}>
              No loads available
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
                  <div className="ml-tag">{it.status}</div>
                </div>
                <div className="ml-card-body">
                  <div className="ml-route"><span className="ml-dot green" />{it.origin}</div>
                  <div className="ml-route"><span className="ml-dot red" />{it.destination}</div>
                  
                  {it.equipment && (
                    <div className="ml-broker">{it.equipment} • {it.weight ? `${it.weight} lbs` : 'N/A'}</div>
                  )}

                  {it.driver && (
                    <div className="ml-driver-row">
                      <div className="muted">Driver: {it.driver}</div>
                      <div className="ml-price">{it.price}</div>
                    </div>
                  )}

                  {it.invoice && <div className="muted">Invoice: {it.invoice}</div>}

                  {it.pickup && (
                    <div className="ml-pickup-row">
                      <div className="ml-pickup muted">Pickup: {it.pickup}</div>
                      <div className="ml-price">{it.price}</div>
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

function Column({ title, items, isLoading, onCardClick }) {
  const key = title ? title.toLowerCase() : '';
  const isTender = key === 'tendered' || key.includes('tender');
  const isAccepted = key === 'accepted' || key.includes('accept');
  const isInTransit = key === 'in transit' || key.includes('transit') || key.includes('in transit');
  const isDelivered = key === 'delivered' || key.includes('deliver');
  const isPod = key === 'pod' || key.includes('pod');
  const isInvoiced = key === 'invoiced' || key.includes('invoice') || key.includes('invoiced');
  const isSettled = key === 'settled' || key.includes('settled');
  const isDraft = key === 'draft' || key.includes('draft');
  
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
            <div style={{padding: '20px', textAlign: 'center', color: '#6b7280'}}>Loading...</div>
          ) : !displayItem ? (
            <div style={{padding: '20px', textAlign: 'center', color: '#9ca3af'}}>No loads</div>
          ) : (
            <>
              <div 
                className={`ml-card ${isTender ? 'tender-card' : ''} ${isAccepted ? 'accepted-card' : ''} ${isInTransit ? 'in-transit-card' : ''} ${isDelivered ? 'delivered-card' : ''} ${isPod ? 'pod-card' : ''} ${isInvoiced ? 'invoiced-card' : ''} ${isSettled ? 'settled-card' : ''} ${isDraft ? 'draft-card' : ''}`} 
                role="article"
              >
                <div className="ml-card-top">
                  <div className="ml-id">{displayItem.id}</div>
                  <div className="ml-tag">{displayItem.status}</div>
                </div>
                <div className="ml-card-body">
                  <div className="ml-route"><span className="ml-dot green" />{displayItem.origin}</div>
                  <div className="ml-route"><span className="ml-dot red" />{displayItem.destination}</div>
                  
                  {displayItem.equipment && (
                    <div className="ml-broker">{displayItem.equipment} • {displayItem.weight ? `${displayItem.weight} lbs` : 'N/A'}</div>
                  )}

                  {!isTender && displayItem.driver && (
                    <div className="ml-driver-row">
                      <div className="muted">Driver: {displayItem.driver}</div>
                      <div className="ml-price">{displayItem.price}</div>
                    </div>
                  )}

                  {displayItem.invoice && <div className="muted">Invoice: {displayItem.invoice}</div>}

                  {isTender && displayItem.pickup && (
                    <div className="ml-pickup-row">
                      <div className="ml-pickup muted">Pickup: {displayItem.pickup}</div>
                      <div className="ml-price">{displayItem.price}</div>
                    </div>
                  )}
                </div>
              </div>
              {hasMore && (
                <div className="ml-view-more">
                  Click to view all {items.length} loads
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
  const [showAddLoads, setShowAddLoads] = useState(false);
  const [resumeLoad, setResumeLoad] = useState(null); // For resuming draft loads
  const [detailsLoad, setDetailsLoad] = useState(null); // For viewing load details from modal cards
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
        throw new Error('Not authenticated');
      }
      
      const token = await user.getIdToken();
      const response = await fetch(`${API_URL}/loads?page_size=200&exclude_drafts=false`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch loads');
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
          driverName = 'Driver Assigned';
        }
        
        grouped[column].push({
          id: load.load_id,
          origin: load.origin,
          destination: load.destination,
          broker: 'FreightPower',
          equipment: load.equipment_type?.replace('_', ' '),
          weight: load.weight,
          price: load.total_rate ? `$${load.total_rate.toLocaleString()}` : 'N/A',
          pickup: load.pickup_date,
          status: statusLabel,
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
          Error: {error}
        </div>
      )}
      
      <div className="ml-header">
        <div className="fp-header-titles">
          <h2>My Loads</h2>
          <p className="fp-subtitle">Track and manage your active loads</p>
        </div>
        <div className="ml-actions">
          <div className="ml-toolbar">
            <input className="ml-search" placeholder="Search loads..." />
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
        <Column 
          title="Tendered" 
          items={loads.tendered} 
          isLoading={isLoading}
          onCardClick={() => openModal('tendered')}
        />
        <Column 
          title="Accepted" 
          items={loads.accepted} 
          isLoading={isLoading}
          onCardClick={() => openModal('accepted')}
        />
        <Column 
          title="In Transit" 
          items={loads.inTransit} 
          isLoading={isLoading}
          onCardClick={() => openModal('inTransit')}
        />
        <Column 
          title="Delivered" 
          items={loads.delivered} 
          isLoading={isLoading}
          onCardClick={() => openModal('delivered')}
        />
        <Column 
          title="POD" 
          items={loads.pod} 
          isLoading={isLoading}
          onCardClick={() => openModal('pod')}
        />
        <Column 
          title="Invoiced" 
          items={loads.invoiced} 
          isLoading={isLoading}
          onCardClick={() => openModal('invoiced')}
        />
        {/* <Column 
          title="Settled" 
          items={loads.settled} 
          isLoading={isLoading}
          onCardClick={() => openModal('settled')}
        /> */}
      </div>

      {/* Modals for each load type */}
      {modalOpen === 'draft' && (
        <LoadsModal title="Draft" items={loads.draft} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'tendered' && (
        <LoadsModal title="Tendered" items={loads.tendered} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'accepted' && (
        <LoadsModal title="Accepted" items={loads.accepted} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'inTransit' && (
        <LoadsModal title="In Transit" items={loads.inTransit} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'delivered' && (
        <LoadsModal title="Delivered" items={loads.delivered} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'pod' && (
        <LoadsModal title="POD" items={loads.pod} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'invoiced' && (
        <LoadsModal title="Invoiced" items={loads.invoiced} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}
      {modalOpen === 'settled' && (
        <LoadsModal title="Settled" items={loads.settled} onClose={closeModal} onLoadClick={openDetailsFromModalCard} />
      )}

      {/* Nested modal: open when user clicks a specific load card inside the grid modal */}
      {detailsLoad && <LoadDetailsModal load={detailsLoad} onClose={closeDetailsModal} />}

      {showAddLoads && <AddLoads onClose={handleLoadAdded} draftLoad={resumeLoad} />}
    </div>
  );
}

