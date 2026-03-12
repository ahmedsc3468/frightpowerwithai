import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../../config';
import { AUTO_REFRESH_MS } from '../../constants/refresh';
import TrackingVisibility from './TrackingVisibility';
import DocumentVault from './DocumentVault';
import Finance from './Finance';
import Messaging from './Messaging';
import '../../styles/carrier/CarrierDashboard.css';
import '../../styles/shipper/ShipperDashboard.css';
import MyCarriers from './MyCarriers';
import ShipperMarketplace from './ShipperMarketplace';
import ComplianceOverview from './ComplianceOverview';
import AiHub from './AiHub';
import ShipperAnalytics from './Analytics';
import Settings from './Settings';
import AddLoads from '../carrier/AddLoads';
import DraftLoadsModal from './DraftLoadsModal';
import InviteCarrierModal from './InviteCarrierModal';
import CarrierBids from './CarrierBids';
import ShipperMyLoads from './MyLoads';
import Bills from './Bills';
import AlertsNotifications from '../carrier/AlertsNotifications';
import ShipperProfile from './ShipperProfile';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { t } from '../../i18n/translate';
import '../../styles/shipper/InviteCarrierModal.css';
// OnboardingCoach removed - compliance data now shown in Compliance & Safety page
import logo from '/src/assets/logo.png';
import resp_logo from '/src/assets/logo_1.png';

