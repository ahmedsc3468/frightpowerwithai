import React, { useEffect, useMemo, useState } from 'react';
import '../../styles/admin/TrackingVisibility.css';
import HereMap from '../common/HereMap';
import { getJson } from '../../api/http';

export default function TrackingVisibility() {
  const [activeTab, setActiveTab] = useState('all');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trackingMetrics, setTrackingMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(false);

  const roleFilter = useMemo(() => {
    if (activeTab === 'carriers') return 'carriers';
    if (activeTab === 'drivers') return 'drivers';
    if (activeTab === 'shippers') return 'shipper_broker';
    if (activeTab === 'providers') return 'providers';
    return 'all';
  }, [activeTab]);

  const roleColor = (role) => {
    const r = String(role || '').toLowerCase();
    if (r === 'driver' || r === 'drivers') return '#2563eb';
    if (r === 'carrier' || r === 'carriers') return '#10b981';
    if (r === 'shipper' || r === 'shippers') return '#a855f7';
    if (r === 'broker' || r === 'brokers' || r === 'shipper_broker') return '#f59e0b';
    return '#64748b';
  };

  const pinSvgDataUrl = (color) => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">
  <path fill="${color}" d="M12 2c-3.86 0-7 3.14-7 7 0 5.25 7 13 7 13s7-7.75 7-13c0-3.86-3.14-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/>
  <circle cx="12" cy="9" r="2.2" fill="#ffffff" opacity="0.9"/>
</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  };

  const mapMarkers = useMemo(() => {
    return (locations || [])
      .filter((it) => it && Number.isFinite(Number(it.gps_lat)) && Number.isFinite(Number(it.gps_lng)))
      .map((it) => {
        const color = roleFilter === 'all' ? roleColor(it.role) : roleColor(roleFilter);
        return {
          lat: Number(it.gps_lat),
          lng: Number(it.gps_lng),
          label: it.name || it.email || it.uid,
          icon: pinSvgDataUrl(color),
          role: it.role,
          uid: it.uid,
        };
      });
  }, [locations, roleFilter]);

  useEffect(() => {
    let cancelled = false;
    async function fetchMetrics() {
      setMetricsLoading(true);
      try {
        const data = await getJson('/admin/tracking/metrics', { timeoutMs: 20000 });
        if (!cancelled) setTrackingMetrics(data);
      } catch (_e) {
        if (!cancelled) setTrackingMetrics(null);
      } finally {
        if (!cancelled) setMetricsLoading(false);
      }
    }
    fetchMetrics();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  useEffect(() => {
    let cancelled = false;
    async function fetchLocations() {
      setLocationsLoading(true);
      try {
        if (roleFilter === 'providers') {
          if (!cancelled) setLocations([]);
          return;
        }
        const qs = new URLSearchParams({ role: roleFilter, limit: '2000' }).toString();
        const data = await getJson(`/admin/tracking/locations?${qs}`, { timeoutMs: 25000 });
        if (!cancelled) setLocations(Array.isArray(data?.items) ? data.items : []);
      } catch (_e) {
        if (!cancelled) setLocations([]);
      } finally {
        if (!cancelled) setLocationsLoading(false);
      }
    }
    fetchLocations();
    return () => {
      cancelled = true;
    };
  }, [roleFilter, refreshNonce]);

  const renderFeedItems = () => {
    // Simple switch to show different sample feeds per tab
    if (activeTab === 'carriers') return [
      { title: 'Alpha Freight', meta: '2m ago', tags: ['Carrier','Warning'] }
    ];
    if (activeTab === 'shippers') return [
      { title: 'Midwest Trans', meta: '5m ago', tags: ['Broker','Critical'] }
    ];
    if (activeTab === 'drivers') return [
      { title: 'Driver Ahmed', meta: '10m ago', tags: ['Driver','Needed'] }
    ];
    return [
      { title: 'Alpha Freight', meta: '2m ago', tags: ['Carrier','Warning'] },
      { title: 'Midwest Trans', meta: '5m ago', tags: ['Broker','Critical'] },
      { title: 'Driver Ahmed', meta: '10m ago', tags: ['Driver','Needed'] }
    ];
  };

  const feedItems = renderFeedItems();

  return (
    <div className="admin-tracking-root">
      <div className="tracking-controls">
        <div className="filter-row controls">
          <select className="select" aria-label="Tenant">
            <option>All Tenants</option>
            <option>Alpha Freight</option>
            <option>Midwest Trans</option>
          </select>
          <select className="select" aria-label="Status">
            <option>All Status</option>
            <option>Active</option>
            <option>At Risk / Delayed</option>
          </select>
          <select className="select" aria-label="Region">
            <option>All Regions</option>
            <option>North America</option>
            <option>Europe</option>
          </select>
          <button
            className="btn small-cd refresh-btn"
            aria-label="Refresh"
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            ⟳
          </button>
        </div>

        <div className="tabs" style={{marginTop: "15px", marginBottom: "15px"}}>
          <button className={`tab ${activeTab === 'all' ? 'active' : ''}`} onClick={() => setActiveTab('all')}>All Activity</button>
          <button className={`tab ${activeTab === 'carriers' ? 'active' : ''}`} onClick={() => setActiveTab('carriers')}>Carriers</button>
          <button className={`tab ${activeTab === 'shippers' ? 'active' : ''}`} onClick={() => setActiveTab('shippers')}>Shippers/Brokers</button>
          <button className={`tab ${activeTab === 'drivers' ? 'active' : ''}`} onClick={() => setActiveTab('drivers')}>Drivers</button>
          <button className={`tab ${activeTab === 'providers' ? 'active' : ''}`} onClick={() => setActiveTab('providers')}>Service Providers</button>
        </div>
      </div>

      <div className="stats-row">
        <div className="card stat">
          <div className="stat-num">{metricsLoading ? '…' : (trackingMetrics?.active_loads ?? 0)}</div>
          <div className="stat-label">Active Loads</div>
        </div>
        <div className="card stat">
          <div className="stat-num nil">Nil</div>
          <div className="stat-label">At Risk / Delayed</div>
        </div>
        <div className="card stat">
          <div className="stat-num">{metricsLoading ? '…' : (trackingMetrics?.missing_documents ?? 0)}</div>
          <div className="stat-label">Missing Documents</div>
        </div>
        <div className="card stat">
          <div className="stat-num">{metricsLoading ? '…' : (trackingMetrics?.drivers_offline ?? 0)}</div>
          <div className="stat-label">Drivers Offline</div>
        </div>
        <div className="card stat">
          <div className="stat-num nil">Nil</div>
          <div className="stat-label">Provider Errors</div>
        </div>
        <div className="card stat">
          <div className="stat-num nil">Nil</div>
          <div className="stat-label">AI Health Score</div>
        </div>
      </div>

      <div className="tracking-grid">
        <div className="map-card card">
          <div className="card-row"><h3>Live Map</h3></div>
          <HereMap
            containerId="super-admin-tracking-map"
            center={{ lat: 39.8283, lng: -98.5795 }}
            zoom={4}
            markers={mapMarkers}
            height="500px"
            width="100%"
          />
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {locationsLoading ? 'Loading locations…' : `Showing ${mapMarkers.length} user location(s)${roleFilter !== 'all' ? ` for ${activeTab}` : ''}.`}
          </div>
        </div>

        <aside className="feed-card card">
          <div className="card-row"><h3>Live Activity Feed <div><span className="muted">Last updated: 2 minutes ago</span></div></h3></div>
          <div className="feed-inner">
            <ul className="feed-list">
              {feedItems.map((it, idx) => (
                <li key={idx} className="feed-item">
                  <div>
                    <strong>{it.title}</strong>
                    <div className="muted">{it.meta}</div>
                  </div>
                  <div className="feed-tags">
                    {it.tags.map((t, i) => (
                      <span key={i} className={`int-status-badge ${t.toLowerCase() === 'warning' ? 'disconnected' : t.toLowerCase() === 'critical' ? 'disconnected' : t.toLowerCase() === 'needed' ? 'pending' : 'blue'}`}>{t}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <div className="bottom-summary card">
        <div className="summary-text">Today's AI Summary — 8 delays (+3 from yesterday), 2 offline drivers, 1 integration issue. Average ETA accuracy 92%.</div>
        <button className="btn small-cd">View Analytics</button>
      </div>
    </div>
  );
}
