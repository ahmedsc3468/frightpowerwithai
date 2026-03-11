import React, { useEffect, useMemo, useState } from 'react';
import JSZip from 'jszip';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import '../../styles/carrier/Analytics.css';

const Analytics = () => {
  const { currentUser } = useAuth();
  const [timeRange, setTimeRange] = useState('Last 30 Days');
  const [loading, setLoading] = useState(true);
  const [exportingAll, setExportingAll] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState(null);

  const charts = payload?.charts || {};

  const analyticsData = useMemo(() => {
    const stats = payload?.stats || {};

    const nonEmpty = (v, fallback) => {
      if (v === null || v === undefined) return fallback;
      const s = String(v);
      return s.trim() ? s : fallback;
    };

    const pctLabel = nonEmpty(
      stats.on_time_percent_label,
      Number.isFinite(Number(stats.on_time_percent)) ? `${Number(stats.on_time_percent).toFixed(1)}%` : '0.0%'
    );

    const avgRpmLabel = nonEmpty(
      stats.avg_rpm_label,
      Number.isFinite(Number(stats.avg_rpm)) ? `$${Number(stats.avg_rpm).toFixed(2)}` : '$0.00'
    );

    const avgRpuLabel = nonEmpty(
      stats.avg_rpu_label,
      Number.isFinite(Number(stats.avg_rpu)) ? `$${Number(stats.avg_rpu).toFixed(0)}` : '$0'
    );

    return {
      loadsTendered: { value: stats.loads_tendered ?? 0, icon: 'fa-solid fa-truck' },
      accepted: { value: stats.accepted ?? 0, icon: 'fa-solid fa-check' },
      delivered: { value: stats.delivered ?? 0, icon: 'fa-solid fa-box' },
      onTimePercent: { value: pctLabel, icon: 'fa-solid fa-circle-dot' },
      avgRpm: { value: avgRpmLabel, icon: 'fa-solid fa-dollar-sign' },
      avgRpu: { value: avgRpuLabel, icon: 'fa-solid fa-calendar' },
    };
  }, [payload]);

  const timeRanges = ['Last 7 Days', 'Last 30 Days', 'Last 90 Days', 'This Year', 'Custom Range'];

  useEffect(() => {
    if (!currentUser) return;

    const fetchAnalytics = async () => {
      setLoading(true);
      setError('');
      try {
        const token = await currentUser.getIdToken();
        const url = `${API_URL}/carrier/analytics?time_range=${encodeURIComponent(timeRange)}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Request failed (${res.status})`);
        }
        const data = await res.json();
        setPayload(data);
      } catch (e) {
        setError(e?.message || 'Failed to load analytics');
        setPayload(null);
      } finally {
        setLoading(false);
      }
    };

    fetchAnalytics();
  }, [currentUser, timeRange]);

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const escapeCsv = (value) => {
    if (value === null || value === undefined) return '';
    let s = String(value);
    if (s.includes('"')) s = s.replace(/"/g, '""');
    if (/[",\n\r]/.test(s)) return `"${s}"`;
    return s;
  };

  const arrayToCsv = (rows, columns) => {
    const header = columns.map(escapeCsv).join(',');
    const lines = rows.map((row) => columns.map((c) => escapeCsv(row?.[c])).join(','));
    return [header, ...lines].join('\n');
  };

  const exportChartCsv = (kind) => {
    const today = new Date().toISOString().slice(0, 10);

    if (kind === 'on_time') {
      const rows = Array.isArray(charts.on_time_series) ? charts.on_time_series : [];
      const csv = arrayToCsv(rows, ['date', 'on_time_pct', 'delivered']);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `on_time_performance_${today}.csv`);
      return;
    }

    if (kind === 'region') {
      const rows = Array.isArray(charts.loads_by_region) ? charts.loads_by_region : [];
      const csv = arrayToCsv(rows, ['region', 'loads']);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `loads_by_region_${today}.csv`);
      return;
    }

    if (kind === 'distribution') {
      const rows = Array.isArray(charts.load_distribution) ? charts.load_distribution : [];
      const csv = arrayToCsv(rows, ['status', 'loads']);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `load_distribution_${today}.csv`);
    }
  };

  const exportAll = async () => {
    setExportingAll(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const zip = new JSZip();

      const statsRows = [
        { metric: 'Loads Tendered', value: analyticsData.loadsTendered.value },
        { metric: 'Accepted', value: analyticsData.accepted.value },
        { metric: 'Delivered', value: analyticsData.delivered.value },
        { metric: 'On-Time %', value: analyticsData.onTimePercent.value },
        { metric: 'Avg. RPM', value: analyticsData.avgRpm.value },
        { metric: 'Avg. RPU', value: analyticsData.avgRpu.value },
        { metric: 'Time Range', value: payload?.time_range || timeRange },
      ];
      zip.file('stats.csv', arrayToCsv(statsRows, ['metric', 'value']));

      zip.file('on_time_performance.csv', arrayToCsv(Array.isArray(charts.on_time_series) ? charts.on_time_series : [], ['date', 'on_time_pct', 'delivered']));
      zip.file('loads_by_region.csv', arrayToCsv(Array.isArray(charts.loads_by_region) ? charts.loads_by_region : [], ['region', 'loads']));
      zip.file('load_distribution.csv', arrayToCsv(Array.isArray(charts.load_distribution) ? charts.load_distribution : [], ['status', 'loads']));

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `analytics_export_${today}.zip`);
    } finally {
      setExportingAll(false);
    }
  };

  const pieColors = ['#0ea5e9', '#3B57A7', '#94a3b8', '#1e293b', '#64748b', '#475569'];

  return (
    <div className="analytics-container">
      {/* Header */}
      <div className="analytics-header">
        <div className="header-content">
          <h1>Analytics & Reports</h1>
          <p className="header-subtitle">Track operational performance, financial health, and compliance trends</p>
        </div>
        <div className="header-actions">
          <select 
            value={timeRange} 
            onChange={(e) => setTimeRange(e.target.value)}
            className="time-range-select" style={{borderRadius: "100px"}}
          >
            {timeRanges.map(range => (
              <option key={range} value={range}>{range}</option>
            ))}
          </select>
          <button className="btn small ghost-cd export-all-btn" onClick={exportAll} disabled={loading || exportingAll}>
            <i className="fa-solid fa-download"></i>
            {exportingAll ? 'Exporting…' : 'Export All'}
          </button>
        </div>
      </div>

      {/* Dashboard Content Only (Tabs Removed) */}
      <div className="dashboard-content">
        {/* Statistics Cards */}
        <div className="cd-analytics-stats-grid">
          <div className="cd-analytics-stat-card">
            <div className="cd-analytics-stat-icon">
              <i className={analyticsData.loadsTendered.icon}></i>
            </div>
            <div className="cd-analytics-stat-info">
              <div className="cd-analytics-stat-value">{loading ? '—' : analyticsData.loadsTendered.value}</div>
              <div className="cd-analytics-stat-label">Loads Tendered</div>
            </div>
          </div>

          <div className="cd-analytics-stat-card">
            <div className="cd-analytics-stat-icon">
              <i className={analyticsData.accepted.icon}></i>
            </div>
            <div className="cd-analytics-stat-info">
              <div className="cd-analytics-stat-value">{loading ? '—' : analyticsData.accepted.value}</div>
              <div className="cd-analytics-stat-label">Accepted</div>
            </div>
          </div>

          <div className="cd-analytics-stat-card">
            <div className="cd-analytics-stat-icon">
              <i className={analyticsData.delivered.icon}></i>
            </div>
            <div className="cd-analytics-stat-info">
              <div className="cd-analytics-stat-value">{loading ? '—' : analyticsData.delivered.value}</div>
              <div className="cd-analytics-stat-label">Delivered</div>
            </div>
          </div>

          <div className="cd-analytics-stat-card">
            <div className="cd-analytics-stat-icon">
              <i className={analyticsData.onTimePercent.icon}></i>
            </div>
            <div className="cd-analytics-stat-info">
              <div className="cd-analytics-stat-value">{loading ? '—' : analyticsData.onTimePercent.value}</div>
              <div className="cd-analytics-stat-label">On-Time %</div>
            </div>
          </div>

          <div className="cd-analytics-stat-card">
            <div className="cd-analytics-stat-icon">
              <i className={analyticsData.avgRpm.icon}></i>
            </div>
            <div className="cd-analytics-stat-info">
              <div className="cd-analytics-stat-value">{loading ? '—' : analyticsData.avgRpm.value}</div>
              <div className="cd-analytics-stat-label">Avg. RPM</div>
            </div>
          </div>

          <div className="cd-analytics-stat-card">
            <div className="cd-analytics-stat-icon">
              <i className={analyticsData.avgRpu.icon}></i>
            </div>
            <div className="cd-analytics-stat-info">
              <div className="cd-analytics-stat-value">{loading ? '—' : analyticsData.avgRpu.value}</div>
              <div className="cd-analytics-stat-label">Avg. RPU</div>
            </div>
          </div>
        </div>

        {!!error && (
          <div className="chart-placeholder" style={{ padding: '16px 24px', minHeight: 'unset' }}>
            <p style={{ margin: 0 }}>{error}</p>
          </div>
        )}

        {/* Charts Section */}
        <div className="charts-grid">
          <div className="chart-card">
            <div className="chart-header">
              <h3>On-Time Performance</h3>
              <button className="export-chart-btn" onClick={() => exportChartCsv('on_time')} disabled={loading}>
                Export
              </button>
            </div>
            {loading ? (
              <div className="chart-placeholder">
                <div className="chart-icon">
                  <i className="fa-solid fa-chart-line"></i>
                </div>
                <p>Loading…</p>
              </div>
            ) : (Array.isArray(charts.on_time_series) && charts.on_time_series.length > 0) ? (
              <div style={{ height: 240, padding: '12px 16px 20px 16px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={charts.on_time_series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="on_time_pct" stroke="#0ea5e9" strokeWidth={2} dot={false} isAnimationActive />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="chart-placeholder">
                <div className="chart-icon">
                  <i className="fa-solid fa-chart-line"></i>
                </div>
                <p>No delivered loads in this range</p>
              </div>
            )}
          </div>

          <div className="chart-card">
            <div className="chart-header">
              <h3>Loads by Region</h3>
              <button className="export-chart-btn" onClick={() => exportChartCsv('region')} disabled={loading}>
                Export
              </button>
            </div>
            {loading ? (
              <div className="chart-placeholder">
                <div className="chart-icon">
                  <i className="fa-solid fa-map"></i>
                </div>
                <p>Loading…</p>
              </div>
            ) : (Array.isArray(charts.loads_by_region) && charts.loads_by_region.length > 0) ? (
              <div style={{ height: 240, padding: '12px 16px 20px 16px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={charts.loads_by_region} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="region" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="loads" fill="#3B57A7" isAnimationActive radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="chart-placeholder">
                <div className="chart-icon">
                  <i className="fa-solid fa-map"></i>
                </div>
                <p>No loads in this range</p>
              </div>
            )}
          </div>

          <div className="chart-card">
            <div className="chart-header">
              <h3>Load Distribution</h3>
              <button className="export-chart-btn" onClick={() => exportChartCsv('distribution')} disabled={loading}>
                Export
              </button>
            </div>
            {loading ? (
              <div className="chart-placeholder">
                <div className="chart-icon">
                  <i className="fa-solid fa-chart-pie"></i>
                </div>
                <p>Loading…</p>
              </div>
            ) : (Array.isArray(charts.load_distribution) && charts.load_distribution.length > 0) ? (
              <div style={{ height: 240, padding: '12px 16px 20px 16px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip />
                    <Pie
                      data={charts.load_distribution}
                      dataKey="loads"
                      nameKey="status"
                      innerRadius={50}
                      outerRadius={85}
                      paddingAngle={2}
                      isAnimationActive
                    >
                      {charts.load_distribution.map((_, idx) => (
                        <Cell key={`cell-${idx}`} fill={pieColors[idx % pieColors.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="chart-placeholder">
                <div className="chart-icon">
                  <i className="fa-solid fa-chart-pie"></i>
                </div>
                <p>No loads in this range</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Analytics;