export default function ShipperDashboard() {
  const { currentUser, logout } = useAuth();
  const { settings } = useUserSettings();
  const language = settings?.language || 'English';
  const navigate = useNavigate();
  const location = useLocation();
  const [activeNav, setActiveNav] = useState('home');
  const [trackingInitialLoadId, setTrackingInitialLoadId] = useState(null);
  const [initialThreadId, setInitialThreadId] = useState(null);
  const [initialInvoiceId, setInitialInvoiceId] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarDark, setIsSidebarDark] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Messaging unread badge
  const [messagingUnread, setMessagingUnread] = useState(0);

  // In-app notifications
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifUnread, setNotifUnread] = useState(0);
  const [notifItems, setNotifItems] = useState([]);

  // Deep-link support (email links): /shipper-dashboard?nav=messaging&thread=<threadId>
  useEffect(() => {
    try {
      const qs = new URLSearchParams(location.search || '');
      const nav = (qs.get('nav') || qs.get('section') || '').trim();
      const thread = (qs.get('thread') || qs.get('thread_id') || '').trim();
      const invoiceId = (qs.get('invoice_id') || qs.get('invoice') || '').trim();
      if (thread) {
        setInitialThreadId(thread);
        setActiveNav('messaging');
        return;
      }
      if (invoiceId) {
        setInitialInvoiceId(invoiceId);
        setActiveNav('bills');
        return;
      }
      if (nav) setActiveNav(nav);
    } catch {
      // ignore
    }
  }, [location.search]);

  const fetchNotifications = async () => {
    if (!currentUser) return;
    setNotifLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/notifications?page=1&page_size=20`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      setNotifItems(Array.isArray(data?.notifications) ? data.notifications : []);
      setNotifUnread(Number(data?.unread_count || 0));
    } catch {
      // ignore
    } finally {
      setNotifLoading(false);
    }
  };

  // Keep unread count fresh (so new bids show up without opening the dropdown).
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      try {
        await fetchNotifications();
      } catch {
        // ignore
      }
    };

    // Initial fetch + poll
    tick();
    const id = setInterval(tick, AUTO_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [currentUser]);

  const markNotificationRead = async (notificationId) => {
    if (!currentUser || !notificationId) return;
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/notifications/${encodeURIComponent(notificationId)}/mark-read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) return;
      setNotifItems((prev) => (prev || []).map((n) => (n?.id === notificationId ? { ...n, is_read: true } : n)));
      setNotifUnread((prev) => Math.max(0, Number(prev || 0) - 1));
    } catch {
      // ignore
    }
  };

  const handleNotifToggle = async () => {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next) {
      await fetchNotifications();
    }
  };

  const handleNotifAction = async (n) => {
    const id = String(n?.id || '').trim();
    const actionUrl = String(n?.action_url || '').trim();
    if (id && !n?.is_read) {
      // Best-effort
      markNotificationRead(id);
    }
    if (actionUrl) {
      setNotifOpen(false);
      navigate(actionUrl);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!notifOpen) return;
    const onDocClick = (e) => {
      const el = e?.target;
      if (!el) return;
      const root = document.getElementById('fp-notif-dropdown-root');
      if (root && root.contains(el)) return;
      setNotifOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [notifOpen]);

  // Onboarding data state
  const [shipperProfile, setShipperProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Dashboard stats state
  const [dashboardStats, setDashboardStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [shipperInsights, setShipperInsights] = useState(null);
  const [shipperInsightsLoading, setShipperInsightsLoading] = useState(false);
  const [shipperInsightsError, setShipperInsightsError] = useState('');
  const shipperInsightsAbortRef = React.useRef(null);

  // Home "Active Loads" list data (kept lightweight; Tracking page fetches full view)
  const [homeLoadsLoading, setHomeLoadsLoading] = useState(false);
  const [homeLoadsError, setHomeLoadsError] = useState('');
  const [homeLoads, setHomeLoads] = useState([]);
  const [homeCarriersLoading, setHomeCarriersLoading] = useState(false);
  const [homeCarriers, setHomeCarriers] = useState([]);
  const [homeComplianceLoading, setHomeComplianceLoading] = useState(false);
  const [homeCompliance, setHomeCompliance] = useState(null);

  // AddLoads modal state
  const [showAddLoads, setShowAddLoads] = useState(false);
  const [editingDraftLoad, setEditingDraftLoad] = useState(null);

  // Draft loads modal state
  const [showDraftLoadsModal, setShowDraftLoadsModal] = useState(false);

  // Invite Carrier modal state
  const [isInviteCarrierOpen, setIsInviteCarrierOpen] = useState(false);

  // File upload ref
  const fileInputRef = React.useRef(null);

  // Handle file upload
  const handleFileUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setStatsLoading(true);
    
    try {
      const token = await currentUser.getIdToken();
      
      for (const file of files) {
        // Create FormData for file upload
        const formData = new FormData();
        formData.append('file', file);
        
        console.log(`Uploading: ${file.name}...`);
        
        const response = await fetch(`${API_URL}/documents`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: formData
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log('✅ Upload successful:', data);
          alert(`Document "${file.name}" uploaded successfully!\nType: ${data.doc_type}\nValidation: ${data.validation.status}`);
        } else {
          const error = await response.json();
          console.error('Upload failed:', error);
          alert(`Failed to upload "${file.name}": ${error.detail || 'Unknown error'}`);
        }
      }
      
      // Refresh dashboard stats after all uploads
      await fetchStats();
      
    } catch (err) {
      console.error('Error uploading documents:', err);
      alert('Error uploading documents. Please try again.');
    } finally {
      setStatsLoading(false);
      // Clear the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Fetch dashboard stats
  const fetchStats = async () => {
    if (!currentUser) {
      setStatsLoading(false);
      return;
    }
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/dashboard/stats`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      if (response.ok) {
        const data = await response.json();
        setDashboardStats(data);
      }
    } catch (error) {
      console.error('Error fetching dashboard stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchHomeLoads = async () => {
    if (!currentUser) return;
    setHomeLoadsLoading(true);
    setHomeLoadsError('');
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/loads?exclude_drafts=true&page=1&page_size=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setHomeLoads([]);
        setHomeLoadsError('Failed to load shipments');
        return;
      }
      const data = await res.json();
      setHomeLoads(Array.isArray(data?.loads) ? data.loads : []);
    } catch (e) {
      setHomeLoads([]);
      setHomeLoadsError(e?.message || 'Failed to load shipments');
    } finally {
      setHomeLoadsLoading(false);
    }
  };

  const fetchHomeCarriers = async () => {
    if (!currentUser) return;
    setHomeCarriersLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/carriers/my-carriers`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        setHomeCarriers([]);
        return;
      }
      const data = await res.json();
      setHomeCarriers(Array.isArray(data?.carriers) ? data.carriers : []);
    } catch (error) {
      console.error('Error fetching carriers for dashboard:', error);
      setHomeCarriers([]);
    } finally {
      setHomeCarriersLoading(false);
    }
  };

  const fetchHomeCompliance = async () => {
    if (!currentUser) return;
    setHomeComplianceLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/compliance/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        setHomeCompliance(null);
        return;
      }
      const data = await res.json();
      setHomeCompliance(data || null);
    } catch (error) {
      console.error('Error fetching compliance summary for dashboard:', error);
      setHomeCompliance(null);
    } finally {
      setHomeComplianceLoading(false);
    }
  };

  // Handle editing draft loads
  const handleEditDraft = (draftLoad) => {
    setEditingDraftLoad(draftLoad);
    setShowAddLoads(true);
  };

  // Fetch dashboard stats
  useEffect(() => {
    fetchStats();
  }, [currentUser]);

  useEffect(() => {
    let alive = true;
    if (!currentUser || activeNav !== 'home') {
      if (shipperInsightsAbortRef.current) {
        shipperInsightsAbortRef.current.abort();
        shipperInsightsAbortRef.current = null;
      }
      return;
    }

    const fetchShipperInsights = async () => {
      if (shipperInsightsAbortRef.current) {
        shipperInsightsAbortRef.current.abort();
      }
      const controller = new AbortController();
      shipperInsightsAbortRef.current = controller;
      setShipperInsightsLoading(true);
      setShipperInsightsError('');
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`${API_URL}/shipper/dashboard/insights`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!alive) return;
          setShipperInsightsError(String(body?.detail || 'Failed to load shipper insights'));
          return;
        }
        const data = await res.json();
        if (!alive) return;
        setShipperInsights(data || null);
      } catch (e) {
        if (e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('request cancelled')) {
          return;
        }
        if (!alive) return;
        setShipperInsightsError(String(e?.message || 'Failed to load shipper insights'));
      } finally {
        if (shipperInsightsAbortRef.current === controller) {
          shipperInsightsAbortRef.current = null;
        }
        if (alive) setShipperInsightsLoading(false);
      }
    };

    fetchShipperInsights();
    const onFocus = () => fetchShipperInsights();
    const onVisibility = () => {
      if (!document.hidden) fetchShipperInsights();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const id = setInterval(() => {
      if (!document.hidden && activeNav === 'home') fetchShipperInsights();
    }, 60000);

    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(id);
      if (shipperInsightsAbortRef.current) {
        shipperInsightsAbortRef.current.abort();
        shipperInsightsAbortRef.current = null;
      }
    };
  }, [activeNav, currentUser]);

  // Fetch a small set of loads used by the Home placeholders.
  useEffect(() => {
    fetchHomeLoads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  useEffect(() => {
    fetchHomeCarriers();
    fetchHomeCompliance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // Fetch onboarding data on mount
  useEffect(() => {
    const fetchProfile = async () => {
      if (!currentUser) {
        setProfileLoading(false);
        return;
      }
      try {
        const token = await currentUser.getIdToken();
        const response = await fetch(`${API_URL}/onboarding/data`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });
        if (response.ok) {
          const data = await response.json();
          setShipperProfile(data);
        }
      } catch (error) {
        console.error('Error fetching profile:', error);
      } finally {
        setProfileLoading(false);
      }
    };
    fetchProfile();
  }, [currentUser]);

  // Poll messaging unread summary (used for sidebar badge)
  useEffect(() => {
    let alive = true;
    if (!currentUser) return;

    const tick = async () => {
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`${API_URL}/messaging/unread/summary`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        setMessagingUnread(Number(data?.total_unread || 0));
      } catch (_) {
        // ignore
      }
    };

    tick();
    const id = setInterval(tick, AUTO_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [currentUser]);

  const navGroups = [
    {
      title: t(language, 'nav.operate', 'OPERATE'),
      items: [
        { key: 'home', label: t(language, 'nav.dashboard', 'Dashboard'), icon: 'fa-solid fa-house' },
        { key: 'my-loads', label: t(language, 'nav.myLoads', 'My Loads'), icon: 'fa-solid fa-truck' },
        { key: 'my-carriers', label: t(language, 'nav.myCarriers', 'My Carriers'), icon: 'fa-solid fa-people-group' },
        { key: 'marketplace', label: t(language, 'nav.marketplace', 'Marketplace'), icon: 'fa-solid fa-store' },
        { key: 'messaging', label: t(language, 'nav.messaging', 'Messaging'), icon: 'fa-solid fa-comments' },
        { key: 'alerts', label: t(language, 'nav.alerts', 'Alerts & Notifications'), icon: 'fa-solid fa-bell' },
        { key: 'carrier-bids', label: t(language, 'nav.carrierBids', 'Carrier Bids'), icon: 'fa-solid fa-hand-holding-dollar' },
        { key: 'tracking', label: t(language, 'nav.trackingVisibility', 'Tracking & Visibility'), icon: 'fa-solid fa-location-crosshairs' },
        { key: 'doc-vault', label: t(language, 'nav.docs', 'Document Vault'), icon: 'fa-solid fa-folder' },
      ]
    },
    {
      title: t(language, 'nav.manage', 'MANAGE'),
      items: [
        { key: 'finance', label: t(language, 'nav.finance', 'Finance'), icon: 'fa-solid fa-wallet' },
        { key: 'bills', label: t(language, 'nav.financeBilling', 'Invoices / Bills'), icon: 'fa-solid fa-file-invoice-dollar' },
        { key: 'compliance', label: t(language, 'nav.compliance', 'Compliance'), icon: 'fa-solid fa-shield-halved' },
        { key: 'analytics', label: t(language, 'nav.analytics', 'Analytics'), icon: 'fa-solid fa-chart-column' }
      ]
    },
    {
      title: t(language, 'nav.system', 'SYSTEM'),
      items: [
        { key: 'profile', label: t(language, 'nav.profile', 'Profile'), icon: 'fa-solid fa-user' },
        { key: 'settings', label: t(language, 'nav.settings', 'Settings'), icon: 'fa-solid fa-gear' },
        { key: 'help', label: t(language, 'nav.aiHub', 'AI Hub'), icon: 'fa-regular fa-circle-question' },
        { key: 'logout', label: t(language, 'nav.logout', 'Logout'), icon: 'fa-solid fa-right-from-bracket' }
      ]
    }
  ];

  // Handle logout
  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };

  // Handle navigation click
  const handleNavClick = (key) => {
    if (key === 'logout') {
      handleLogout();
    } else {
      setActiveNav(key);
      if (isSidebarOpen) setIsSidebarOpen(false);
    }
  };

  const runShipperInsightAction = (actionTarget) => {
    const target = String(actionTarget || '').trim();
    if (!target) return;
    handleNavClick(target);
  };

  // --- FILTER DROPDOWNS STATE ---
  const [openDropdown, setOpenDropdown] = useState(null);
  const [selectedRange, setSelectedRange] = useState('Last 30 Days');
  const [selectedRegion, setSelectedRegion] = useState('All Regions');
  const [selectedCarrier, setSelectedCarrier] = useState('All Carriers');
  const [selectedLane, setSelectedLane] = useState('All Lanes');
  const [homeSearchQuery, setHomeSearchQuery] = useState('');

  const ranges = ['Last 7 Days', 'Last 30 Days', 'Last 90 Days', 'Year to Date'];
  const regions = ['All Regions', 'North', 'South', 'East', 'West', 'Midwest'];
  const carriers = ['All Carriers', 'Swift Transport', 'Reliable Freight', 'Express Logistics'];
  const lanes = ['All Lanes', 'MN → IL', 'TX → AZ', 'FL → GA'];

  // close dropdowns on outside click
  React.useEffect(() => {
    function onDocClick() { setOpenDropdown(null); }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  function HomeView() {
    const normalizeStatus = (s) => String(s || '').trim().toLowerCase();
    const activeStatuses = new Set(['posted', 'tendered', 'covered', 'accepted', 'awarded', 'dispatched', 'in_transit']);
    const assignedStatuses = new Set(['covered', 'accepted', 'awarded', 'dispatched', 'in_transit', 'delivered', 'completed']);
    const deliveredStatuses = new Set(['delivered', 'completed']);

    const activeLoads = (homeLoads || []).filter((l) => activeStatuses.has(normalizeStatus(l?.status || l?.load_status)));
    const deliveredLoads = (homeLoads || []).filter((l) => deliveredStatuses.has(normalizeStatus(l?.status || l?.load_status)));
    const assignedLoads = (homeLoads || []).filter((l) => assignedStatuses.has(normalizeStatus(l?.status || l?.load_status)));

    const totalCount = Number(dashboardStats?.total_loads || 0) || (homeLoads || []).length;
    const activeCount = Number(dashboardStats?.active_loads || 0) || activeLoads.length;
    const shipperAiHeadline = String(
      shipperInsights?.ai_insights?.headline ||
        'Load activity and market changes are reflected here.'
    );
    const shipperAiBullets = (Array.isArray(shipperInsights?.ai_insights?.bullets) ? shipperInsights.ai_insights.bullets : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    const shipperAiSuggestions = (Array.isArray(shipperInsights?.ai_suggestions) ? shipperInsights.ai_suggestions : [])
      .map((s, idx) => ({
        id: String(s?.id || `shipper_ai_${idx}`),
        action_target: String(s?.action_target || ''),
      }));

    const shortLoadLabel = (l) => {
      const num = String(l?.load_number || '').trim();
      if (num) return num;
      const id = String(l?.load_id || l?.id || '').trim();
      if (!id) return 'N/A';
      return id.length > 8 ? id.slice(-8) : id;
    };

    const badgeForStatus = (s) => {
      const st = normalizeStatus(s);
      if (st === 'in_transit') return { cls: 'pending', label: 'In Transit' };
      if (st === 'covered' || st === 'accepted' || st === 'dispatched') return { cls: 'active', label: 'Assigned' };
      if (st === 'posted' || st === 'tendered') return { cls: 'pending', label: 'Tendered' };
      if (st === 'delivered') return { cls: 'active', label: 'Delivered' };
      if (st === 'completed') return { cls: 'active', label: 'Settled' };
      return { cls: 'pending', label: st ? st.replace(/_/g, ' ') : 'Active' };
    };

    const etaText = (l) => {
      const st = normalizeStatus(l?.status || l?.load_status);
      if (st === 'delivered' || st === 'completed') {
        return 'Delivered';
      }
      const delivery = String(l?.delivery_date || '').trim();
      if (delivery) return `ETA: ${delivery}`;
      return 'ETA: TBD';
    };

    const carrierMetricsMap = new Map();
    (homeCarriers || []).forEach((carrier) => {
      const carrierId = String(carrier?.carrier_id || carrier?.id || '').trim();
      const carrierName = String(carrier?.carrier_name || carrier?.name || carrier?.company_name || '').trim();
      const key = carrierId || carrierName;
      if (!key) return;
      carrierMetricsMap.set(key, {
        key,
        id: carrierId,
        name: carrierName || 'Carrier',
        rating: Number(carrier?.rating || 0),
        totalLoads: Number(carrier?.total_loads || 0),
        activeRelationship: String(carrier?.status || '').trim().toLowerCase() === 'active',
        assignedLoads: 0,
        activeLoads: 0,
        completedLoads: 0,
      });
    });

    (homeLoads || []).forEach((load) => {
      const status = normalizeStatus(load?.status || load?.load_status);
      const carrierId = String(load?.assigned_carrier || load?.assigned_carrier_id || load?.carrier_id || '').trim();
      const carrierName = String(load?.assigned_carrier_name || load?.carrier_name || '').trim();
      const key = carrierId || carrierName;
      if (!key) return;
      const current = carrierMetricsMap.get(key) || {
        key,
        id: carrierId,
        name: carrierName || 'Carrier',
        rating: 0,
        totalLoads: 0,
        activeRelationship: false,
        assignedLoads: 0,
        activeLoads: 0,
        completedLoads: 0,
      };

      current.id = current.id || carrierId;
      current.name = current.name || carrierName || 'Carrier';
      current.assignedLoads += 1;
      if (activeStatuses.has(status)) current.activeLoads += 1;
      if (deliveredStatuses.has(status)) current.completedLoads += 1;

      carrierMetricsMap.set(key, current);
    });

    const topCarrierRows = Array.from(carrierMetricsMap.values())
      .filter((carrier) => carrier.name)
      .sort((left, right) => {
        if (right.completedLoads !== left.completedLoads) return right.completedLoads - left.completedLoads;
        if (right.activeLoads !== left.activeLoads) return right.activeLoads - left.activeLoads;
        if (right.assignedLoads !== left.assignedLoads) return right.assignedLoads - left.assignedLoads;
        if (right.totalLoads !== left.totalLoads) return right.totalLoads - left.totalLoads;
        return right.rating - left.rating;
      })
      .slice(0, 3);

    const coverageRate = totalCount > 0 ? Math.round((assignedLoads.length / totalCount) * 100) : 0;
    const completionRate = totalCount > 0 ? Math.round((deliveredLoads.length / totalCount) * 100) : 0;
    const activeCarrierCount = (homeCarriers || []).filter((carrier) => String(carrier?.status || '').trim().toLowerCase() === 'active').length;
    const averageCarrierRating = (homeCarriers || []).length > 0
      ? ((homeCarriers || []).reduce((sum, carrier) => sum + Number(carrier?.rating || 0), 0) / (homeCarriers || []).length).toFixed(1)
      : '0.0';

    const complianceDocuments = Array.isArray(homeCompliance?.documents) ? homeCompliance.documents : [];
    const expiringComplianceItems = complianceDocuments
      .filter((doc) => ['Expired', 'Expiring Soon'].includes(String(doc?.status || '').trim()))
      .slice(0, 2);
    const complianceWarnings = Array.isArray(homeCompliance?.warnings) ? homeCompliance.warnings.filter(Boolean) : [];
    const complianceRecommendations = Array.isArray(homeCompliance?.recommendations) ? homeCompliance.recommendations.filter(Boolean) : [];
    const complianceScore = Number(homeCompliance?.compliance_score || 0);
    const complianceTone = complianceScore >= 80 ? 'Fully compliant' : complianceScore >= 50 ? 'Needs attention' : 'At risk';

    return (
      <>
        <header className="fp-header">
          <div className="fp-header-controls">
            <button className="btn small-cd" onClick={() => setShowAddLoads(true)}>+ {t(language, 'shipper.createLoad', 'Create Load')}</button>
            <button className="btn small ghost-cd" onClick={() => setIsInviteCarrierOpen(true)}>{t(language, 'shipper.inviteCarrier', 'Invite Carrier')}</button>
            <button className="btn small ghost-cd" onClick={() => fileInputRef.current?.click()}>{t(language, 'dashboard.uploadDocument', 'Upload Document')}</button>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              multiple 
              onChange={handleFileUpload}
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
            />
            <button
              className="btn small ghost-cd"
              onClick={() => {
                const first = (activeLoads || [])[0];
                const id = String(first?.load_id || first?.id || '').trim();
                setTrackingInitialLoadId(id || null);
                setActiveNav('tracking');
                if (isSidebarOpen) setIsSidebarOpen(false);
              }}
            >
              Track Shipments
            </button>
          </div>
        </header>

        {/* Shipper Profile Card - Shows onboarding data */}
        {!profileLoading && shipperProfile && shipperProfile.data && (
          <section style={{ marginBottom: '20px' }}>
            <div className="card" style={{ padding: '20px', background: '#f8fafc' }}>
              <div className="card-header">
                <h3><i className="fa-solid fa-building" style={{ marginRight: '8px' }}></i>{t(language, 'shipper.businessProfile', 'Business Profile')}</h3>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '16px' }}>
                {shipperProfile.data.businessName && (
                  <div><strong>{t(language, 'shipper.businessLabel', 'Business:')}</strong> {shipperProfile.data.businessName}</div>
                )}
                {shipperProfile.data.businessType && (
                  <div><strong>{t(language, 'shipper.typeLabel', 'Type:')}</strong> {shipperProfile.data.businessType}</div>
                )}
                {shipperProfile.data.contactFullName && (
                  <div><strong>{t(language, 'shipper.contactLabel', 'Contact:')}</strong> {shipperProfile.data.contactFullName}</div>
                )}
                {shipperProfile.data.contactEmail && (
                  <div><strong>{t(language, 'shipper.emailLabel', 'Email:')}</strong> {shipperProfile.data.contactEmail}</div>
                )}
                {shipperProfile.data.freightType && (
                  <div><strong>{t(language, 'shipper.freightTypeLabel', 'Freight Type:')}</strong> {shipperProfile.data.freightType}</div>
                )}
                {shipperProfile.data.regionsOfOperation && (
                  <div><strong>{t(language, 'shipper.regionsLabel', 'Regions:')}</strong> {shipperProfile.data.regionsOfOperation}</div>
                )}
              </div>
              {!shipperProfile.onboarding_completed && (
                <div style={{ marginTop: '16px', padding: '12px', background: '#fef3c7', borderRadius: '8px', color: '#92400e' }}>
                  <i className="fa-solid fa-exclamation-triangle" style={{ marginRight: '8px' }}></i>
                  {t(language, 'shipper.onboardingNotComplete', 'Onboarding not complete.')} <button onClick={() => setActiveNav('profile')} style={{ background: 'none', border: 'none', color: '#1d4ed8', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}>{t(language, 'shipper.completeProfile', 'Complete your profile')}</button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Onboarding Coach removed - compliance data now shown in Compliance & Safety page */}

        <section className="top-stats">
          <div className="card sd-small-card">
            <div className="sd-small-card-row">
              <h4>{t(language, 'dashboard.activeLoads', 'Active Loads')}</h4>
              <i className="fa-solid fa-truck" aria-hidden="true" />
            </div>
            <div className="big">{statsLoading ? '...' : (dashboardStats?.active_loads || 0)}</div>
            <div className="small-sub-active">+{dashboardStats?.active_loads_today || 0} {t(language, 'common.today', 'today')}</div>
          </div>
          <div className="card sd-small-card">
            <div className="sd-small-card-row">
              <h4>{t(language, 'shipper.onTimePercent', 'On-Time %')}</h4>
              <i className="fa-solid fa-clock" aria-hidden="true" />
            </div>
            <div className="big green">{statsLoading ? '...' : `${dashboardStats?.on_time_percentage || 0}%`}</div>
            <div className="small-sub-time">{dashboardStats?.on_time_change || '+0%'}</div>
          </div>
          <div className="card sd-small-card">
            <div className="sd-small-card-row">
              <h4>{t(language, 'shipper.carrierRating', 'Carrier Rating')}</h4>
              <i className="fa-solid fa-star" aria-hidden="true" />
            </div>
            <div className="big">{statsLoading ? '...' : (dashboardStats?.rating || 0)}</div>
            <div className="small-sub-rating">{dashboardStats?.rating_label || 'N/A'}</div>
          </div>

          <div className="card sd-small-card">
            <div className="sd-small-card-row">
              <h4>{t(language, 'shipper.totalRevenue', 'Total Revenue')}</h4>
              <i className="fa-solid fa-dollar-sign" aria-hidden="true" />
            </div>
            <div className="big">${statsLoading ? '...' : ((dashboardStats?.total_revenue || 0) / 1000).toFixed(0)}K</div>
            <div className="small-sub-revenue">{dashboardStats?.revenue_change || '+0%'} {t(language, 'shipper.mtd', 'MTD')}</div>
          </div>
          <div className="card sd-small-card">
            <div className="sd-small-card-row">
              <h4>{t(language, 'nav.compliance', 'Compliance')}</h4>
              <i className="fa-solid fa-shield-halved" aria-hidden="true" />
            </div>
            <div className="big">{statsLoading ? '...' : `${dashboardStats?.compliance_score || 0}%`}</div>
            <div className="small-sub-compliance">{dashboardStats?.compliance_expiring || 0} {t(language, 'common.expiring', 'expiring')}</div>
          </div>
          <div className="card sd-small-card" style={{ cursor: 'pointer' }} onClick={() => setShowDraftLoadsModal(true)}>
            <div className="sd-small-card-row">
              <h4>{t(language, 'shipper.draftLoads', 'Draft Loads')}</h4>
              <i className="fa-solid fa-file-lines" aria-hidden="true" />
            </div>
            <div className="big">{statsLoading ? '...' : (dashboardStats?.draft_loads || 0)}</div>
            <div className="small-sub-task">{t(language, 'common.clickToManage', 'Click to manage')}</div>
          </div>

          <div className="card sd-small-card shd-ai-summary">
            <h4>{t(language, 'shipper.aiSummary', 'AI Summary')}</h4>
            <div className="big">{statsLoading ? '...' : (dashboardStats?.total_loads || 0)} {t(language, 'common.loads', 'loads')}</div>
          </div>
        </section>

        <section className="fp-filters" style={{display:'flex',gap:12,alignItems:'center',marginBottom:18,flexWrap:'wrap'}}>
            <select className="sb-carrier-filter-select" value={selectedRange} onChange={(e) => setSelectedRange(e.target.value)}>
              {ranges.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            <select className="sb-carrier-filter-select" value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)}>
              {regions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            <select className="sb-carrier-filter-select" value={selectedCarrier} onChange={(e) => setSelectedCarrier(e.target.value)}>
              {carriers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            <select className="sb-carrier-filter-select" value={selectedLane} onChange={(e) => setSelectedLane(e.target.value)}>
              {lanes.map(l => <option key={l} value={l}>{l}</option>)}
            </select>

          <div style={{marginLeft:'auto'}} className="search-wrapper">
            <div className="ssd-search-box">
              <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
              <input 
                placeholder="Search..." 
                value={homeSearchQuery}
                onChange={(e) => setHomeSearchQuery(e.target.value)}
              />
            </div>
          </div>
        </section>

        <section className="fp-grid" style={{gridTemplateColumns:'repeat(3,1fr)',gap:18}}>
          <div className="card ai-insights">
            <h3>{t(language, 'shipper.aiInsights', 'AI Insights')}</h3>
            <div className="insight">{shipperAiHeadline}</div>
            {shipperInsightsLoading && (
              <div className="muted" style={{ marginTop: 8 }}>{t(language, 'dashboard.loadingInsights', 'Loading insights...')}</div>
            )}
            {shipperInsightsError && (
              <div className="muted" style={{ marginTop: 8, color: '#b42318' }}>{shipperInsightsError}</div>
            )}
            <ul className="muted">
              {(shipperAiBullets.length > 0 ? shipperAiBullets : [
                'Demand and coverage signals are generated from your current load activity.',
                'Open marketplace and carrier bids for real-time opportunities.',
              ]).slice(0, 3).map((line, idx) => (
                <li
                  key={`shipper-ai-bullet-${idx}`}
                  style={{ cursor: shipperAiSuggestions[idx]?.action_target ? 'pointer' : 'default' }}
                  onClick={() => runShipperInsightAction(shipperAiSuggestions[idx]?.action_target)}
                >
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <div className="card active-loads">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <h3>{t(language, 'dashboard.activeLoads', 'Active Loads')}</h3>
              <div className="muted">{activeCount} of {totalCount}</div>
            </div>
            <ul className="active-load-list">
              {homeLoadsError ? (
                <li>
                  <div className="muted">{homeLoadsError}</div>
                </li>
              ) : homeLoadsLoading ? (
                <li>
                  <div className="muted">{t(language, 'shipper.loadingShipments', 'Loading shipments…')}</div>
                </li>
              ) : (activeLoads || []).length === 0 ? (
                <li>
                  <div className="muted">{t(language, 'shipper.noActiveLoadsYet', 'No active loads yet.')}</div>
                </li>
              ) : (
                (activeLoads || []).slice(0, 3).map((l) => {
                  const id = String(l?.load_id || l?.id || Math.random());
                  const origin = String(l?.origin || l?.load_origin || 'N/A');
                  const dest = String(l?.destination || l?.load_destination || 'N/A');
                  const st = l?.status || l?.load_status;
                  const badge = badgeForStatus(st);
                  return (
                    <li key={id}>
                      <div className="load-left">
                        <strong>#{shortLoadLabel(l)}</strong>
                        <div className="muted">{origin} → {dest}</div>
                      </div>
                      <div className="load-right">
                        <div className={`int-status-badge ${badge.cls}`}>{badge.label}</div>
                        <div className="muted small">{etaText(l)}</div>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          <div className="card top-carriers">
            <h3>{t(language, 'shipper.topCarriers', 'Top Carriers')}</h3>
            <ol className="top-carriers">
              {homeCarriersLoading ? (
                <li>
                  <div className="muted small">{t(language, 'shipper.loadingCarriers', 'Loading carriers...')}</div>
                </li>
              ) : topCarrierRows.length === 0 ? (
                <li>
                  <div className="muted small">{t(language, 'shipper.noCarrierActivity', 'No carrier activity yet.')}</div>
                </li>
              ) : topCarrierRows.map((carrier, index) => (
                <li key={carrier.key || `${carrier.name}-${index}`}>
                  <div className="carrier-left">
                    <div className="name">{carrier.name}</div>
                    <div className="sub muted small">
                      {carrier.completedLoads > 0 || carrier.activeLoads > 0
                        ? `${carrier.completedLoads} ${t(language, 'common.completed', 'completed')} • ${carrier.activeLoads} ${t(language, 'common.active', 'active')}`
                        : `${carrier.activeRelationship ? t(language, 'shipper.activeRelationship', 'Active relationship') : t(language, 'common.connected', 'Connected')} • ${carrier.assignedLoads || carrier.totalLoads || 0} ${t(language, 'common.loads', 'loads')}`}
                    </div>
                  </div>
                  <div className="carrier-right">
                    <span className={`rating ${index === 1 ? 'blue' : index === 2 ? 'orange' : ''}`}>
                      {carrier.rating > 0 ? `${carrier.rating.toFixed(1)}★` : t(language, 'shipper.noRating', 'No rating')}
                    </span>
                    <div className="muted small">{carrier.assignedLoads || carrier.totalLoads || 0} {t(language, 'common.loads', 'loads')}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="card performance-card">
            <h3>{t(language, 'shipper.performanceHealth', 'Performance Health')}</h3>
            <div className="performance-metrics">
              <div className="metric">
                <strong className="green">{t(language, 'shipper.coverage', 'Coverage')}</strong>
                <div className="muted">{coverageRate}%</div>
              </div>
              <div className="metric">
                <strong className="blue">{t(language, 'shipper.completion', 'Completion')}</strong>
                <div className="muted">{completionRate}%</div>
              </div>
            </div>
            <div className="muted small" style={{ marginTop: 12 }}>
              {totalCount} {t(language, 'shipper.totalLoads', 'total loads')} • {activeCarrierCount} {t(language, 'shipper.activeCarriersLabel', 'active carriers')} • {t(language, 'shipper.avgRating', 'Avg rating')} {averageCarrierRating}★
            </div>
          </div>

          <div className="card compliance-card">
            <h3>{t(language, 'shipper.complianceStatus', 'Compliance Status')}</h3>
            {homeComplianceLoading ? (
              <div className="sd-exp-item pill">
                <div className="exp-title">{t(language, 'shipper.loadingCompliance', 'Loading compliance...')}</div>
              </div>
            ) : (
              <>
                <div className="sd-exp-item pill">
                  <div className="exp-title">{t(language, 'shipper.complianceScore', 'Compliance score:')} {complianceScore}%</div>
                  <div className="exp-sub muted">{complianceTone} • {complianceDocuments.length} {t(language, 'shipper.documentsOnFile', 'documents on file')}</div>
                </div>
                {expiringComplianceItems.length > 0 ? expiringComplianceItems.map((doc, index) => (
                  <div className="sd-exp-item pill" key={`compliance-doc-${doc?.id || index}`}>
                    <div className="exp-title">{String(doc?.document_type || 'Document')} {String(doc?.status || '').trim()}</div>
                    <div className="exp-sub muted">{doc?.expiry_date ? `${t(language, 'common.expiry', 'Expiry:')} ${doc.expiry_date}` : t(language, 'shipper.reviewRequired', 'Review required')}</div>
                  </div>
                )) : complianceWarnings.slice(0, 1).map((warning, index) => (
                  <div className="sd-exp-item pill" key={`compliance-warning-${index}`}>
                    <div className="exp-title">{t(language, 'shipper.complianceAlert', 'Compliance alert')}</div>
                    <div className="exp-sub muted">{warning}</div>
                  </div>
                ))}
                {expiringComplianceItems.length === 0 && complianceWarnings.length === 0 && complianceRecommendations.slice(0, 1).map((recommendation, index) => (
                  <div className="sd-exp-item pill" key={`compliance-recommendation-${index}`}>
                    <div className="exp-title">{t(language, 'shipper.nextAction', 'Next action')}</div>
                    <div className="exp-sub muted">{recommendation}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      </>
    );
  }

  function ContentView({ activeNav }) {
    if (activeNav === 'home') return <HomeView />;
    if (activeNav === 'my-loads') return <ShipperMyLoads />;
    if (activeNav === 'my-carriers') return <MyCarriers />;
    if (activeNav === 'marketplace') return <ShipperMarketplace />;
    if (activeNav === 'carrier-bids') return <CarrierBids />;
    if (activeNav === 'alerts') return <AlertsNotifications />;
    if (activeNav === 'tracking') return <TrackingVisibility initialLoadId={trackingInitialLoadId} />;
    if (activeNav === 'doc-vault') return <DocumentVault />;
    if (activeNav === 'finance') return <Finance />;
    if (activeNav === 'bills') return <Bills initialInvoiceId={initialInvoiceId} />;
    if (activeNav === 'compliance') return <ComplianceOverview />;
    if (activeNav === 'settings') return <Settings />;
    if (activeNav === 'help') return <AiHub />;
    if (activeNav === 'analytics') return <ShipperAnalytics onNavigate={setActiveNav} />;
    if (activeNav === 'messaging') return <Messaging initialThreadId={initialThreadId} />;
    if (activeNav === 'profile') return <ShipperProfile />;
    return (
      <div>
        <header className="fp-header">
          <div className="fp-header-titles">
            <h2>{navGroups.flatMap(g => g.items).find(i => i.key === activeNav)?.label || t(language, 'common.view', 'View')}</h2>
            <p className="fp-subtitle">This is the {activeNav} view.</p>
          </div>
        </header>
        <section className="fp-grid">
          <div className="card">
            <div className="card-header"><h3>Placeholder</h3></div>
            <div style={{ padding: 20 }}>Content for <strong>{activeNav}</strong> goes here.</div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={`fp-dashboard-root ${isDarkMode ? 'dark-root' : ''}`}>
      <div className="fp-topbar">
        <div className="topbar-row topbar-row-1">
          <div className="topbar-left">
            <button className="hamburger" aria-label={t(language, 'dashboard.openSidebar', 'Open sidebar')} onClick={() => setIsSidebarOpen(true)}>
              <i className="fa-solid fa-bars" />
            </button>
            <div className="brand-block">
              <div className="brand-row">
                  <div className="logo">
                  {/* Desktop / large-screen logo */}
                  <img src={logo} alt="FreightPower" className="landing-logo-image desktop-logo" />
                  {/* Responsive compact logo shown at <=768px */}
                  <img src={resp_logo} alt="FreightPower" className="landing-logo-image mobile-logo" />
                  </div>
                  {/* Company name placed to the right of the logo (shipper-only) */}
                  <div className="brand-info">
                    <div className="company-name">Atlas Logistics LLC</div>
                    {/* Shipper-only status chips placed below the company name (column) */}
                    <div className="shipper-status">
                      <span className="int-status-badge active"><i className="fa-solid fa-check"/> {t(language, 'dashboard.activeOperating', 'Active & Operating')}</span>
                      <span className="int-status-badge blue"><i className="fa-solid fa-network-wired"/> {t(language, 'dashboard.tmsConnected', 'TMS Connected')}</span>
                    </div>
                  </div>
                </div>
            </div>
          </div>

          <div className="topbar-right actions-right">
            <div className="icons">
              <div className="notif" id="fp-notif-dropdown-root" style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => {
                    setNotifOpen(false);
                    setActiveNav('alerts');
                    setIsSidebarOpen(false);
                  }}
                  aria-label="Open Alerts & Notifications"
                  style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <i className="fa-regular fa-bell notif-icon" aria-hidden="true" />
                  {notifUnread > 0 && <span className="notif-badge">{notifUnread > 99 ? '99+' : notifUnread}</span>}
                </button>

                {notifOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: 'calc(100% + 10px)',
                      width: 380,
                      maxWidth: '90vw',
                      background: isDarkMode ? '#0b1220' : '#ffffff',
                      border: isDarkMode ? '1px solid rgba(148,163,184,0.22)' : '1px solid #e5e7eb',
                      borderRadius: 12,
                      boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
                      overflow: 'hidden',
                      zIndex: 50,
                    }}
                  >
                    <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ fontWeight: 800, color: isDarkMode ? '#e2e8f0' : '#0f172a' }}>{t(language, 'common.notifications', 'Notifications')}</div>
                      <button
                        type="button"
                        className="btn small ghost-cd"
                        onClick={() => {
                          fetchNotifications();
                        }}
                        disabled={notifLoading}
                      >
                        {notifLoading ? t(language, 'common.loading', 'Loading…') : t(language, 'common.refresh', 'Refresh')}
                      </button>
                    </div>
                    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                      {(notifItems || []).length === 0 ? (
                        <div style={{ padding: 14, color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 13 }}>
                          {notifLoading ? t(language, 'common.loading', 'Loading…') : t(language, 'dashboard.noNotificationsYet', 'No notifications yet.')}
                        </div>
                      ) : (
                        (notifItems || []).map((n) => {
                          const isRead = Boolean(n?.is_read);
                          const title = String(n?.title || 'Notification');
                          const msg = String(n?.message || '');
                          const hasAction = Boolean(String(n?.action_url || '').trim());
                          return (
                            <div
                              key={String(n?.id || Math.random())}
                              style={{
                                padding: 12,
                                borderTop: isDarkMode ? '1px solid rgba(148,163,184,0.14)' : '1px solid #f1f5f9',
                                background: isRead ? 'transparent' : (isDarkMode ? 'rgba(59,130,246,0.10)' : '#eff6ff'),
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                                <div style={{ display: 'grid', gap: 6 }}>
                                  <div style={{ fontWeight: 800, color: isDarkMode ? '#e2e8f0' : '#0f172a', fontSize: 13 }}>
                                    {title}
                                  </div>
                                  {msg ? (
                                    <div style={{ color: isDarkMode ? '#cbd5e1' : '#475569', fontSize: 12, lineHeight: 1.35 }}>
                                      {msg}
                                    </div>
                                  ) : null}
                                  {n?.relative_time || n?.formatted_time ? (
                                    <div style={{ color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 11 }}>
                                      {String(n?.relative_time || n?.formatted_time)}
                                    </div>
                                  ) : null}
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                                  {hasAction ? (
                                    <button type="button" className="btn small ghost-cd" onClick={() => handleNotifAction(n)}>
                                      {t(language, 'common.view', 'View')}
                                    </button>
                                  ) : null}
                                  {!isRead && (
                                    <button
                                      type="button"
                                      className="btn small ghost-cd"
                                      onClick={() => markNotificationRead(String(n?.id || '').trim())}
                                    >
                                      {t(language, 'dashboard.markRead', 'Mark read')}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveNav('help');
                  setIsSidebarOpen(false);
                }}
                aria-label="Open AI Hub"
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <i className="fa-solid fa-robot bot-icon" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveNav('profile');
                  setIsSidebarOpen(false);
                }}
                aria-label="Open Profile"
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <img src="https://randomuser.me/api/portraits/women/65.jpg" alt="avatar" className="avatar-img"/>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className={`fp-content-row ${isSidebarOpen ? 'sidebar-open' : ''}`}>
        <aside className={`fp-sidebar ${isSidebarOpen ? 'open' : ''} ${isSidebarDark ? 'dark' : ''}`}>
          <div className="sidebar-header">
            <div className="brand-row">
              <div className="logo"><img src={logo} alt="FreightPower" className="landing-logo-image" /></div>
            </div>
            <div className="chips sidebar-chips">
              <div className="company-name">Atlas Logistics LLC</div>
              <span className="int-status-badge active">{t(language, 'dashboard.activeOperating', 'Active & Operating')}</span>
              <span className="int-status-badge blue">{t(language, 'dashboard.tmsConnected', 'TMS Connected')}</span>
            </div>
          </div>

          <nav className="fp-nav">
            {navGroups.map((group) => (
              <div className="nav-group" key={group.title}>
                <div className="nav-group-title">{group.title}</div>
                <ul>
                  {group.items.map((it) => (
                    <li
                      className={`nav-item ${activeNav === it.key ? 'active' : ''}`}
                      key={it.key}
                      onClick={() => handleNavClick(it.key)}
                      role="button"
                      tabIndex={0}
                    >
                      <i className={`${it.icon} icon`} aria-hidden="true"></i>
                      <span className="label">{it.label}</span>
                      {it.key === 'messaging' && messagingUnread > 0 && (
                        <span className="nav-unread-badge">{messagingUnread > 99 ? '99+' : messagingUnread}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <div className="sidebar-dark-control">
            <span className="dark-label">{t(language, 'dashboard.darkMode', 'Dark Mode')}</span>
            <button
              className="dark-toggle"
              aria-pressed={isDarkMode}
              aria-label={t(language, 'dashboard.toggleDarkMode', 'Toggle dark mode')}
              onClick={() => setIsDarkMode((s) => !s)}
            >
              <span className="dark-toggle-knob" />
            </button>
          </div>

          <button className="sidebar-close" aria-label={t(language, 'dashboard.closeSidebar', 'Close sidebar')} onClick={() => setIsSidebarOpen(false)}>
            <i className="fa-solid fa-xmark" />
          </button>
        </aside>

        {isSidebarOpen && <div className="overlay" onClick={() => setIsSidebarOpen(false)} />}

        <main className="fp-main">
          <ContentView activeNav={activeNav} />
        </main>
      </div>

      {/* AddLoads Modal */}
      {showAddLoads && (
        <AddLoads 
          onClose={() => {
            setShowAddLoads(false);
            setEditingDraftLoad(null);
          }} 
          isShipper={true}
          draftLoad={editingDraftLoad}
        />
      )}

      {/* Draft Loads Modal */}
      {showDraftLoadsModal && (
        <DraftLoadsModal
          onClose={() => setShowDraftLoadsModal(false)}
          onEditDraft={handleEditDraft}
        />
      )}

      {/* Invite Carrier Modal */}
      <InviteCarrierModal 
        isOpen={isInviteCarrierOpen} 
        onClose={() => setIsInviteCarrierOpen(false)} 
      />

      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />
    </div>
  );
}

