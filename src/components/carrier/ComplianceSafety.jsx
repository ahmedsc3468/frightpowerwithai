import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import '../../styles/carrier/ComplianceSafety.css';

export default function ComplianceSafety() {
  const { currentUser } = useAuth();
  const [selectedTask, setSelectedTask] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncSuccess, setSyncSuccess] = useState('');
  const [_lastSyncTime, setLastSyncTime] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [analyzingAI, setAnalyzingAI] = useState(false);

  const [basicScores, setBasicScores] = useState([]);
  const [basicHistory, setBasicHistory] = useState([]);
  const [basicLoading, setBasicLoading] = useState(false);
  const [basicError, setBasicError] = useState('');

  const buildBasicScoreCards = useCallback((derived) => {
    const categories = [
      { key: 'hos', name: 'Hours of Service', icon: 'fa-clock', defaultThreshold: 65 },
      { key: 'unsafe', name: 'Unsafe Driving', icon: 'fa-car-crash', defaultThreshold: 65 },
      { key: 'maintenance', name: 'Vehicle Maintenance', icon: 'fa-wrench', defaultThreshold: 80 },
      { key: 'crash', name: 'Crash Indicator', icon: 'fa-chart-line', defaultThreshold: 65 },
      { key: 'drug', name: 'Drugs/Alcohol', icon: 'fa-pills', defaultThreshold: 50 },
      { key: 'hazmat', name: 'HazMat', icon: 'fa-radiation', defaultThreshold: null },
    ];

    const safeDerived = (derived && typeof derived === 'object') ? derived : {};

    const classify = (percentile, threshold) => {
      if (percentile == null || threshold == null) return 'neutral';
      if (percentile >= threshold) return 'critical';
      if (percentile >= Math.round(threshold * 0.85)) return 'warning';
      return 'success';
    };

    return categories.map((c) => {
      const d = safeDerived[c.key] || {};
      const percentile = (typeof d.percentile === 'number') ? d.percentile : null;
      const threshold = (typeof d.threshold === 'number') ? d.threshold : c.defaultThreshold;

      return {
        name: c.name,
        score: (typeof percentile === 'number') ? `${percentile}%` : 'N/A',
        threshold: (typeof threshold === 'number') ? `${threshold}%` : 'Not Applicable',
        status: classify(percentile, threshold),
        icon: c.icon,
        _key: c.key,
        _percentile: percentile,
        _threshold: threshold,
      };
    });
  }, []);

  const fetchBasicScores = useCallback(async (token) => {
    setBasicLoading(true);
    setBasicError('');
    try {
      const res = await fetch(`${API_URL}/compliance/basic-scores`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to load BASIC scores');
      }
      const data = await res.json();
      const derived = data?.derived || {};
      setBasicScores(buildBasicScoreCards(derived));
      setBasicHistory(Array.isArray(data?.history) ? data.history : []);
    } catch (e) {
      console.warn('BASIC scores fetch warning:', e);
      setBasicError(e?.message || 'Unable to load BASIC scores');
      setBasicScores(buildBasicScoreCards({}));
      setBasicHistory([]);
    } finally {
      setBasicLoading(false);
    }
  }, [buildBasicScoreCards]);

  // Compliance data from API
  const [complianceData, setComplianceData] = useState({
    dotNumber: '',
    mcNumber: '',
    authorityType: 'Common Carrier',
    dotStatus: 'Pending',
    lastFmsaSync: 'Never synced',
    nextReview: 'Pending',
    auditTrial: 'View History',
    insuranceStatus: 'Unknown',
    insuranceExpiry: null,
    safetyRating: 'N/A'
  });

  const [complianceStatus, setComplianceStatus] = useState({
    score: 0,
    breakdown: {},
    status_color: 'Red',
    documents: [],
    issues: [],
    warnings: [],
    recommendations: []
  });

  const [complianceTasks, setComplianceTasks] = useState([]);

  // Fetch compliance data from API
  useEffect(() => {
    if (!currentUser) return;

    const fetchComplianceData = async () => {
      setLoading(true);
      try {
        const token = await currentUser.getIdToken();

        // Fetch compliance status
        const statusRes = await fetch(`${API_URL}/compliance/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (statusRes.ok) {
          const data = await statusRes.json();
          setComplianceStatus({
            score: data.compliance_score || 0,
            breakdown: data.score_breakdown || {},
            status_color: data.status_color || 'Red',
            documents: data.documents || [],
            issues: data.issues || [],
            warnings: data.warnings || [],
            recommendations: data.recommendations || []
          });

          // Set role-specific data - use extracted DOT/MC from top-level (from documents)
          setComplianceData(prev => ({
            ...prev,
            dotNumber: data.dot_number || prev.dotNumber,
            mcNumber: data.mc_number || prev.mcNumber,
            dotStatus: data.role_data?.fmcsa_verified ? 'Active' : 'Pending',
            insuranceStatus: data.role_data?.insurance_status || 'Unknown',
            insuranceExpiry: data.role_data?.insurance_expiry,
            safetyRating: data.role_data?.safety_rating || 'N/A'
          }));

          // Get FMCSA live info once we have DOT/MC (use extracted values)
          const dot = data.dot_number || complianceData.dotNumber;
          const mc = data.mc_number || complianceData.mcNumber;
          if (dot || mc) {
            await fetchFmcsaInfo(token, dot, mc);
          }

          // Fetch BASIC scores/trends (cached per-user on backend)
          await fetchBasicScores(token);
        }

        // Fetch compliance tasks
        const tasksRes = await fetch(`${API_URL}/compliance/tasks`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (tasksRes.ok) {
          const tasks = await tasksRes.json();
          setComplianceTasks(tasks);
        }
      } catch (error) {
        console.error('Error fetching compliance data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchComplianceData();
  }, [currentUser, fetchBasicScores]);

  // AI Analysis function
  const runAIAnalysis = async () => {
    if (!currentUser) return;
    setAnalyzingAI(true);

    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/compliance/ai-analyze`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.ok) {
        const data = await res.json();
        setAiAnalysis(data.analysis);
      }
    } catch (error) {
      console.error('AI analysis error:', error);
    } finally {
      setAnalyzingAI(false);
    }
  };

  // Function to sync FMCSA data
  const fetchFmcsaInfo = async (token, dotNumber, mcNumber) => {
    if (!dotNumber && !mcNumber) return;
    
    try {
      const response = await fetch(`${API_URL}/fmcsa/verify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          usdot: dotNumber,
          mc_number: mcNumber
        })
      });

      if (response.ok) {
        const data = await response.json();
        const now = new Date();
        setLastSyncTime(now);
        setComplianceData(prev => ({
          ...prev,
          dotStatus: data.result === 'Verified' ? 'Active' : data.result || prev.dotStatus,
          authorityType: data.operating_authority || data.authority_status || prev.authorityType,
          safetyRating: data.safety_rating || prev.safetyRating,
          mcNumber: data.mc_number || mcNumber || prev.mcNumber,
          dotNumber: data.usdot || dotNumber || prev.dotNumber,
          lastFmsaSync: `Today, ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
        }));
        setSyncSuccess('FMCSA data synced successfully!');
        setTimeout(() => setSyncSuccess(''), 5000);
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.warn('FMCSA sync warning:', errorData.detail || 'Unable to sync FMCSA data');
        // Don't throw - FMCSA sync is optional, continue with what we have
      }
    } catch (error) {
      console.warn('FMCSA fetch error (non-critical):', error);
      // Don't throw - FMCSA sync is optional, continue with what we have
    }
  };
    


  const handleFmcsaSync = async () => {
    if (!currentUser) return;
    setSyncing(true);
    setSyncError('');
    setSyncSuccess('');
    try {
      const token = await currentUser.getIdToken();
      await fetchFmcsaInfo(token, complianceData.dotNumber, complianceData.mcNumber);
      await fetchBasicScores(token);
    } catch (error) {
      console.error('FMCSA sync error:', error);
      const now = new Date();
      setComplianceData(prev => ({
        ...prev,
        lastFmsaSync: `Failed at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
      }));
      setSyncError('Failed to sync FMCSA data. Please check your DOT/MC numbers and try again.');
      setTimeout(() => setSyncError(''), 5000);
    } finally {
      setSyncing(false);
    }
  };

  // Use API data for AI score
  const aiScore = Math.round(complianceStatus.score);
  const scoreBreakdown = {
    documents: complianceStatus.breakdown.document_completeness || complianceStatus.breakdown.documents || 0,
    verification: complianceStatus.breakdown.data_accuracy || complianceStatus.breakdown.verification || 0,
    expiry_status: complianceStatus.breakdown.regulatory_compliance || complianceStatus.breakdown.expiry_status || 0,
    completeness: complianceStatus.breakdown.document_completeness || complianceStatus.breakdown.completeness || 0
  };

  const trendCategories = [
    { key: 'hos', name: 'Hours of Service' },
    { key: 'unsafe', name: 'Unsafe Driving' },
    { key: 'maintenance', name: 'Vehicle Maintenance' },
    { key: 'crash', name: 'Crash Indicator' },
    { key: 'drug', name: 'Drugs/Alcohol' },
    { key: 'hazmat', name: 'HazMat' },
  ];

  const getTrendPoints = (categoryKey) => {
    const items = Array.isArray(basicHistory) ? basicHistory : [];
    const last = items.slice(-6);
    return last.map((it) => {
      const derived = it?.derived || {};
      const d = derived?.[categoryKey] || {};
      const percentile = (typeof d.percentile === 'number') ? d.percentile : null;
      return {
        day: it?.day || '',
        percentile,
      };
    });
  };

  const trendDeltaText = (points) => {
    if (!Array.isArray(points) || points.length < 2) return '';
    const a = points[points.length - 2]?.percentile;
    const b = points[points.length - 1]?.percentile;
    if (typeof a !== 'number' || typeof b !== 'number') return '';
    const delta = b - a;
    if (delta === 0) return 'No change';
    return delta > 0 ? `+${delta}%` : `${delta}%`;
  };

  // Default tasks if API returns empty
  const defaultTasks = [
    {
      id: 'default-1',
      type: 'info',
      title: 'Complete Onboarding',
      description: 'Upload required documents to improve compliance score',
      actions: ['Go to Onboarding'],
      icon: 'fa-clipboard-list'
    }
  ];

  // Use API tasks or defaults
  const displayTasks = complianceTasks.length > 0 ? complianceTasks : defaultTasks;

  // Transform API documents to display format
  const complianceDocuments = (complianceStatus.documents || []).map(doc => {
    // Handle different possible field names from API
    const docType = doc.type || doc.filename || doc.id || 'Document';
    const displayName = String(docType).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    return {
      name: displayName,
      status: doc.is_expired ? 'missing' : doc.is_expiring_soon ? 'warning' : doc.status === 'valid' ? 'valid' : 'active',
      expires: doc.expiry_date ? new Date(doc.expiry_date).toLocaleDateString() : null
    };
  });

  const getStatusClass = (status) => {
    switch (status) {
      case 'success': return 'success';
      case 'warning': return 'warning';
      case 'critical': return 'critical';
      case 'neutral': return 'neutral';
      default: return '';
    }
  };

  return (
    <div className="compliance-safety">
      {/* Header */}
      <header className="compliance-header">
        <div className="header-content">
          <h1>Compliance & Safety</h1>
          <p className="header-subtitle">Monitor FMCSA compliance, safety ratings, and risk management</p>
        </div>
        <div className="header-actions">
          <button className="btn small-cd">
            <i className="fa-solid fa-camera" style={{color: 'white'}}></i>
            Available Snapshots
          </button>
          <button className="btn small-cd" onClick={handleFmcsaSync} disabled={syncing}>
            <i className={`fa-solid fa-sync ${syncing ? 'fa-spin' : ''}`} style={{color: 'white'}}></i>
            {syncing ? 'Syncing...' : 'Run Nightly Sync'}
          </button>
        </div>
      </header>

      {/* Loading State */}
      {loading && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '40px',
          color: '#6366f1'
        }}>
          <i className="fa-solid fa-spinner fa-spin" style={{fontSize: '2rem', marginRight: 12}}></i>
          <span>Loading compliance data...</span>
        </div>
      )}

      {/* Sync Status Messages */}
      {syncSuccess && (
        <div className="sync-message success" style={{
          background: '#d4edda',
          color: '#155724',
          padding: '10px 15px',
          borderRadius: '8px',
          margin: '0 0 15px 0',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <i className="fa-solid fa-check-circle"></i>
          {syncSuccess}
        </div>
      )}
      {syncError && (
        <div className="sync-message error" style={{
          background: '#f8d7da',
          color: '#721c24',
          padding: '10px 15px',
          borderRadius: '8px',
          margin: '0 0 15px 0',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <i className="fa-solid fa-exclamation-circle"></i>
          {syncError}
        </div>
      )}

      {/* Main Content Grid */}
      <div className="compliance-grid">
        {/* Left Column */}
        <div className="compliance-left">
          {/* Compliance Profile Overview */}
          <div className="compliance-card profile-overview">
            <h3>Compliance Profile Overview</h3>
            <div className="profile-details">
              <div className="profile-row">
                <span className="label">DOT Number</span>
                <span className="value">{complianceData.dotNumber}</span>
              </div>
              <div className="profile-row">
                <span className="label">MC Number</span>
                <span className="value">{complianceData.mcNumber}</span>
              </div>
              <div className="profile-row">
                <span className="label">Authority Type</span>
                <span className="value">{complianceData.authorityType}</span>
              </div>
              <div className="profile-row">
                <span className="label">DOT Status</span>
                <span className="value status active">{complianceData.dotStatus}</span>
              </div>
              <div className="profile-row">
                <span className="label">Insurance Status</span>
                <span className="value status expiring">Expiring 03/15/2025</span>
              </div>
              <div className="profile-row">
                <span className="label">Safety Rating</span>
                <span className="value status satisfactory">Satisfactory</span>
              </div>
              <div className="profile-row">
                <span className="label">Last FMCSA Sync</span>
                <span className="value">{complianceData.lastFmsaSync}</span>
              </div>
              <div className="profile-row">
                <span className="label">Next Review</span>
                <span className="value">{complianceData.nextReview}</span>
              </div>
              <div className="profile-row">
                <span className="label">Audit Trail</span>
                <span className="value link">{complianceData.auditTrial}</span>
              </div>
            </div>
          </div>

          {/* BASIC Scores */}
          <div className="compliance-card basic-scores">
            <h3>BASIC Scores</h3>
            <div className="scores-grid">
              {basicScores.map((score, index) => (
                <div key={index} className={`score-item ${getStatusClass(score.status)}`}>
                  <div className="score-header">
                    <i className={`fa-solid ${score.icon} score-icon`}></i>
                    <span className="score-name">{score.name}</span>
                    <i className={`fa-solid ${
                      score.status === 'success' ? 'fa-circle-check' : 
                      score.status === 'warning' ? 'fa-triangle-exclamation' : 
                      score.status === 'critical' ? 'fa-circle-xmark' :
                      'fa-circle-info'
                    } status-icon`}></i>
                  </div>
                  <div className="score-value">{score.score}</div>
                  <div className="score-threshold">Threshold: {score.threshold}</div>
                </div>
              ))}
            </div>
          </div>

          {/* BASIC Score Trends */}
          <div className="compliance-card score-trends">
            <h3>BASIC Score Trends</h3>
            {basicLoading ? (
              <div className="trends-placeholder">
                <i className="fa-solid fa-spinner fa-spin trend-icon"></i>
                <p>Loading score trends...</p>
              </div>
            ) : basicError ? (
              <div className="trends-placeholder">
                <i className="fa-solid fa-triangle-exclamation trend-icon"></i>
                <p>{basicError}</p>
              </div>
            ) : (Array.isArray(basicHistory) && basicHistory.length > 0) ? (
              <div className="basic-trends">
                {trendCategories.map((cat) => {
                  const points = getTrendPoints(cat.key);
                  const delta = trendDeltaText(points);

                  return (
                    <div key={cat.key} className="trend-row">
                      <div className="trend-row-header">
                        <span className="trend-name">{cat.name}</span>
                        {delta ? <span className="trend-delta">{delta}</span> : null}
                      </div>
                      <div className="trend-bars" aria-label={`${cat.name} trend`}>
                        {points.map((p, idx) => {
                          const h = (typeof p.percentile === 'number') ? Math.max(0, Math.min(100, p.percentile)) : 0;
                          return (
                            <div
                              key={`${cat.key}-${idx}`}
                              className="trend-bar-wrap"
                              title={p.day ? `${p.day}: ${p.percentile == null ? 'N/A' : `${p.percentile}%`}` : (p.percentile == null ? 'N/A' : `${p.percentile}%`)}
                            >
                              <div className={`trend-bar ${p.percentile == null ? 'neutral' : ''}`} style={{ height: `${h}%` }} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="trends-placeholder">
                <i className="fa-solid fa-chart-line trend-icon"></i>
                <p>No trend history yet. Use “Run Nightly Sync” to start tracking.</p>
              </div>
            )}
          </div>

          {/* Compliance Tasks */}
          <div className="compliance-card compliance-tasks">
            <div className="tasks-header">
              <h3>Compliance Tasks</h3>
              <span className="task-count">{complianceTasks.length} Critical</span>
            </div>
            
            <div className="tasks-list">
              {displayTasks.map((task) => (
                <div key={task.id} className={`task-item ${task.type}`}>
                  <div className="task-icon">
                    <i className={`fa-solid ${task.icon}`}></i>
                  </div>
                  <div className="task-content">
                    <div className="task-title">{task.title}</div>
                    <div className="task-description">{task.description}</div>
                    <div className="task-actions">
                      {task.actions.map((action, idx) => (
                        <button key={idx} className="btn small ghost-cd">{action}</button>
                      ))}
                    </div>
                  </div>
                  <div className="task-time">
                    {task.type === 'critical' ? '2:45 PM' : '1:30 PM'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="compliance-right">
          {/* AI Compliance Score */}
          <div className="compliance-card ai-score">
            <h3>AI Compliance Score</h3>
            <div className="score-circle">
              <div className="score-progress">
                <svg viewBox="0 0 100 100" className="progress-ring">
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="8"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke={aiScore >= 80 ? '#22c55e' : aiScore >= 50 ? '#f59e0b' : '#dc2626'}
                    strokeWidth="8"
                    strokeDasharray={`${aiScore * 2.827} 282.7`}
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="score-number" style={{color: aiScore >= 80 ? '#22c55e' : aiScore >= 50 ? '#f59e0b' : '#dc2626'}}>{aiScore}</div>
                <div className="score-label">Score</div>
              </div>
            </div>
            <div className="score-breakdown">
              <div className="breakdown-item">
                <span className="breakdown-label">Document Completeness</span>
                <span className="breakdown-value">{Math.round(scoreBreakdown.documents)}%</span>
              </div>
              <div className="breakdown-item">
                <span className="breakdown-label">Data Accuracy</span>
                <span className="breakdown-value">{Math.round(scoreBreakdown.verification)}%</span>
              </div>
              <div className="breakdown-item">
                <span className="breakdown-label">Regulatory Compliance</span>
                <span className="breakdown-value">{Math.round(scoreBreakdown.expiry_status)}%</span>
              </div>
              <div className="breakdown-item">
                <span className="breakdown-label">Overall Completeness</span>
                <span className="breakdown-value">{Math.round(scoreBreakdown.completeness)}%</span>
              </div>
            </div>
            <button className="btn small-cd" style={{width: '100%'}} onClick={runAIAnalysis} disabled={analyzingAI}>
              <i className={`fa-solid fa-robot ${analyzingAI ? 'fa-spin' : ''}`} style={{marginRight: 8}}></i>
              {analyzingAI ? 'Analyzing...' : 'Get AI Analysis'}
            </button>

            {/* AI Analysis Results */}
            {aiAnalysis && (
              <div style={{marginTop: 16, padding: 12, background: '#f8fafc', borderRadius: 8}}>
                <div style={{fontWeight: 700, marginBottom: 8, color: '#1e293b'}}>
                  <i className="fa-solid fa-brain" style={{marginRight: 8, color: '#6366f1'}}></i>
                  AI Analysis
                </div>
                <p style={{fontSize: '0.9rem', color: '#475569', marginBottom: 8}}>{aiAnalysis.summary}</p>
                <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                  <span style={{fontSize: '0.85rem', fontWeight: 600}}>Risk Level:</span>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    background: aiAnalysis.risk_level === 'low' ? '#dcfce7' : aiAnalysis.risk_level === 'high' ? '#fee2e2' : '#fef3c7',
                    color: aiAnalysis.risk_level === 'low' ? '#166534' : aiAnalysis.risk_level === 'high' ? '#991b1b' : '#92400e'
                  }}>
                    {aiAnalysis.risk_level?.toUpperCase()}
                  </span>
                </div>
                {aiAnalysis.immediate_actions?.length > 0 && (
                  <div style={{marginTop: 8}}>
                    <div style={{fontSize: '0.85rem', fontWeight: 600, marginBottom: 4}}>Immediate Actions:</div>
                    <ul style={{margin: 0, paddingLeft: 20, fontSize: '0.85rem', color: '#64748b'}}>
                      {aiAnalysis.immediate_actions.slice(0, 3).map((action, i) => (
                        <li key={i}>{typeof action === 'string' ? action : action.title}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Compliance Documents */}
          <div className="compliance-card compliance-documents">
            <h3>Compliance Documents</h3>
            <div className="compliance-documents-list">
              {complianceDocuments.map((doc, index) => (
                <div key={index} className={`compliance-document-row ${doc.status}`} style={{boxShadow: 'none', border: 'none', margin: 0}}>
                  <i className={`fa-solid ${
                    doc.status === 'valid' ? 'fa-shield-halved' :
                    doc.status === 'active' ? 'fa-id-card' :
                    doc.status === 'warning' ? 'fa-sun' :
                    'fa-file-medical'
                  } doc-icon ${doc.status}`} style={{fontSize: 22, marginRight: 12}}></i>
                  <div className="document-details" style={{flex: 1}}>
                    <div className="document-name" style={{fontWeight: 700, color: '#222e3a', fontSize: '1rem', marginBottom: 2}}>{doc.name}</div>
                    {doc.expires && (
                      <div className="document-expires" style={{fontSize: '0.93rem', color: '#64748b'}}>
                        {doc.status === 'valid' ? 'Valid until' : 'Expires'} {doc.expires}
                      </div>
                    )}
                    {doc.status === 'active' && !doc.expires && (
                      <div className="document-status" style={{fontSize: '0.93rem', color: '#64748b'}}>Active</div>
                    )}
                    {doc.status === 'missing' && (
                      <div className="document-status missing">Missing</div>
                    )}
                  </div>
                  <i className={`fa-solid ${
                    doc.status === 'valid' ? 'fa-circle-check' :
                    doc.status === 'active' ? 'fa-circle-check' :
                    doc.status === 'warning' ? 'fa-triangle-exclamation' :
                    'fa-circle-xmark'
                  } doc-status-icon ${doc.status}`} style={{ marginLeft: 'auto', color: (
                    doc.status === 'valid' || doc.status === 'active' ? '#22c55e' :
                    doc.status === 'warning' ? '#f59e0b' : '#dc2626')}}></i>
                </div>
              ))}
            </div>
            <button className="btn small-cd"style={{width: '100%'}}>Go to Document Vault</button>
          </div>
        </div>
      </div>
    </div>
  );
}