import React, { useEffect, useRef, useState } from 'react';
import '../../styles/carrier/DriversAndDispatches.css';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import HereMap from '../common/HereMap';
import { downloadCsv } from '../../utils/fileDownload';

const DriversAndDispatches = () => {
  const { currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState('directory');
  const [searchTerm, setSearchTerm] = useState('');
  const [cdlFilter, setCdlFilter] = useState('All CDL Types');
  const [availabilityFilter, setAvailabilityFilter] = useState('All Availability');
  const [locationFilter, setLocationFilter] = useState('All Locations');
  const [drivers, setDrivers] = useState([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [availableLoads, setAvailableLoads] = useState([]);
  const [carrierLoads, setCarrierLoads] = useState([]);
  const [loadsLoading, setLoadsLoading] = useState(false);
  const [assigningLoad, setAssigningLoad] = useState(null);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [isMapFullscreen, setIsMapFullscreen] = useState(false);
  const [showAddDriverModal, setShowAddDriverModal] = useState(false);
  const [marketplaceDrivers, setMarketplaceDrivers] = useState([]);
  const [marketplaceDriversLoading, setMarketplaceDriversLoading] = useState(false);
  const [marketplaceDriversError, setMarketplaceDriversError] = useState('');
  const [driverRequestingId, setDriverRequestingId] = useState('');
  const mapHistoryPushedRef = useRef(false);

  const parseEpochSeconds = (value) => {
    if (!value) return null
    if (typeof value === 'number') return value
    if (typeof value?.seconds === 'number') return value.seconds
    const s = String(value).trim()
    if (!s) return null
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    const d = new Date(s)
    const ms = d.getTime()
    if (Number.isNaN(ms)) return null
    return Math.floor(ms / 1000)
  }

  const timeAgo = (value) => {
    const ts = parseEpochSeconds(value)
    if (!ts) return '—'
    const deltaSec = Math.max(0, Math.floor(Date.now() / 1000) - ts)
    if (deltaSec < 60) return `${deltaSec}s ago`
    const min = Math.floor(deltaSec / 60)
    if (min < 60) return `${min} min ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
    const days = Math.floor(hr / 24)
    return `${days} day${days === 1 ? '' : 's'} ago`
  }

  const loadIsActive = (load) => {
    const s = String(load?.status || '').toLowerCase()
    return s && s !== 'draft' && s !== 'cancelled' && s !== 'delivered' && s !== 'completed'
  }

  const loadHasNoDriver = (load) => {
    return !load?.assigned_driver && !load?.assigned_driver_id
  }

  const loadBestTimestamp = (load) => {
    return (
      parseEpochSeconds(load?.updated_at)
      || parseEpochSeconds(load?.updatedAt)
      || parseEpochSeconds(load?.created_at)
      || parseEpochSeconds(load?.createdAt)
      || 0
    )
  }

  const loadScheduledDeliveryTs = (load) => {
    return (
      parseEpochSeconds(load?.delivery_date)
      || parseEpochSeconds(load?.deliveryDate)
      || null
    )
  }

  const loadDeliveredTs = (load) => {
    return (
      parseEpochSeconds(load?.delivered_at)
      || parseEpochSeconds(load?.deliveredAt)
      || parseEpochSeconds(load?.completed_at)
      || parseEpochSeconds(load?.completedAt)
      || null
    )
  }

  const driverHosRemainingHours = (rawDriver) => {
    const candidates = [
      rawDriver?.hos_hours_remaining,
      rawDriver?.hos_remaining_hours,
      rawDriver?.hos_remaining,
      rawDriver?.hours_remaining_14,
      rawDriver?.hos_14_remaining,
    ]
    for (const c of candidates) {
      const n = typeof c === 'number' ? c : (c ? Number(c) : null)
      if (Number.isFinite(n)) return n
    }
    return null
  }

  const driverLastUpdatedTs = (rawDriver) => {
    const candidates = [
      rawDriver?.updated_at,
      rawDriver?.updatedAt,
      rawDriver?.last_updated_at,
      rawDriver?.lastUpdatedAt,
      rawDriver?.location_updated_at,
      rawDriver?.locationUpdatedAt,
      rawDriver?.last_location_at,
      rawDriver?.lastLocationAt,
      rawDriver?.created_at,
      rawDriver?.createdAt,
    ]
    for (const c of candidates) {
      const ts = parseEpochSeconds(c)
      if (typeof ts === 'number' && ts > 0) return ts
    }
    return null
  }

  // Fetch hired drivers
  const fetchMyDrivers = async () => {
    if (!currentUser) return;

    setDriversLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/drivers/my-drivers`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        // Format drivers for UI
        const formattedDrivers = (data.drivers || []).map(driver => {
          // Build endorsements string
          const endorsementsList = []
          if (driver.hazmat_endorsement) endorsementsList.push('HazMat')
          if (driver.tanker_endorsement) endorsementsList.push('Tanker')
          if (driver.doubles_triples) endorsementsList.push('Double/Triple')
          if (driver.passenger_endorsement) endorsementsList.push('Passenger')
          const endorsements = endorsementsList.length > 0 ? endorsementsList.join(', ') : 'None'

          // Format medical card expiry
          let medicalCard = 'Not provided'
          if (driver.medical_card_expiry) {
            const expiryDate = new Date(driver.medical_card_expiry.seconds * 1000 || driver.medical_card_expiry)
            const now = new Date()
            if (expiryDate > now) {
              medicalCard = `Valid until ${expiryDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}`
            } else {
              medicalCard = `Expired ${expiryDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}`
            }
          }

          return {
            id: driver.id || driver.driver_id,
            name: driver.name || 'Unknown Driver',
            location: driver.current_location || driver.current_city || 'Unknown',
            avatar: (driver.name || 'Driver').split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2),
            // Driver is only "Assigned" when on_trip/in_transit. Otherwise they're available for new loads
            status: driver.status === 'in_transit' ? 'In Transit'
              : (driver.status === 'on_trip' ? 'Assigned'
              : (driver.status === 'off_duty' || driver.status === 'unavailable' ? 'Rest' : 'Available')),
            cdlClass: driver.cdl_class || 'N/A',
            endorsements: endorsements,
            medicalCard: medicalCard,
            equipment: 'Truck Assignment',
            // Can assign loads if driver is available (not on a trip)
            assignLoad: driver.status !== 'on_trip' && driver.status !== 'in_transit',
            onRoute: driver.status === 'on_trip' || driver.status === 'in_transit',
            offDuty: driver.status === 'off_duty' || driver.status === 'unavailable'
            ,
            hosRemainingHours: driverHosRemainingHours(driver),
            lastUpdatedTs: driverLastUpdatedTs(driver),
            rawStatus: driver.status,
          }
        })
        setDrivers(formattedDrivers)
      }
    } catch (error) {
      console.error('Error fetching drivers:', error)
      setDrivers([])
    } finally {
      setDriversLoading(false)
    }
  }

  // Fetch carrier-visible loads
  const fetchCarrierLoads = async () => {
    if (!currentUser) return;

    setLoadsLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/loads?exclude_drafts=true`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();

        const allLoads = Array.isArray(data.loads) ? data.loads : []
        setCarrierLoads(allLoads)
        
        // IMPORTANT:
        // The backend `/loads` endpoint is already role-filtered for carriers
        // (created_by=carrier OR assigned_carrier=carrier). So the Dispatch Board
        // should treat the returned loads as "carrier-visible" and only filter
        // by driver assignment + active status.
        const unassignedLoads = allLoads.filter(load => loadHasNoDriver(load) && loadIsActive(load));
        setAvailableLoads(unassignedLoads);
      }
    } catch (error) {
      console.error('Error fetching loads:', error)
      setAvailableLoads([])
      setCarrierLoads([])
    } finally {
      setLoadsLoading(false)
    }
  }

  const fetchMarketplaceDrivers = async () => {
    if (!currentUser) return;

    setMarketplaceDriversLoading(true);
    setMarketplaceDriversError('');
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/drivers?available_only=true`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.detail || 'Failed to load available drivers');
      }

      setMarketplaceDrivers(Array.isArray(data?.drivers) ? data.drivers : []);
    } catch (error) {
      console.error('Error fetching available drivers:', error);
      setMarketplaceDrivers([]);
      setMarketplaceDriversError(error?.message || 'Failed to load available drivers');
    } finally {
      setMarketplaceDriversLoading(false);
    }
  };

  const handleOpenAddDriverModal = () => {
    setShowAddDriverModal(true);
    fetchMarketplaceDrivers();
  };

  const handleCloseAddDriverModal = () => {
    setShowAddDriverModal(false);
    setDriverRequestingId('');
    setMarketplaceDriversError('');
  };

  const handleSendHireRequest = async (driver) => {
    if (!currentUser || !driver?.id) return;

    setDriverRequestingId(String(driver.id));
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/drivers/${encodeURIComponent(driver.id)}/hire-request`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.detail || 'Failed to send hire request');
      }

      const sentRequestId = data?.request?.id;
      setMarketplaceDrivers((prev) => (prev || []).filter((d) => String(d?.id || '') !== String(driver.id)));
      alert(sentRequestId ? `Request sent to ${driver.name || 'driver'}. They will receive a notification to accept.` : `Request sent to ${driver.name || 'driver'}.`);
    } catch (error) {
      console.error('Error sending hire request:', error);
      alert(error?.message || 'Failed to send hire request. Please try again.');
    } finally {
      setDriverRequestingId('');
    }
  };

  // Assign load to driver
  const handleAssignLoad = async (driverId, loadId) => {
    if (!currentUser) return;

    setAssigningLoad(`${driverId}-${loadId}`)
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/loads/${loadId}/assign-driver`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ driver_id: driverId })
      });

      if (response.ok) {
        alert('Load assigned successfully!')
        // Refresh drivers and loads
        fetchMyDrivers()
        fetchCarrierLoads()
      } else {
        const error = await response.json()
        alert(`Failed to assign load: ${error.detail || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Error assigning load:', error)
      alert('Failed to assign load. Please try again.')
    } finally {
      setAssigningLoad(null)
    }
  }

  useEffect(() => {
    fetchMyDrivers()
    if (activeTab === 'dispatch') {
      fetchCarrierLoads()
    }
  }, [currentUser, activeTab])

  const driversById = new Map(drivers.map(d => [String(d.id), d]))
  const activeLoads = carrierLoads.filter(loadIsActive)
  const pendingAssignmentLoads = activeLoads.filter(loadHasNoDriver)

  // Best-effort on-time rate based on delivered timestamp <= scheduled delivery.
  const deliveredLoads = carrierLoads.filter(l => {
    const s = String(l?.status || '').toLowerCase()
    return s === 'delivered' || s === 'completed'
  })
  const onTimeStats = deliveredLoads.reduce((acc, l) => {
    const scheduled = loadScheduledDeliveryTs(l)
    const delivered = loadDeliveredTs(l)
    if (!scheduled || !delivered) return acc
    acc.total += 1
    if (delivered <= scheduled) acc.onTime += 1
    return acc
  }, { total: 0, onTime: 0 })
  const onTimeRatePct = onTimeStats.total > 0 ? Math.round((onTimeStats.onTime / onTimeStats.total) * 100) : null

  const exceptions = (() => {
    const items = []

    // HOS alerts (if we have HOS data)
    const hosDrivers = drivers
      .map(d => ({ d, hos: typeof d.hosRemainingHours === 'number' ? d.hosRemainingHours : null }))
      .filter(x => typeof x.hos === 'number')
      .sort((a, b) => a.hos - b.hos)

    for (const { d, hos } of hosDrivers) {
      if (hos > 2) continue
      const relatedLoad = carrierLoads.find(l => String(l?.assigned_driver_id || l?.assigned_driver || '') === String(d.id))
      const loadLabel = relatedLoad?.load_id || relatedLoad?.id
      items.push({
        id: `hos:${d.id}`,
        tone: 'red',
        icon: 'fa-triangle-exclamation',
        title: 'HOS Alert',
        time: timeAgo(d.lastUpdatedTs),
        desc: `${d.name} has ~${hos.toFixed(1)}h HOS remaining${loadLabel ? ` on Load #${String(loadLabel).slice(0, 8)}` : ''}`,
        primary: { label: 'Force Rest', onClick: () => alert('Force Rest is not yet automated. Please contact the driver.') },
        secondary: { label: 'Reassign Load', onClick: () => alert('Use Load Assignment & Control to reassign.') },
      })
      break
    }

    // Detention alerts (if load flags exist)
    const detentionLoad = carrierLoads
      .filter(l => Boolean(l?.detention_reported || l?.detention || l?.detention_hours || l?.detention_minutes))
      .sort((a, b) => loadBestTimestamp(b) - loadBestTimestamp(a))[0]
    if (detentionLoad) {
      const loadLabel = detentionLoad?.load_id || detentionLoad?.id
      const driverId = detentionLoad?.assigned_driver_id || detentionLoad?.assigned_driver
      const driverName = driverId ? (driversById.get(String(driverId))?.name || 'A driver') : 'A driver'
      items.push({
        id: `detention:${String(loadLabel)}`,
        tone: 'yellow',
        icon: 'fa-triangle-exclamation',
        title: 'Detention Report',
        time: timeAgo(loadBestTimestamp(detentionLoad)),
        desc: `${driverName} reported detention on Load #${String(loadLabel).slice(0, 8)}`,
        primary: { label: 'Log Detention', onClick: () => alert('Detention logging is not yet wired. (Coming soon)') },
        secondary: { label: 'Contact Customer', onClick: () => alert('Customer contact is not yet wired. (Coming soon)') },
      })
    }

    // Pending assignment risk: pickup soon without driver
    const nowSec = Math.floor(Date.now() / 1000)
    const atRisk = pendingAssignmentLoads
      .map(l => ({ l, pickup: parseEpochSeconds(l?.pickup_date || l?.pickupDate) }))
      .filter(x => x.pickup && x.pickup > 0)
      .sort((a, b) => a.pickup - b.pickup)
      .find(x => (x.pickup - nowSec) <= (24 * 3600))

    if (atRisk) {
      const loadLabel = atRisk.l?.load_id || atRisk.l?.id
      items.push({
        id: `risk:${String(loadLabel)}`,
        tone: 'blue',
        icon: 'fa-screwdriver-wrench',
        title: 'Assignment Risk',
        time: timeAgo(loadBestTimestamp(atRisk.l)),
        desc: `Load #${String(loadLabel).slice(0, 8)} pickups soon but has no driver assigned`,
        primary: { label: 'Quick Assign', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
        secondary: { label: 'View Details', onClick: () => alert('Load details from Dispatch Board is coming soon.') },
      })
    }

    return items.slice(0, 3)
  })()

  const activityItems = (() => {
    const rows = []

    for (const l of carrierLoads) {
      const loadId = l?.load_id || l?.id
      const ts = loadBestTimestamp(l)
      const status = String(l?.status || '').toLowerCase()
      const driverId = l?.assigned_driver_id || l?.assigned_driver
      const driverName = driverId ? (driversById.get(String(driverId))?.name || 'Driver') : null

      if (driverName && loadId && loadIsActive(l) && !loadHasNoDriver(l)) {
        rows.push({
          id: `assign:${String(loadId)}:${String(driverId)}`,
          kind: 'check',
          icon: 'fa-check-circle',
          text: (<><span style={{ fontWeight: 600 }}>{driverName}</span> assigned to Load <span style={{ textDecoration: 'underline' }}>#{String(loadId).slice(0, 8)}</span></>),
          meta: `${timeAgo(ts)} by System`,
          ts,
        })
      }

      if (loadId && (status === 'delivered' || status === 'completed')) {
        rows.push({
          id: `delivered:${String(loadId)}`,
          kind: 'location',
          icon: 'fa-map-marker-alt',
          text: (<>Load <span style={{ textDecoration: 'underline' }}>#{String(loadId).slice(0, 8)}</span> marked {status === 'completed' ? 'completed' : 'delivered'}</>),
          meta: timeAgo(ts),
          ts,
        })
      }

      if (loadId && (l?.detention_reported || l?.detention || l?.detention_hours || l?.detention_minutes)) {
        rows.push({
          id: `detention:${String(loadId)}`,
          kind: 'warning',
          icon: 'fa-exclamation-circle',
          text: (<>Detention reported on Load <span style={{ textDecoration: 'underline' }}>#{String(loadId).slice(0, 8)}</span></>),
          meta: timeAgo(ts),
          ts,
        })
      }
    }

    // Also add an alert if there are pending assignments.
    if (pendingAssignmentLoads.length > 0) {
      rows.push({
        id: 'pending-assignments',
        kind: 'alert',
        icon: 'fa-exclamation-triangle',
        text: (<>There are <span style={{ fontWeight: 600 }}>{pendingAssignmentLoads.length}</span> active load(s) pending assignment</>),
        meta: 'Now',
        ts: Math.floor(Date.now() / 1000),
      })
    }

    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    return showAllActivity ? rows : rows.slice(0, 5)
  })()

  const filteredDrivers = drivers.filter(driver => {
    const matchesSearch = driver.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         driver.location.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCdl = cdlFilter === 'All CDL Types' || driver.cdlClass.includes(cdlFilter.replace('CDL ', ''));
    const matchesAvailability = availabilityFilter === 'All Availability' || driver.status === availabilityFilter;
    const matchesLocation = locationFilter === 'All Locations' || driver.location.includes(locationFilter);
    
    return matchesSearch && matchesCdl && matchesAvailability && matchesLocation;
  });

  const handleExportDrivers = () => {
    const rows = (Array.isArray(filteredDrivers) ? filteredDrivers : []).map(d => ({
      id: d?.id,
      name: d?.name,
      status: d?.status,
      location: d?.location,
      cdl_class: d?.cdlClass,
      endorsements: d?.endorsements,
      equipment: d?.equipment,
      medical_card: d?.medicalCard,
      insurance: d?.insurance,
      compliance: d?.compliance,
      hos_remaining_hours: typeof d?.hosRemainingHours === 'number' ? d.hosRemainingHours : null,
      last_updated: typeof d?.lastUpdatedTs === 'number' ? d.lastUpdatedTs : null,
    }));

    downloadCsv(
      `carrier_driver_directory_${new Date().toISOString().slice(0, 10)}.csv`,
      rows,
      ['id', 'name', 'status', 'location', 'cdl_class', 'endorsements', 'equipment', 'medical_card', 'insurance', 'compliance', 'hos_remaining_hours', 'last_updated']
    );
  };

  const trackingMarkers = [
    // Example markers - in production, these would come from real GPS data
    { lat: 40.7128, lng: -74.0060, label: 'Driver 1', icon: 'https://cdn-icons-png.flaticon.com/512/684/684908.png' },
    { lat: 34.0522, lng: -118.2437, label: 'Driver 2', icon: 'https://cdn-icons-png.flaticon.com/512/684/684908.png' },
    { lat: 41.8781, lng: -87.6298, label: 'Driver 3', icon: 'https://cdn-icons-png.flaticon.com/512/684/684908.png' }
  ];

  const openMapFullscreen = () => {
    setIsMapFullscreen(true);
    try {
      // Push a history state so browser back exits fullscreen.
      window.history.pushState({ fp_map_fullscreen: true }, document.title);
      mapHistoryPushedRef.current = true;
    } catch {
      // ignore
    }
  };

  const closeMapFullscreen = () => {
    // If we pushed a history entry, use back so the user can navigate intuitively.
    if (mapHistoryPushedRef.current) {
      try {
        window.history.back();
        return;
      } catch {
        // fall through
      }
    }
    setIsMapFullscreen(false);
    mapHistoryPushedRef.current = false;
  };

  useEffect(() => {
    if (!isMapFullscreen) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMapFullscreen();
      }
    };

    const onPopState = (e) => {
      // Back navigation should exit fullscreen.
      setIsMapFullscreen(false);
      mapHistoryPushedRef.current = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMapFullscreen]);

  return (
    <div className="drivers-dispatches">
      {/* Header Section */}
      <div className="drivers-header">
        <div className="drivers-header-content">
          <h1>Drivers & Dispatches</h1>
          <p className="drivers-subtitle">Manage your drivers and dispatch operations</p>
        </div>
        <div className="drivers-actions">
          <button className="btn small-cd" type="button" onClick={handleOpenAddDriverModal}>
            <i className="fas fa-plus"></i>
            Add Driver
          </button>
          <button className="btn small ghost-cd" type="button" onClick={handleExportDrivers} disabled={filteredDrivers.length === 0}>
            <i className="fas fa-download"></i>
            Export
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="drivers-nav">
        <div className="drivers-tabs">
          <button 
            className={`driver-tab ${activeTab === 'directory' ? 'active' : ''}`}
            onClick={() => setActiveTab('directory')}
          >
            Driver Directory
          </button>
          <button 
            className={`driver-tab ${activeTab === 'dispatch' ? 'active' : ''}`}
            onClick={() => setActiveTab('dispatch')}
          >
            Dispatch Board
          </button>
          <button 
            className={`driver-tab ${activeTab === 'app' ? 'active' : ''}`}
            onClick={() => setActiveTab('app')}
          >
          </button>
        </div>
      </div>

      {/* Driver Directory Tab Content */}
      {activeTab === 'directory' && (
        <>
          {/* Search and Filters */}
          <div className="drivers-controls">
            <div className="search-container">
              <i className="fas fa-search search-icon"></i>
              <input
                type="text"
                className="drivers-search"
                placeholder="Search drivers..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="filters-container">
              <select
                className="driver-dd-filter-select"
                value={cdlFilter}
                onChange={(e) => setCdlFilter(e.target.value)}
              >
                <option>All CDL Types</option>
                <option>CDL Class A</option>
                <option>CDL Class B</option>
                <option>CDL Class C</option>
              </select>
              <select
                className="driver-dd-filter-select"
                value={availabilityFilter}
                onChange={(e) => setAvailabilityFilter(e.target.value)}
              >
                <option>All Availability</option>
                <option>Available</option>
                <option>Assigned</option>
                <option>Off Duty</option>
              </select>
              <select
                className="driver-dd-filter-select"
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
              >
                <option>All Locations</option>
                <option>Houston</option>
                <option>Dallas</option>
                <option>San Antonio</option>
                <option>Fort Worth</option>
              </select>
            </div>
          </div>

          {/* Driver Cards Grid */}
          {driversLoading ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', marginRight: '10px' }}></i>
              Loading drivers...
            </div>
          ) : filteredDrivers.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
              <i className="fa-solid fa-users" style={{ fontSize: '48px', marginBottom: '20px', opacity: 0.5 }}></i>
              <p>No drivers found. Hire drivers from the Marketplace to get started.</p>
            </div>
          ) : (
          <div className="drivers-grid">
            {filteredDrivers.map(driver => (
              <div key={driver.id} className="driver-card">
                <div className="driver-header">
                  <div className="driver-profile">
                    <div className={`driver-avatar ${driver.status.toLowerCase().replace(' ', '-')}`}>
                      {driver.avatar}
                    </div>
                    <div className="driver-info">
                      <h3>{driver.name}</h3>
                      <p>{driver.location}</p>
                    </div>
                  </div>
                  <div className={`driver-status ${driver.status.toLowerCase().replace(' ', '-')}`}>
                    {driver.status}
                  </div>
                </div>

                <div className="driver-details">
                  <div className="driver-row cdl-class">
                    <span className="label">CDL Class:</span>
                    <span className="value">{driver.cdlClass}</span>
                  </div>
                  <div className="driver-row">
                    <span className="label">Endorsements:</span>
                    <span className="value">{driver.endorsements}</span>
                  </div>
                  <div className="driver-row">
                    <span className="label">Medical Card:</span>
                    <span className={`value ${driver.medicalCard.includes('Valid') ? 'valid' : ''}`}>{driver.medicalCard}</span>
                  </div>
                  <div className="driver-row">
                    <span className="label">Equipment:</span>
                    <span className="value">{driver.equipment}</span>
                  </div>
                </div>

                <div className="driver-actions">
                  <div className="icon-row">
                    {driver.assignLoad && (
                    <button 
                      className="btn small-cd" 
                      style={{width: "100%"}}
                      onClick={() => {
                        // Navigate to dispatch tab to assign load
                        setActiveTab('dispatch')
                        // Could also open a modal here
                      }}
                    >
                      Assign Load
                    </button>
                  )}
                    {driver.onRoute && (
                      <button className="btn small ghost-cd btn-on-route" title="On Route">
                        On Route
                      </button>
                    )}
                    {driver.offDuty && (
                      <button className="btn small ghost-cd btn-update-dock" title="Update Dock">
                        Off Duty
                      </button>
                    )}
                    <button className="btn-chat" title="Chat">
                      <i className="fas fa-comment"></i>
                    </button>
                    <button className="btn-more" title="More">
                      <i className="fas fa-ellipsis-h"></i>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          )}
        </>
      )}

      {/* Dispatch Board Tab Content */}
      {activeTab === 'dispatch' && (
        <div className="dispatch-board">
          <div className="dispatch-board-row">
            {/* Active Drivers Section */}
            <div className="active-drivers">
              <div className="active-drivers-header">
                <h3>Active Drivers</h3>
                <span className="driver-count">{drivers.length} driver{drivers.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="driver-status-filters">
                <span className="status-chip available">Available ({drivers.filter(d => d.status === 'Available').length})</span>
                <span className="status-chip assigned">Assigned ({drivers.filter(d => d.status === 'Assigned').length})</span>
                <span className="status-chip in-transit">In Transit ({drivers.filter(d => d.status === 'In Transit').length})</span>
                <span className="status-chip rest">Rest ({drivers.filter(d => d.status === 'Rest').length})</span>
              </div>
              {driversLoading ? (
                <div style={{ padding: '40px', textAlign: 'center' }}>
                  <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', marginRight: '10px' }}></i>
                  Loading drivers...
                </div>
              ) : drivers.length === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
                  <i className="fa-solid fa-users" style={{ fontSize: '48px', marginBottom: '20px', opacity: 0.5 }}></i>
                  <p>No drivers found. Hire drivers from the Marketplace.</p>
                </div>
              ) : (
              <div className="drivers-list">
                {drivers.map(driver => (
                <div key={driver.id} className="driver-item">
                  <div className="driver-header-row" style={{display: 'flex', alignItems: 'center', marginBottom: '2px', width: '100%'}}>
                    <div className="driver-header-left">
                      <div className="driver-avatar" style={{width: '40px', height: '40px', borderRadius: '50%', background: '#e0e7ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 'bold'}}>
                        {driver.avatar}
                      </div>
                      <div className="driver-header-info">
                        <div className="driver-name">{driver.name}</div>
                        <div className="driver-label">CDL-{driver.cdlClass}{driver.endorsements !== 'None' ? `, ${driver.endorsements.split(',')[0]}` : ''}</div>
                      </div>
                    </div>
                    <div className="driver-header-dot">
                      <span className={`driver-status-dot ${driver.status.toLowerCase().replace(' ', '-')}`}></span>
                    </div>
                  </div>
                  <div className="driver-row"><span className="driver-label">Status:</span><span className={`driver-status ${driver.status.toLowerCase().replace(' ', '-')}`}>{driver.status}</span></div>
                  <div className="driver-row"><span className="driver-label">Location:</span><span className="driver-value">{driver.location}</span></div>
                  <div className="driver-row"><span className="driver-label">HOS Left:</span><span className="driver-value">{typeof driver.hosRemainingHours === 'number' ? `${driver.hosRemainingHours.toFixed(1)}h` : 'N/A'}</span></div>
                  <div className="driver-row"><span className="driver-label">Truck:</span><span className="driver-value">{driver.equipment}</span></div>
                </div>
                ))}
              </div>
              )}
            </div>
            {/* Live Tracking Map Section */}
            <div className="live-tracking-map">
              <div className="live-tracking-header" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'12px'}}>
                <h3 style={{margin:0}}>Live Tracking Map</h3>
                <div />
              </div>
              <div className="map-legend">
                  <span><span className="legend-dot available"></span>Available</span>
                  <span><span className="legend-dot assigned"></span>Assigned</span>
                  <span><span className="legend-dot in-transit"></span>In Transit</span>
                  <span><span className="legend-dot rest"></span>Rest/Exception</span>
                </div>
              <div className="map-container">
                <button className="btn small ghost-cd map-fullscreen-btn" type="button" onClick={openMapFullscreen}>
                  <i className="fas fa-expand"></i> Fullscreen
                </button>
                <HereMap
                  containerId="drivers-tracking-map"
                  center={{ lat: 39.8283, lng: -98.5795 }} // Center of USA
                  zoom={4}
                  markers={trackingMarkers}
                  height="500px"
                  width="100%"
                />
              </div>
            </div>
          </div>

          {isMapFullscreen && (
            <div className="fp-map-fullscreen-overlay" role="dialog" aria-modal="true" aria-label="Live Tracking Map Fullscreen">
              <div className="fp-map-fullscreen-bar">
                <button className="btn small ghost-cd" type="button" onClick={closeMapFullscreen}>
                  <i className="fas fa-arrow-left"></i> Back
                </button>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div className="fp-map-fullscreen-title">Live Tracking Map</div>
                  <div className="fp-map-fullscreen-hint">Press Esc to exit</div>
                </div>
                <button className="btn small ghost-cd" type="button" onClick={closeMapFullscreen}>
                  <i className="fas fa-compress"></i> Exit
                </button>
              </div>
              <div className="fp-map-fullscreen-body">
                <HereMap
                  containerId="drivers-tracking-map-fullscreen"
                  center={{ lat: 39.8283, lng: -98.5795 }}
                  zoom={4}
                  markers={trackingMarkers}
                  height="calc(100vh - 64px)"
                  width="100%"
                />
              </div>
            </div>
          )}

          {/* Load Assignment & Control */}
          <div className="dispatch-section load-assignment">
            <div className="load-assignment-row">
              <div className="load-assignment-left">
                <div className="load-assignment-header-row">
                  <h3 className="load-assignment-title">Load Assignment & Control</h3>
                  <div className="load-assignment-actions">
                    <button className="btn small-cd"><i className="fas fa-plus"></i> Quick Assign</button>
                    <button className="btn small ghost-cd"><i className="fas fa-random"></i> Reassign Load</button>
                  </div>
                </div>
                <div className="load-assignment-content">
                  <div className="available-loads-col">
                    <div className="available-loads-title">Available Loads</div>
                    {loadsLoading ? (
                      <div style={{ padding: '20px', textAlign: 'center' }}>
                        <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '20px', marginRight: '10px' }}></i>
                        Loading loads...
                      </div>
                    ) : availableLoads.length === 0 ? (
                      <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                        <p>No available loads. Loads assigned to your carrier will appear here.</p>
                      </div>
                    ) : (
                      availableLoads.map(load => {
                        // Format price - check total_rate first (as used in MyLoads), then agreed_rate, then rate
                        const loadPrice = load.total_rate || load.agreed_rate || load.rate;
                        const formattedPrice = loadPrice ? (typeof loadPrice === 'number' ? `$${loadPrice.toLocaleString()}` : `$${loadPrice}`) : 'N/A';
                        
                        // Format load type: map backend values to display format
                        let loadTypeDisplay = 'N/A';
                        if (load.load_type) {
                          if (load.load_type === 'Full Truckload') {
                            loadTypeDisplay = 'FTL';
                          } else if (load.load_type === 'LTL') {
                            loadTypeDisplay = 'LTL';
                          } else if (load.load_type === 'Multi-Stop') {
                            loadTypeDisplay = 'Multi';
                          } else {
                            loadTypeDisplay = load.load_type;
                          }
                        }
                        
                        // Format distance
                        const distance = load.estimated_distance || load.distance;
                        const formattedDistance = distance ? (typeof distance === 'number' ? `${distance.toLocaleString()} mi` : `${distance} mi`) : 'N/A';
                        
                        return (
                        <div key={load.load_id} className="available-load-card">
                          <div className="available-load-card-main-grid">
                            <div className="available-load-id">#{load.load_id?.substring(0, 8) || 'N/A'}</div>
                            <div className="available-load-price">{formattedPrice}</div>
                            <div className="available-load-label">Pickup:</div>
                            <div className="available-load-value">{load.origin || 'N/A'}</div>
                            <div className="available-load-label">Delivery:</div>
                            <div className="available-load-value">{load.destination || 'N/A'}</div>
                            <div className="available-load-label">Due:</div>
                            <div className="available-load-due">{load.pickup_date || 'TBD'}</div>
                            <div className="available-load-label">Type:</div>
                            <div className="available-load-value">{loadTypeDisplay}</div>
                            <div className="available-load-label">Distance:</div>
                            <div className="available-load-value">{formattedDistance}</div>
                            <div className="available-load-label">Weight:</div>
                            <div className="available-load-value">{load.weight || 'N/A'} lbs</div>
                          </div>
                          <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {drivers.filter(d => d.assignLoad).map(driver => (
                              <button
                                key={driver.id}
                                className="btn small-cd"
                                onClick={() => handleAssignLoad(driver.id, load.load_id)}
                                disabled={assigningLoad === `${driver.id}-${load.load_id}`}
                              >
                                {assigningLoad === `${driver.id}-${load.load_id}` ? 'Assigning...' : `Assign to ${driver.name.split(' ')[0]}`}
                              </button>
                            ))}
                          </div>
                        </div>
                        );
                      })
                    )}
                  </div>
                  <div className="exception-handling-col">
                    <div className="exception-handling-title">Exception Handling</div>
                    {exceptions.length === 0 ? (
                      <div style={{ padding: '20px', color: '#666' }}>No active exceptions.</div>
                    ) : (
                      exceptions.map(ex => (
                        <div key={ex.id} className={`exception-card ${ex.tone}`}>
                          <div className="exception-card-header">
                            <span className="exception-icon"><i className={`fas ${ex.icon}`}></i></span>
                            <span>{ex.title}</span>
                            <span className="exception-time">{ex.time}</span>
                          </div>
                          <div className="exception-desc">{ex.desc}</div>
                          <div className="exception-actions">
                            <button className="btn small-cd" type="button" onClick={ex.primary.onClick}>{ex.primary.label}</button>
                            <button className="btn small ghost-cd" type="button" onClick={ex.secondary.onClick}>{ex.secondary.label}</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Recent Dispatch Activity */}
          {/* Stat Cards Row */}
          <div className="dispatch-metrics">
            <div className="dispatch-stat-card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',width:'100%'}}>
                <div>
                  <div className="dispatch-stat-num">{drivers.length}</div>
                  <div className="dispatch-stat-label">Active Drivers</div>
                </div>
                <div className="dispatch-stat-icon green">
                  <i className="fas fa-users"></i>
                </div>
              </div>
              <div className="dispatch-stat-sub green">Hired drivers in your fleet</div>
            </div>
            <div className="dispatch-stat-card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',width:'100%'}}>
                <div>
                  <div className="dispatch-stat-num">{drivers.filter(d => d.status === 'Available').length}</div>
                  <div className="dispatch-stat-label">Available</div>
                </div>
                <div className="dispatch-stat-icon blue">
                  <i className="fas fa-user"></i>
                </div>
              </div>
              <div className="dispatch-stat-sub blue">Ready for assignment</div>
            </div>
            <div className="dispatch-stat-card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',width:'100%'}}>
                <div>
                  <div className="dispatch-stat-num">{activeLoads.length}</div>
                  <div className="dispatch-stat-label">Active Loads</div>
                </div>
                <div className="dispatch-stat-icon purple">
                  <i className="fas fa-box"></i>
                </div>
              </div>
              <div className="dispatch-stat-sub purple">{pendingAssignmentLoads.length} pending assignment</div>
            </div>
            <div className="dispatch-stat-card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',width:'100%'}}>
                <div>
                  <div className="dispatch-stat-num">{onTimeRatePct === null ? '—' : `${onTimeRatePct}%`}</div>
                  <div className="dispatch-stat-label">On-Time Rate</div>
                </div>
                <div className="dispatch-stat-icon green">
                  <i className="fas fa-clock"></i>
                </div>
              </div>
              <div className="dispatch-stat-sub green">Based on delivered/completed loads with timestamps</div>
            </div>
            <div className="dispatch-stat-card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',width:'100%'}}>
                <div>
                  <div className="dispatch-stat-num">{exceptions.length}</div>
                  <div className="dispatch-stat-label">Active Alerts</div>
                </div>
                <div className="dispatch-stat-icon red">
                  <i className="fas fa-triangle-exclamation"></i>
                </div>
              </div>
              <div className="dispatch-stat-sub red">Derived from driver/load signals</div>
            </div>
          </div>
          <div className="dispatch-section recent-activity">
            <h3>
              Recent Dispatch Activity
              <button className="btn-view-all" type="button" onClick={() => setShowAllActivity(v => !v)}>{showAllActivity ? 'Show Less' : 'View All Activity'}</button>
            </h3>
            <div className="activity-list">
              {activityItems.length === 0 ? (
                <div style={{ padding: '16px', color: '#666' }}>No activity to show.</div>
              ) : (
                activityItems.map(a => (
                  <div className="dispatch-activity-item" key={a.id}>
                    <span className={`activity-icon ${a.kind}`}>
                      <i className={`fas ${a.icon}`}></i>
                    </span>
                    <div className="activity-content">
                      <div>{a.text}</div>
                      <div className="activity-meta">{a.meta}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showAddDriverModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add Driver"
          onClick={handleCloseAddDriverModal}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: '16px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '760px',
              maxHeight: '80vh',
              overflow: 'auto',
              borderRadius: '14px',
              background: '#ffffff',
              border: '1px solid #e5e7eb',
              boxShadow: '0 25px 45px rgba(15, 23, 42, 0.2)',
              padding: '18px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' }}>
              <div>
                <h3 style={{ margin: 0 }}>Add Driver</h3>
                <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: '13px' }}>
                  Send a hire request. The driver must accept before joining your fleet.
                </p>
              </div>
              <button type="button" className="btn small ghost-cd" onClick={handleCloseAddDriverModal}>Close</button>
            </div>

            {marketplaceDriversError && (
              <div style={{ marginBottom: '10px', padding: '10px 12px', borderRadius: '8px', background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                {marketplaceDriversError}
              </div>
            )}

            {marketplaceDriversLoading ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#334155' }}>Loading available drivers...</div>
            ) : marketplaceDrivers.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>No available drivers found right now.</div>
            ) : (
              <div style={{ display: 'grid', gap: '10px' }}>
                {marketplaceDrivers.map((driver) => {
                  const rawName = String(driver?.name || driver?.full_name || '').trim();
                  const name = rawName || 'Unknown Driver';
                  const location = String(driver?.current_location || driver?.current_city || driver?.location || 'Unknown').trim();
                  const cdl = String(driver?.cdl_class || 'N/A').trim();
                  const itemId = String(driver?.id || '').trim();

                  return (
                    <div
                      key={itemId || name}
                      style={{
                        border: '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{name}</div>
                        <div style={{ fontSize: '13px', color: '#475569' }}>Location: {location} | CDL: {cdl}</div>
                      </div>
                      <button
                        type="button"
                        className="btn small-cd"
                        onClick={() => handleSendHireRequest({ ...driver, id: itemId, name })}
                        disabled={!itemId || driverRequestingId === itemId}
                      >
                        {driverRequestingId === itemId ? 'Sending...' : 'Send Request'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DriversAndDispatches;