import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../../config';
import '../../styles/carrier/CarrierDashboard.css';
import peopleIcon from '../../assets/ai_driver.svg';
import MyLoads from './MyLoads';
import DocumentVault from './DocumentVault';
import ShipperPartners from './ShipperPartners';
import Marketplace from './Marketplace';
import DriversAndDispatches from './DriversAndDispatches';
import FactoringInvoicing from './FactoringInvoicing';
import Integrations from './Integrations';
import ComplianceSafety from './ComplianceSafety';
import ConsentESignature from './ConsentESignature';
import Messaging from './Messaging';
import AlertsNotifications from './AlertsNotifications';
import Analytics from './Analytics';
import Calendar from './Calendar';
import Settings from './Settings';
import HelpHub from './HelpHub';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { t } from '../../i18n/translate';
// OnboardingCoach removed - compliance data now shown in Compliance & Safety page
import logo from '/src/assets/logo.png';
import resp_logo from '/src/assets/logo_1.png';
// Note: Font Awesome icons are used instead of custom SVGs for simplicity
// icon images replaced by Font Awesome icons

export default function CarrierDashboard() {
  const { currentUser, logout } = useAuth();
  const { settings } = useUserSettings();
  const language = settings?.language || 'English';
  const locale = language === 'Spanish' ? 'es-ES' : language === 'Arabic' ? 'ar' : 'en-US';
  const languageCode = language === 'Spanish' ? 'ES' : language === 'Arabic' ? 'AR' : 'EN';
  const navigate = useNavigate();
  const location = useLocation();
  
  // Dashboard stats state
  const [activeLoads, setActiveLoads] = useState({ inProgress: 0, delivered: 0, completed: 0 });
  const [driversCompliance, setDriversCompliance] = useState({ active: 0, expiring: 0, alerts: 0 });
  const [earnings, setEarnings] = useState({ week: 0, month: 0, factoring: 0 });
  const [expiringDocuments, setExpiringDocuments] = useState([]);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [marketplaceLoads, setMarketplaceLoads] = useState([]);
  const [availableDriversCount, setAvailableDriversCount] = useState(0);
  const [vehicleCounts, setVehicleCounts] = useState(null); // aggregated across associated drivers
  const [carrierInsights, setCarrierInsights] = useState(null);
  const [carrierInsightsLoading, setCarrierInsightsLoading] = useState(false);
  const [carrierInsightsError, setCarrierInsightsError] = useState('');
  const carrierInsightsAbortRef = React.useRef(null);
  
  const [activeNav, setActiveNav] = useState('home');
  const [initialThreadId, setInitialThreadId] = useState(null);
  const [activeMarketplaceSection, setActiveMarketplaceSection] = useState('loads');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarDark, setIsSidebarDark] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  const fmtMoney = (amt) => {
    const n = Number(amt || 0);
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  };

  // Messaging unread badge
  const [messagingUnread, setMessagingUnread] = useState(0);

  // Home: Recent unread threads snapshot
  const [recentUnreadThreads, setRecentUnreadThreads] = useState([]);
  const [recentUnreadLoading, setRecentUnreadLoading] = useState(false);

  // Notifications state
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifUnread, setNotifUnread] = useState(0);
  const [notifItems, setNotifItems] = useState([]);
  const [latestNotifications, setLatestNotifications] = useState([]);

  // Deep-link support (email links): /carrier-dashboard?nav=messaging&thread=<threadId>
  useEffect(() => {
    try {
      const qs = new URLSearchParams(location.search || '');
      const nav = (qs.get('nav') || qs.get('section') || '').trim();
      const thread = (qs.get('thread') || qs.get('thread_id') || '').trim();
      if (thread) {
        setInitialThreadId(thread);
        setActiveNav('messaging');
        return;
      }
      if (nav) setActiveNav(nav);
    } catch {
      // ignore
    }
  }, [location.search]);

  // Onboarding data state
  const [companyProfile, setCompanyProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [complianceScore, setComplianceScore] = useState(null);
  const [dotNumber, setDotNumber] = useState('');
  const [mcNumber, setMcNumber] = useState('');

  // FMCSA verification summary (best-effort; may be missing fields)
  const [fmcsaSummary, setFmcsaSummary] = useState(null);
  const [fmcsaLoading, setFmcsaLoading] = useState(false);
  
  // Modal states
  const [showReportFraudModal, setShowReportFraudModal] = useState(false);
  const [showSuggestEditModal, setShowSuggestEditModal] = useState(false);
  const [reportFraudData, setReportFraudData] = useState({ subject: '', message: '' });
  const [suggestEditData, setSuggestEditData] = useState({ subject: '', message: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch dashboard data
  useEffect(() => {
    const fetchDashboardData = async () => {
      if (!currentUser) {
        setDashboardLoading(false);
        return;
      }

      const classifyLoad = (load) => {
        const status = String(load?.status || '').toLowerCase();
        if (status === 'draft') return { column: 'draft', statusFlag: 'draft' };
        if (status === 'completed') return { column: 'settled', statusFlag: 'settled' };
        if (status === 'delivered') return { column: 'delivered', statusFlag: 'delivered' };
        if (status === 'in_transit') return { column: 'inTransit', statusFlag: 'in transit' };
        if (status === 'accepted') return { column: 'accepted', statusFlag: 'accepted' };

        const hasDriver = Boolean(load?.assigned_driver || load?.assigned_driver_id);
        if (hasDriver) {
          const das = String(load?.driver_assignment_status || '').toLowerCase();
          if (das === 'accepted' || status === 'covered') return { column: 'accepted', statusFlag: 'accepted' };
          return { column: 'tendered', statusFlag: 'assigned' };
        }
        return { column: 'tendered', statusFlag: 'unassigned' };
      };
      
      try {
        const token = await currentUser.getIdToken();

        // Loads: used for both Home Active Loads and Marketplace Snapshot
        let carrierLoads = [];
        try {
          const loadsRes = await fetch(`${API_URL}/loads?page_size=200&exclude_drafts=false`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (loadsRes.ok) {
            const loadsData = await loadsRes.json();
            carrierLoads = loadsData.loads || [];

            const grouped = { accepted: 0, inTransit: 0, delivered: 0, settled: 0 };
            carrierLoads.forEach((l) => {
              const { column } = classifyLoad(l);
              if (column === 'accepted') grouped.accepted += 1;
              if (column === 'inTransit') grouped.inTransit += 1;
              if (column === 'delivered') grouped.delivered += 1;
              if (column === 'settled') grouped.settled += 1;
            });

            setActiveLoads({
              inProgress: grouped.accepted + grouped.inTransit,
              delivered: grouped.delivered,
              completed: grouped.settled,
            });

            const availableLoads = carrierLoads
              .filter(l => l.status === 'posted' || l.status === 'available')
              .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
              .slice(0, 2);
            setMarketplaceLoads(availableLoads);
          }
        } catch (error) {
          console.error('Error fetching loads:', error);
        }
        
        // Fetch drivers data
        const driversRes = await fetch(`${API_URL}/drivers/my-drivers`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        let driversData = null; // Store for reuse later
        if (driversRes.ok) {
          driversData = await driversRes.json();
          const drivers = driversData.drivers || [];

          // Aggregate vehicle counts across associated drivers
          const counts = { powerUnits: 0, reefers: 0, dryVans: 0 };
          drivers.forEach((d) => {
            const vtRaw = d?.vehicle_type || d?.vehicleType || '';
            const vt = String(vtRaw).trim().toLowerCase().replace('-', '_').replace(' ', '_');
            if (!vt) return;
            if (vt === 'power_unit' || vt === 'powerunit' || vt === 'tractor' || vt === 'truck') counts.powerUnits += 1;
            else if (vt === 'reefer' || vt === 'refrigerated') counts.reefers += 1;
            else if (vt === 'dry_van' || vt === 'dryvan' || vt === 'dry' || vt === 'van') counts.dryVans += 1;
          });
          setVehicleCounts(counts);
          
          // Count active drivers
          const activeDrivers = drivers.filter(d => d.status === 'available' || d.status === 'assigned' || d.status === 'on_route').length;
          
          // Count expiring licenses (check CDL expiration if available)
          const expiringLicenses = drivers.filter(d => {
            if (d.cdl_expiration_date) {
              const expDate = new Date(d.cdl_expiration_date);
              const today = new Date();
              const daysUntilExpiry = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
              return daysUntilExpiry > 0 && daysUntilExpiry <= 90; // Expiring in next 90 days
            }
            return false;
          }).length;
          
          // Count safety alerts (drivers with low safety scores or violations)
          const safetyAlerts = drivers.filter(d => {
            const safetyScore = d.safety_score || 100;
            return safetyScore < 80 || d.violations_count > 0;
          }).length;
          
          setDriversCompliance({
            active: activeDrivers,
            expiring: expiringLicenses,
            alerts: safetyAlerts
          });
        }
        
        // Fetch compliance status for expiring documents
        const complianceRes = await fetch(`${API_URL}/compliance/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (complianceRes.ok) {
          const cData = await complianceRes.json();
          
          // Extract expiring documents from compliance data
          const expiring = [];
          if (cData.documents) {
            cData.documents.forEach(doc => {
              if (doc.expiration_date) {
                const expDate = new Date(doc.expiration_date);
                const today = new Date();
                const daysUntilExpiry = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
                
                if (daysUntilExpiry > 0 && daysUntilExpiry <= 30) {
                  expiring.push({
                    title: doc.document_type || 'Document',
                    days: daysUntilExpiry,
                    type: daysUntilExpiry <= 7 ? 'pink' : daysUntilExpiry <= 14 ? 'yellow' : 'blue'
                  });
                }
              }
            });
          }
          
          // Sort by days until expiry
          expiring.sort((a, b) => a.days - b.days);
          setExpiringDocuments(expiring.slice(0, 3)); // Show top 3
        }
        
        // Earnings: sum paid (and partially paid) invoices
        try {
          const invRes = await fetch(`${API_URL}/invoices?limit=500`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (invRes.ok) {
            const invData = await invRes.json();
            const invoices = invData.invoices || [];
            const now = Date.now() / 1000;
            const weekAgo = now - 7 * 86400;
            const monthAgo = now - 30 * 86400;

            const paidLike = invoices.filter((inv) => {
              const s = String(inv?.status || '').toLowerCase();
              return s === 'paid' || s === 'partially_paid';
            });

            const paidAmount = (inv) => {
              const s = String(inv?.status || '').toLowerCase();
              if (s === 'paid') return Number(inv?.amount_total || 0);
              return Number(inv?.amount_paid || 0);
            };

            const weekTotal = paidLike
              .filter(inv => Number(inv?.paid_at || 0) >= weekAgo)
              .reduce((sum, inv) => sum + paidAmount(inv), 0);
            const monthTotal = paidLike
              .filter(inv => Number(inv?.paid_at || 0) >= monthAgo)
              .reduce((sum, inv) => sum + paidAmount(inv), 0);
            const factoringTotal = paidLike
              .filter(inv => Boolean(inv?.factoring_enabled))
              .reduce((sum, inv) => sum + paidAmount(inv), 0);

            setEarnings({
              week: weekTotal,
              month: monthTotal,
              factoring: factoringTotal,
            });
          }
        } catch (error) {
          console.error('Error fetching invoices:', error);
        }

        // Home: Recent unread message threads snapshot
        try {
          setRecentUnreadLoading(true);
          const [threadsRes, unreadRes] = await Promise.all([
            fetch(`${API_URL}/messaging/threads?limit=50`, { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch(`${API_URL}/messaging/unread/summary`, { headers: { 'Authorization': `Bearer ${token}` } }),
          ]);

          const threadsData = threadsRes.ok ? await threadsRes.json() : { threads: [] };
          const unreadData = unreadRes.ok ? await unreadRes.json() : { threads: {} };

          const threads = threadsData.threads || [];
          const perThread = unreadData.threads || {};

          const unreadThreads = threads
            .map((t) => ({
              ...t,
              unread_count: Number(perThread?.[t.id] || 0),
            }))
            .filter((t) => (t.unread_count || 0) > 0)
            .sort((a, b) => Number(b.last_message_at || b.updated_at || 0) - Number(a.last_message_at || a.updated_at || 0))
            .slice(0, 3);

          setRecentUnreadThreads(unreadThreads);
        } catch (error) {
          console.error('Error fetching recent messages:', error);
          setRecentUnreadThreads([]);
        } finally {
          setRecentUnreadLoading(false);
        }
        
        // Get available drivers count from already fetched drivers data
        // Count drivers who are available (not on trip)
        if (driversData) {
          const drivers = driversData.drivers || [];
          const availDrivers = drivers.filter(d => 
            (d.status === 'available' || !d.status) && 
            d.is_available === true
          );
          setAvailableDriversCount(availDrivers.length);
        }
        
      } catch (error) {
        console.error('Error fetching dashboard data:', error);
      } finally {
        setDashboardLoading(false);
      }
    };
    
    fetchDashboardData();
  }, [currentUser]);

  useEffect(() => {
    let alive = true;
    if (!currentUser || activeNav !== 'home') {
      if (carrierInsightsAbortRef.current) {
        carrierInsightsAbortRef.current.abort();
        carrierInsightsAbortRef.current = null;
      }
      return;
    }

    const fetchCarrierInsights = async () => {
      if (carrierInsightsAbortRef.current) {
        carrierInsightsAbortRef.current.abort();
      }
      const controller = new AbortController();
      carrierInsightsAbortRef.current = controller;
      setCarrierInsightsLoading(true);
      setCarrierInsightsError('');
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`${API_URL}/carrier/dashboard/insights`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!alive) return;
          setCarrierInsightsError(String(body?.detail || 'Failed to load carrier insights'));
          return;
        }
        const data = await res.json();
        if (!alive) return;
        setCarrierInsights(data || null);
      } catch (e) {
        if (e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('request cancelled')) {
          return;
        }
        if (!alive) return;
        setCarrierInsightsError(String(e?.message || 'Failed to load carrier insights'));
      } finally {
        if (carrierInsightsAbortRef.current === controller) {
          carrierInsightsAbortRef.current = null;
        }
        if (alive) setCarrierInsightsLoading(false);
      }
    };

    fetchCarrierInsights();
    const onFocus = () => {
      if (activeNav === 'home') fetchCarrierInsights();
    };
    const onVisibility = () => {
      if (!document.hidden && activeNav === 'home') fetchCarrierInsights();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const id = setInterval(() => {
      if (!document.hidden && activeNav === 'home') fetchCarrierInsights();
    }, 60000);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(id);
      if (carrierInsightsAbortRef.current) {
        carrierInsightsAbortRef.current.abort();
        carrierInsightsAbortRef.current = null;
      }
    };
  }, [activeNav, currentUser]);

  // Fetch messaging unread summary once (no polling)
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
    return () => {
      alive = false;
    };
  }, [currentUser]);

  // Fetch notifications
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
      // Set latest 3 notifications for home view
      setLatestNotifications((data?.notifications || []).slice(0, 3));
    } catch {
      // ignore
    } finally {
      setNotifLoading(false);
    }
  };

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
      setLatestNotifications((prev) => prev.map((n) => (n?.id === notificationId ? { ...n, is_read: true } : n)));
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
      markNotificationRead(id);
    }
    if (actionUrl) {
      setNotifOpen(false);
      navigate(actionUrl);
    }
  };

  // Fetch notifications on mount (no polling)
  useEffect(() => {
    if (!currentUser) return;
    fetchNotifications();
  }, [currentUser]);

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
          setCompanyProfile(data);
          if (typeof data.onboarding_score !== 'undefined') {
            setComplianceScore(data.onboarding_score);
          }
        }

        // also fetch compliance status to show current compliance score
        const complianceRes = await fetch(`${API_URL}/compliance/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (complianceRes.ok) {
          const cData = await complianceRes.json();
          if (typeof cData.compliance_score !== 'undefined') {
            setComplianceScore(cData.compliance_score);
          }
          // Set DOT and MC numbers from the extracted document values
          if (cData.dot_number) {
            setDotNumber(cData.dot_number);
          }
          if (cData.mc_number) {
            setMcNumber(cData.mc_number);
          }
        }
      } catch (error) {
        console.error('Error fetching profile:', error);
      } finally {
        setProfileLoading(false);
      }
    };
    fetchProfile();
  }, [currentUser]);

  // Fetch FMCSA verification summary (for header chips)
  useEffect(() => {
    let alive = true;
    if (!currentUser) return;

    const usdot = String(dotNumber || companyProfile?.data?.dotNumber || '').trim();
    const mc = String(mcNumber || companyProfile?.data?.mcNumber || '').trim();
    if (!usdot && !mc) return;

    (async () => {
      setFmcsaLoading(true);
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`${API_URL}/fmcsa/verify`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            usdot: usdot || undefined,
            mc_number: mc || undefined
          })
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        setFmcsaSummary(data);
      } catch {
        // ignore
      } finally {
        if (alive) setFmcsaLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [currentUser, dotNumber, mcNumber, companyProfile?.data?.dotNumber, companyProfile?.data?.mcNumber]);

  const dash = '—';
  const isFmcsaVerified = Boolean(
    fmcsaSummary?.verified === true || String(fmcsaSummary?.result || '').trim().toLowerCase() === 'verified'
  );
  const dotStatusText = (isFmcsaVerified
    ? 'ACTIVE'
    : String(
      fmcsaSummary?.dot_status || (fmcsaSummary?.result || '')
    ).trim()
  ) || dash;
  const operatingText = String(
    fmcsaSummary?.authority_status || fmcsaSummary?.operating_authority || ''
  ).trim() || dash;
  const safetyText = String(
    fmcsaSummary?.safety_rating || ''
  ).trim() || dash;
  const eldText = String(companyProfile?.data?.eldProvider || '').trim() || dash;

  // Fleet counts are aggregated from associated drivers' current vehicle types.
  const powerUnitsVal = vehicleCounts?.powerUnits;
  const reefersVal = vehicleCounts?.reefers;
  const dryVansVal = vehicleCounts?.dryVans;

  const navGroups = [
    {
      title: t(language, 'nav.operations', 'OPERATIONS'),
      items: [
        { key: 'home', label: t(language, 'nav.home', 'Home'), icon: 'fa-solid fa-house' },
        { key: 'my-loads', label: t(language, 'nav.myLoads', 'My Loads'), icon: 'fa-solid fa-truck' },
        { key: 'docs', label: t(language, 'nav.docs', 'Document Vault'), icon: 'fa-solid fa-folder' },
        { key: 'shippers', label: t(language, 'nav.shippersBrokers', 'My Shippers/Brokers'), icon: 'fa-solid fa-people-group' },
        { key: 'marketplace', label: t(language, 'nav.marketplace', 'Marketplace'), icon: 'fa-solid fa-store' },
        { key: 'drivers', label: t(language, 'nav.driversDispatches', 'Drivers & Dispatches'), icon: 'fa-solid fa-route' },
      ]
    },
    {
      title: t(language, 'nav.finance', 'FINANCE'),
      items: [
        { key: 'factoring', label: t(language, 'nav.factoringInvoicing', 'Factoring & Invoicing'), icon: 'fa-solid fa-dollar-sign' },
        { key: 'integrations', label: t(language, 'nav.integrations', 'Integrations'), icon: 'fa-solid fa-plug' }
      ]
    },
    {
      title: t(language, 'nav.management', 'MANAGEMENT'),
      items: [
        { key: 'compliance', label: t(language, 'nav.compliance', 'Compliance & Safety'), icon: 'fa-solid fa-shield-halved' },
        { key: 'esign', label: t(language, 'nav.esign', 'Consent & eSignature'), icon: 'fa-solid fa-pen-fancy' }
      ]
    },
    {
      title: t(language, 'nav.collaboration', 'COLLABORATION'),
      items: [
        { key: 'messaging', label: t(language, 'nav.messaging', 'Messaging'), icon: 'fa-solid fa-envelope' },
        { key: 'alerts', label: t(language, 'nav.alerts', 'Alerts & Notifications'), icon: 'fa-solid fa-bell' }
      ]
    },
    {
      title: t(language, 'nav.insights', 'INSIGHTS'),
      items: [
        { key: 'analytics', label: t(language, 'nav.analyticsReports', 'Analytics & Reports'), icon: 'fa-solid fa-chart-column' },
        { key: 'calendar', label: t(language, 'nav.calendar', 'Calendar'), icon: 'fa-solid fa-calendar-days' }
      ]
    },
    {
      title: t(language, 'nav.system', 'SYSTEM'),
      items: [
        { key: 'settings', label: t(language, 'nav.settings', 'Settings'), icon: 'fa-solid fa-gear' },
        { key: 'help', label: t(language, 'nav.helpHub', 'Help Hub'), icon: 'fa-regular fa-circle-question' },
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

  const runCarrierInsightAction = (actionTarget) => {
    const target = String(actionTarget || '').trim();
    if (!target) return;
    handleNavClick(target);
  };

  // Handle Report Fraud
  const handleReportFraud = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setShowReportFraudModal(true);
  };

  const handleSubmitReportFraud = async () => {
    if (!reportFraudData.message.trim()) {
      alert(t(language, 'dashboard.errors.enterMessage', 'Please enter a message'));
      return;
    }

    setIsSubmitting(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/report-fraud`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          subject: reportFraudData.subject || undefined,
          message: reportFraudData.message,
          user_email: currentUser.email,
          user_name: currentUser.displayName || currentUser.email?.split('@')[0]
        })
      });

      if (response.ok) {
        alert(t(language, 'dashboard.reportFraudSuccess', 'Fraud report submitted successfully!'));
        setReportFraudData({ subject: '', message: '' });
        setShowReportFraudModal(false);
      } else {
        const error = await response.json();
        alert(`${t(language, 'common.errorPrefix', 'Error:')} ${error.detail || t(language, 'dashboard.reportFraudFailed', 'Failed to submit fraud report')}`);
      }
    } catch (error) {
      console.error('Error submitting fraud report:', error);
      alert(t(language, 'dashboard.reportFraudFailedTryAgain', 'Failed to submit fraud report. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Suggest Edit
  const handleSuggestEdit = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setShowSuggestEditModal(true);
  };

  const handleSubmitSuggestEdit = async () => {
    if (!suggestEditData.message.trim()) {
      alert(t(language, 'dashboard.errors.enterSuggestion', 'Please enter a suggestion'));
      return;
    }

    setIsSubmitting(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/suggest-edit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          subject: suggestEditData.subject || undefined,
          message: suggestEditData.message,
          user_email: currentUser.email,
          user_name: currentUser.displayName || currentUser.email?.split('@')[0]
        })
      });

      if (response.ok) {
        alert(t(language, 'dashboard.suggestEditSuccess', 'Edit suggestion submitted successfully!'));
        setSuggestEditData({ subject: '', message: '' });
        setShowSuggestEditModal(false);
      } else {
        const error = await response.json();
        alert(`${t(language, 'common.errorPrefix', 'Error:')} ${error.detail || t(language, 'dashboard.suggestEditFailed', 'Failed to submit edit suggestion')}`);
      }
    } catch (error) {
      console.error('Error submitting edit suggestion:', error);
      alert(t(language, 'dashboard.suggestEditFailedTryAgain', 'Failed to submit edit suggestion. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Small router for the inner content area so the sidebar & topbar remain mounted
  function HomeView() {
    const carrierAiSuggestions = (Array.isArray(carrierInsights?.ai_suggestions) ? carrierInsights.ai_suggestions : [])
      .map((s, idx) => ({
        id: String(s?.id || `carrier_ai_${idx}`),
        title: String(s?.title || ''),
        detail: String(s?.detail || ''),
        action_label: String(s?.action_label || 'Open'),
        action_target: String(s?.action_target || ''),
      }))
      .filter((s) => s.title && s.detail);

    const fallbackCarrierAiSuggestions = [
      {
        id: 'fallback_compliance',
        title: t(language, 'dashboard.aiFallback.compliance.title', 'Compliance Renewal'),
        detail: t(language, 'dashboard.aiFallback.compliance.detail', 'Review expiring carrier documents to avoid operational risk.'),
        action_label: t(language, 'dashboard.aiFallback.compliance.action', 'Open Compliance'),
        action_target: 'compliance',
      },
      {
        id: 'fallback_marketplace',
        title: t(language, 'dashboard.aiFallback.marketplace.title', 'Load Opportunity'),
        detail: t(language, 'dashboard.aiFallback.marketplace.detail', 'Review marketplace opportunities and assign drivers for active lanes.'),
        action_label: t(language, 'dashboard.aiFallback.marketplace.action', 'Open Marketplace'),
        action_target: 'marketplace',
      },
    ];

    const renderedCarrierAiSuggestions =
      carrierAiSuggestions.length > 0 ? carrierAiSuggestions : fallbackCarrierAiSuggestions;

    return (
      <>
        <header className="fp-header">
          <div className="fp-header-titles">
            <h2>{t(language, 'nav.dashboard', 'Dashboard')}</h2>
            <p className="fp-subtitle">{t(language, 'dashboard.fleetTodaySubtitle', "Welcome back! Here's what's happening with your fleet today.")}</p>
          </div>
        </header>

        {/* Company Profile Card - Shows onboarding data */}
        {!profileLoading && companyProfile && companyProfile.data && (
          <section style={{ marginBottom: '20px' }}>
            <div className="card" style={{ padding: '20px', background: '#f8fafc' }}>
              <div className="card-header">
                <h3><i className="fa-solid fa-building" style={{ marginRight: '8px' }}></i>{t(language, 'dashboard.companyProfile', 'Company Profile')}</h3>
                {complianceScore !== null && (
                  <div className="pill" style={{ background:'#e0f2fe', color:'#075985', padding:'6px 10px', borderRadius:'999px', fontWeight:600 }}>
                    {t(language, 'dashboard.complianceScoreLabel', 'Compliance Score:')} {Math.round(complianceScore)}%
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '16px' }}>
                {companyProfile.data.companyName && (
                  <div><strong>{t(language, 'carrier.profile.companyLabel', 'Company:')}</strong> {companyProfile.data.companyName}</div>
                )}
                {companyProfile.data.dotNumber && (
                  <div><strong>{t(language, 'carrier.profile.dotNumberLabel', 'DOT Number:')}</strong> {companyProfile.data.dotNumber}</div>
                )}
                {companyProfile.data.mcNumber && (
                  <div><strong>{t(language, 'carrier.profile.mcNumberLabel', 'MC Number:')}</strong> {companyProfile.data.mcNumber}</div>
                )}
                {companyProfile.data.contactEmail && (
                  <div><strong>{t(language, 'carrier.profile.contactLabel', 'Contact:')}</strong> {companyProfile.data.contactEmail}</div>
                )}
                {companyProfile.data.fleetSize && (
                  <div><strong>{t(language, 'carrier.profile.fleetSizeLabel', 'Fleet Size:')}</strong> {companyProfile.data.fleetSize} {t(language, 'carrier.profile.units', 'units')}</div>
                )}
                {companyProfile.data.homeTerminal && (
                  <div><strong>{t(language, 'carrier.profile.homeTerminalLabel', 'Home Terminal:')}</strong> {companyProfile.data.homeTerminal}</div>
                )}
              </div>
              {!companyProfile.onboarding_completed && (
                <div style={{ marginTop: '16px', padding: '12px', background: '#fef3c7', borderRadius: '8px', color: '#92400e' }}>
                  <i className="fa-solid fa-exclamation-triangle" style={{ marginRight: '8px' }}></i>
                  {t(language, 'carrier.onboardingNotComplete', 'Onboarding not complete.')}{' '}
                  <span 
                    onClick={() => setActiveNav('settings')}
                    style={{ color: '#1d4ed8', textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    {t(language, 'carrier.completeNow', 'Complete now')}
                  </span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Onboarding Coach removed - compliance data now shown in Compliance & Safety page */}

        <section className="fp-grid">
          <div className="card stats-card">
            <div className="card-header">
              <h3>{t(language, 'dashboard.activeLoads', 'Active Loads')}</h3>
              <i className="fa-solid fa-truck cd-card-icon small" aria-hidden="true" />
            </div>
            <div className="stats">
              <div>{t(language, 'common.inProgress', 'In Progress')} <span>{dashboardLoading ? '...' : (activeLoads.inProgress ?? '-')}</span></div>
              <div>{t(language, 'dashboard.delivered', 'Delivered')} <span>{dashboardLoading ? '...' : (activeLoads.delivered ?? '-')}</span></div>
              <div>{t(language, 'dashboard.completed', 'Completed')} <span>{dashboardLoading ? '...' : (activeLoads.completed ?? '-')}</span></div>
            </div>
          </div>

          <div className="card compliance-card">
            <div className="card-header">
              <h3>{t(language, 'dashboard.driversCompliance', 'Drivers Compliance')}</h3>
              <i className="fa-solid fa-people-group cd-card-icon small" aria-hidden="true" />
            </div>
            <div className="stats">
              <div>{t(language, 'dashboard.activeDrivers', 'Active Drivers')} <span>{dashboardLoading ? '...' : (driversCompliance.active ?? '-')}</span></div>
              <div>{t(language, 'dashboard.expiringLicenses', 'Expiring Licenses')} <span>{dashboardLoading ? '...' : (driversCompliance.expiring ?? '-')}</span></div>
              <div>{t(language, 'dashboard.safetyAlerts', 'Safety Alerts')} <span>{dashboardLoading ? '...' : (driversCompliance.alerts ?? '-')}</span></div>
            </div>
          </div>

          <div className="card small-card expiring-card">
            <div className="card-header">
              <h3>{t(language, 'dashboard.expiringDocuments', 'Expiring Documents')}</h3>
              <i className="fa-solid fa-triangle-exclamation cd-card-icon small" aria-hidden="true" />
            </div>
            <div className="expiring-list">
              {dashboardLoading ? (
                <div style={{ padding: '8px', textAlign: 'center', color: '#6b7280' }}>{t(language, 'common.loading', 'Loading…')}</div>
              ) : expiringDocuments.length > 0 ? (
                expiringDocuments.map((doc, index) => (
                  <div key={index} className={`exp-item pill ${doc.type}`}>
                    <span className="exp-title">{doc.title}</span>
                    <span className={`exp-days ${doc.type}`}>{doc.days} {doc.days === 1 ? t(language, 'common.day', 'day') : t(language, 'common.days', 'days')}</span>
                  </div>
                ))
              ) : (
                <div style={{ padding: '8px', textAlign: 'center', color: '#6b7280', fontSize: '14px' }}>{t(language, 'dashboard.noExpiringDocuments', 'No expiring documents')}</div>
              )}
            </div>
          </div>

          <div className="card suggestions-card">
            <div className="card-header">
              <h3>{t(language, 'dashboard.aiSuggestions', 'AI Suggestions')}</h3>
              <i className="fa-solid fa-robot cd-card-icon small" aria-hidden="true" />
            </div>
            {carrierInsightsLoading && (
              <div className="muted" style={{ padding: '8px 0' }}>{t(language, 'dashboard.loadingInsights', 'Loading insights...')}</div>
            )}
            {carrierInsightsError && (
              <div className="muted" style={{ padding: '8px 0', color: '#b42318' }}>{carrierInsightsError}</div>
            )}
            <ul>
              {renderedCarrierAiSuggestions.slice(0, 3).map((s) => (
                <li key={s.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600 }}>{s.title}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{s.detail}</div>
                  <button
                    className="btn ghost-cd small"
                    style={{ marginTop: 6 }}
                    onClick={() => runCarrierInsightAction(s.action_target)}
                  >
                    {s.action_label || t(language, 'common.open', 'Open')}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="card earnings-card">
            <div className="card-header">
              <h3>{t(language, 'dashboard.earningsOverview', 'Earnings Overview')}</h3>
              <i className="fa-solid fa-dollar-sign cd-card-icon small" aria-hidden="true" />
            </div>
            <div className="stats earnings-stats">
              <div>{t(language, 'dashboard.thisWeekTitle', 'This Week')} <span className="green">{dashboardLoading ? '...' : fmtMoney(earnings.week)}</span></div>
              <div>{t(language, 'dashboard.thisMonthTitle', 'This Month')} <span className="green">{dashboardLoading ? '...' : fmtMoney(earnings.month)}</span></div>
              <div>{t(language, 'dashboard.factoringFunded', 'Factoring Funded')} <span className="blue">{dashboardLoading ? '...' : fmtMoney(earnings.factoring)}</span></div>
            </div>
          </div>

          <div className="card small-card integrations-card">
            <div className="card-header">
              <h3>{t(language, 'dashboard.integrationsHealth', 'Integrations Health')}</h3>
              <i className="fa-solid fa-plug cd-card-icon small" aria-hidden="true" />
            </div>
            <ul className="integrations-list">
              <li>{t(language, 'dashboard.quickbooks', 'QuickBooks')} <span className="dot green"/></li>
              <li>{t(language, 'dashboard.eldSystem', 'ELD System')} <span className="dot green"/></li>
              <li>{t(language, 'dashboard.bankConnection', 'Bank Connection')} <span className="dot orange"/></li>
              <li>{t(language, 'dashboard.factoring', 'Factoring')} <span className="dot green"/></li>
            </ul>
          </div>

          <div className="card recent-messages span-3">
            <div className="card-row">
              <h3>{t(language, 'dashboard.recentMessages', 'Recent Messages')}</h3>
              <a className="view-all" onClick={() => setActiveNav('messaging')} style={{ cursor: 'pointer' }}>{t(language, 'common.viewAll', 'View All')}</a>
            </div>
            <ul className="recent-list">
              {(dashboardLoading || recentUnreadLoading) ? (
                <li className="msg-item" style={{ justifyContent: 'center' }}>
                  <div className="muted">{t(language, 'common.loading', 'Loading…')}</div>
                </li>
              ) : (recentUnreadThreads || []).length > 0 ? (
                (recentUnreadThreads || []).map((thread) => {
                  const title = thread.display_title || thread.other_display_name || thread.title || t(language, 'messaging.conversation', 'Conversation');
                  const preview = (thread.last_message && thread.last_message.text) ? thread.last_message.text : t(language, 'messaging.unreadMessage', 'Unread message');
                  const ts = Number(thread.last_message_at || thread.updated_at || 0);
                  const timeLabel = ts ? new Date(ts * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';
                  const roleLabel = String(thread.kind || '').includes('shipper')
                    ? `- ${t(language, 'roles.shipper', 'Shipper')}`
                    : String(thread.kind || '').includes('driver')
                      ? `- ${t(language, 'roles.driver', 'Driver')}`
                      : '';

                  return (
                    <li
                      key={thread.id}
                      className="msg-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => { setInitialThreadId(thread.id); setActiveNav('messaging'); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setInitialThreadId(thread.id); setActiveNav('messaging'); } }}
                      style={{ cursor: 'pointer' }}
                    >
                      <img className="msg-avatar" src={peopleIcon} alt={t(language, 'messaging.chatAlt', 'chat')} />
                      <div className="msg-body">
                        <div className="msg-head">
                          <strong>{title}</strong> {roleLabel ? <span className="role">{roleLabel}</span> : null}
                        </div>
                        <div className="muted">{preview}</div>
                      </div>
                      <div className="msg-time">{timeLabel}</div>
                    </li>
                  );
                })
              ) : (
                <li
                  className="msg-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveNav('messaging')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveNav('messaging'); }}
                  style={{ cursor: 'pointer', justifyContent: 'center' }}
                >
                  <div className="muted">{t(language, 'dashboard.noUnreadMessages', 'No unread messages')}</div>
                </li>
              )}
            </ul>
          </div>

          <div className="card marketplace-snapshot span-3">
            <div className="card-row">
              <h3>{t(language, 'dashboard.marketplaceSnapshot', 'Marketplace Snapshot')}</h3>
              <button 
                className="btn ghost-cd small"
                onClick={() => { setActiveMarketplaceSection('loads'); setActiveNav('marketplace'); }}
                aria-label={t(language, 'dashboard.viewAllMarketplaceListings', 'View all marketplace listings')}
              >
                {t(language, 'dashboard.viewAllMarketplace', 'View All Marketplace')}
              </button>
            </div>
            <div className="market-grid">
              <div className="market-col loads">
                <h4 className="col-title">{t(language, 'dashboard.availableLoads', 'Available Loads')}</h4>
                {dashboardLoading ? (
                  <div style={{ padding: '16px', textAlign: 'center', color: '#6b7280' }}>{t(language, 'common.loading', 'Loading…')}</div>
                ) : marketplaceLoads.length > 0 ? (
                  marketplaceLoads.map((load, index) => {
                    const origin = typeof load.origin === 'string' ? load.origin : (load.origin?.city ? `${load.origin.city}, ${load.origin.state}` : t(language, 'loads.origin', 'Origin'));
                    const destination = typeof load.destination === 'string' ? load.destination : (load.destination?.city ? `${load.destination.city}, ${load.destination.state}` : t(language, 'loads.destination', 'Destination'));
                    const rate = load.total_rate || load.linehaul_rate || load.rate || 0;
                    const pickupDate = load.pickup_date || t(language, 'common.tbd', 'TBD');
                    
                    return (
                      <div 
                        key={index} 
                        className="load-item"
                        onClick={() => { setActiveMarketplaceSection('loads'); setActiveNav('marketplace'); }}
                        style={{ cursor: 'pointer', transition: 'background 0.2s' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div className="load-left">
                          <div className="load-route">{origin} → {destination}</div>
                          <div className="load-sub muted">{load.load_id || t(language, 'dashboard.load', 'Load')}</div>
                        </div>
                        <div className="load-right">
                          <div className="price green">{fmtMoney(rate)}</div>
                          <div className="pickup muted">{t(language, 'dashboard.pickup', 'Pickup')}: {pickupDate}</div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ padding: '16px', textAlign: 'center', color: '#6b7280', fontSize: '14px' }}>{t(language, 'dashboard.noAvailableLoads', 'No available loads')}</div>
                )}
              </div>

              <div className="market-col drivers">
                <h4 className="col-title">{t(language, 'dashboard.availableDrivers', 'Available Drivers')}</h4>
                <div className="driver-count">{dashboardLoading ? '...' : (availableDriversCount || '-')}</div>
                <div className="driver-sub muted">{t(language, 'dashboard.driversReadyForHire', 'Drivers ready for hire')}</div>
                <button className="btn small green-btn" onClick={() => { setActiveMarketplaceSection('drivers'); setActiveNav('marketplace'); }}>{t(language, 'dashboard.viewCandidates', 'View Candidates')}</button>
              </div>

              <div className="market-col offers">
                <h4 className="col-title">{t(language, 'dashboard.serviceOffers', 'Service Offers')}</h4>
                <div className="offer-item">
                  <div className="offer-left">{t(language, 'dashboard.fuelDiscount', 'Fuel Discount')}<div className="muted">{t(language, 'dashboard.saveFuel500', 'Save on fuel at 500+ locations')}</div></div>
                  <div className="offer-right"><span className="int-status-badge active">15% {t(language, 'common.off', 'OFF')}</span></div>
                </div>
                <div className="offer-item">
                  <div className="offer-left">{t(language, 'dashboard.factoringRate', 'Factoring Rate')}<div className="muted">{t(language, 'dashboard.specialRateNewClients', 'Special rate for new clients')}</div></div>
                  <div className="offer-right"><span className="int-status-badge active">1.5%</span></div>
                </div>
              </div>
            </div>
          </div>

          <div className="card notifications-card span-3">
            <div className="card-row">
              <h3>{t(language, 'dashboard.latestNotifications', 'Latest Notifications')}</h3>
              <a className="view-all" onClick={() => setActiveNav('alerts')} style={{ cursor: 'pointer' }}>{t(language, 'common.viewAll', 'View All')}</a>
            </div>
            <ul className="notifications-list">
              {latestNotifications.length === 0 ? (
                <li className="notification-item">
                  <div className="note-body">
                    <div className="note-sub muted">{t(language, 'dashboard.noNotificationsYet', 'No notifications yet.')}</div>
                  </div>
                </li>
              ) : (
                latestNotifications.map((notif) => {
                  // Determine dot color based on notification type
                  let dotColor = 'blue';
                  if (notif.notification_type === 'compliance_alert') dotColor = 'red';
                  else if (notif.notification_type === 'load_update') dotColor = 'orange';
                  else if (notif.notification_type === 'payment') dotColor = 'green';

                  return (
                    <li 
                      key={notif.id} 
                      className="notification-item"
                      style={{ cursor: notif.action_url ? 'pointer' : 'default' }}
                      onClick={() => handleNotifAction(notif)}
                    >
                      <div className="note-left">
                        <span className={`dot ${dotColor}`} style={{ opacity: notif.is_read ? 0.5 : 1 }} />
                      </div>
                      <div className="note-body">
                        <div className="note-title">{notif.title || t(language, 'dashboard.notification', 'Notification')}</div>
                        <div className="note-sub muted">{notif.message || ''}</div>
                      </div>
                      <div className="note-time">{notif.relative_time || notif.formatted_time || t(language, 'dashboard.recently', 'Recently')}</div>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </section>
      </>
    );
  }

  function ContentView({ activeNav }) {
    // For now, only 'home' renders the full dashboard; other routes show placeholders.
    switch (activeNav) {
      case 'home':
        return <HomeView />;
      case 'my-loads':
        return <MyLoads />;
      case 'docs':
        return <DocumentVault />;
      case 'shippers':
        return <ShipperPartners />;
      case 'marketplace':
        return <Marketplace activeSection={activeMarketplaceSection} setActiveSection={setActiveMarketplaceSection} />;
      case 'drivers':
        return <DriversAndDispatches />;
      case 'factoring':
        return <FactoringInvoicing />;
      case 'integrations':
        return <Integrations />;
      case 'compliance':
        return <ComplianceSafety />;
      case 'esign':
        return <ConsentESignature />;
      case 'messaging':
        return <Messaging initialThreadId={initialThreadId} />;
      case 'alerts':
        return <AlertsNotifications />;
      case 'analytics':
        return <Analytics />;
      case 'calendar':
        return <Calendar />;
      case 'settings':
        return <Settings />;
      case 'help':
        return <HelpHub />;
      default:
        return (
          <div>
            <header className="fp-header">
              <div className="fp-header-titles">
                <h2>{navGroups.flatMap(g => g.items).find(i => i.key === activeNav)?.label || t(language, 'common.view', 'View')}</h2>
                <p className="fp-subtitle">{t(language, 'dashboard.placeholder.subtitlePrefix', 'This is the')} {activeNav} {t(language, 'dashboard.placeholder.subtitleSuffix', 'view. Only the inner area changes.')}</p>
              </div>
            </header>
            <section className="fp-grid">
              <div className="card">
                <div className="card-header"><h3>{t(language, 'dashboard.placeholder.title', 'Placeholder')}</h3></div>
                <div style={{ padding: 20 }}>
                  <p>{t(language, 'dashboard.placeholder.bodyPrefix', 'Content for')} <strong>{activeNav}</strong> {t(language, 'dashboard.placeholder.bodySuffix', 'goes here. Replace this with real components as needed.')}</p>
                </div>
              </div>
            </section>
          </div>
        );
    }
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
                {/* verified moved into sidebar header; topbar inline chips removed */}
                <div className="ids">
                  <span className="id-pair"><span className="id-label">{t(language, 'carrier.dot', 'DOT')}:</span> <span className="id-value">{dotNumber || t(language, 'common.na', 'N/A')}</span></span>
                  <span className="ids-sep">•</span>
                  <span className="id-pair"><span className="id-label">{t(language, 'carrier.mc', 'MC')}:</span> <span className="id-value">{mcNumber || t(language, 'common.na', 'N/A')}</span></span>
                </div>
              </div>
            </div>
          </div>

          <div className="topbar-right actions-right">
            <div className="actions">
              <button type="button" className="btn small-cd"><i className="fa-solid fa-link"/> {t(language, 'common.connect', 'Connect')}</button>
              <button type="button" className="btn ghost-cd small" onClick={handleReportFraud}><i className="fa-solid fa-triangle-exclamation"/> {t(language, 'dashboard.reportFraud', 'Report Fraud')}</button>
              <button type="button" className="btn ghost-cd small" onClick={handleSuggestEdit}><i className="fa-solid fa-pen"/> {t(language, 'dashboard.suggestEdit', 'Suggest Edit')}</button>
            </div>
            {/* mobile-only icons in the first row: visible on small screens */}
            <div className="icons-mobile">
              <div
                className="notif"
                role="button"
                aria-label={t(language, 'alerts.open', 'Open Alerts & Notifications')}
                onClick={() => { setActiveNav('alerts'); setIsSidebarOpen(false); }}
              >
                <i className="fa-regular fa-bell notif-icon" aria-hidden="true" />
                {notifUnread > 0 && <span className="notif-badge">{notifUnread > 99 ? '99+' : notifUnread}</span>}
              </div>
              <i
                className="fa-solid fa-robot bot-icon"
                aria-hidden="true"
                role="button"
                aria-label={t(language, 'help.open', 'Open Help Hub')}
                onClick={() => { setActiveNav('help'); setIsSidebarOpen(false); }}
              />
              <img
                src="https://randomuser.me/api/portraits/men/75.jpg"
                alt="avatar"
                className="avatar-img"
                role="button"
                aria-label={t(language, 'settings.open', 'Open Settings')}
                onClick={() => { setActiveNav('settings'); setIsSidebarOpen(false); }}
              />
            </div>
          </div>
        </div>

        <div className="topbar-row topbar-row-2">
          <div className="topbar-left second-left">
            <div className="chips">
              <span className="chip-cd success">{t(language, 'carrier.dot', 'DOT')} {dotStatusText}{fmcsaLoading ? '…' : ''}</span>
              <span className="chip-cd info">{t(language, 'carrier.operating', 'Operating')}: {operatingText}</span>
              <span className="chip-cd yellow">{t(language, 'carrier.safety', 'Safety')}: {safetyText}</span>
              <span className="chip-cd blue">{t(language, 'carrier.eld', 'ELD')}: {eldText}</span>
            </div>
            <div className="fleet-stats">
              <span className="fleet-item"><i className="fa-solid fa-truck"/> <strong>{powerUnitsVal ?? dash}</strong> {t(language, 'carrier.powerUnits', 'Power Units')}</span>
              <span className="fleet-item"><i className="fa-solid fa-snowflake"/> <strong>{reefersVal ?? dash}</strong> {t(language, 'carrier.reefers', 'Reefers')}</span>
              <span className="fleet-item"><i className="fa-solid fa-box"/> <strong>{dryVansVal ?? dash}</strong> {t(language, 'carrier.dryVans', 'Dry Vans')}</span>
            </div>
          </div>

          <div className="topbar-right">
            <div className="icons">
              <span className="lang"><i className="fa-solid fa-globe"/> {languageCode}</span>
              <div
                className="notif"
                id="fp-notif-dropdown-root-2"
                style={{ position: 'relative' }}
                role="button"
                aria-label={t(language, 'alerts.open', 'Open Alerts & Notifications')}
              >
                <button
                  type="button"
                  onClick={() => {
                    setNotifOpen(false);
                    setActiveNav('alerts');
                    setIsSidebarOpen(false);
                  }}
                  aria-label={t(language, 'alerts.open', 'Open Alerts & Notifications')}
                  style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <i className="fa-regular fa-bell notif-icon" aria-hidden="true" />
                  {notifUnread > 0 && <span className="notif-badge">{notifUnread > 99 ? '99+' : notifUnread}</span>}
                </button>
              </div>
              <i
                className="fa-solid fa-robot bot-icon"
                aria-hidden="true"
                role="button"
                aria-label={t(language, 'help.open', 'Open Help Hub')}
                onClick={() => { setActiveNav('help'); setIsSidebarOpen(false); }}
              />
              <img
                src="https://randomuser.me/api/portraits/men/75.jpg"
                alt="avatar"
                className="avatar-img"
                role="button"
                aria-label={t(language, 'settings.open', 'Open Settings')}
                onClick={() => { setActiveNav('settings'); setIsSidebarOpen(false); }}
              />
            </div>
          </div>
        </div>
      </div>

  <div className={`fp-content-row ${isSidebarOpen ? 'sidebar-open' : ''}`}>
  <aside className={`fp-sidebar ${isSidebarOpen ? 'open' : ''} ${isSidebarDark ? 'dark' : ''}`}>
        <div className="sidebar-header">
          <div className="brand-row">
            <div className="logo"> <img src={logo} alt="FreightPower" className="landing-logo-image" /></div>
          </div>
          {/* DOT / MC line for mobile drawer */}
          <div className="ids mobile-ids">
            <div className="mobile-id-line"><span className="id-pair"><span className="id-label">{t(language, 'carrier.dot', 'DOT')}:</span> <span className="id-value">{dotNumber || t(language, 'common.na', 'N/A')}</span></span></div>
            <div className="mobile-id-line"><span className="id-pair"><span className="id-label">{t(language, 'carrier.mc', 'MC')}:</span> <span className="id-value">{mcNumber || t(language, 'common.na', 'N/A')}</span></span></div>
          </div>
          <div className="chips sidebar-chips">
            <span className="chip-cd success">{t(language, 'carrier.dot', 'DOT')} {dotStatusText}{fmcsaLoading ? '…' : ''}</span>
            <span className="chip-cd info">{t(language, 'carrier.operating', 'Operating')}: {operatingText}</span>
            <span className="chip-cd yellow">{t(language, 'carrier.safety', 'Safety')}: {safetyText}</span>
            <span className="chip-cd blue">{t(language, 'carrier.eld', 'ELD')}: {eldText}</span>
          </div>
          <div className="fleet-stats sidebar-fleet">
            <span className="fleet-item"><i className="fa-solid fa-truck"/> <strong>{powerUnitsVal ?? dash}</strong> {t(language, 'carrier.powerUnits', 'Power Units')}</span>
            <span className="fleet-item"><i className="fa-solid fa-snowflake"/> <strong>{reefersVal ?? dash}</strong> {t(language, 'carrier.reefers', 'Reefers')}</span>
            <span className="fleet-item"><i className="fa-solid fa-box"/> <strong>{dryVansVal ?? dash}</strong> {t(language, 'carrier.dryVans', 'Dry Vans')}</span>
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
                    onClick={() => { 
                      if (it.key === 'logout') {
                        handleLogout();
                      } else {
                        setActiveNav(it.key);
                        if (it.key === 'marketplace') {
                          setActiveMarketplaceSection('loads');
                        }
                        if (isSidebarOpen) setIsSidebarOpen(false);
                      }
                    }}
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
        {/* Dark mode control - toggles site theme when clicked */}
        <div className="sidebar-dark-control" aria-hidden="false">
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
        {/* action buttons in the mobile drawer */}
        <div className="sidebar-actions">
          <button type="button" className="btn small-cd"><i className="fa-solid fa-link"/> {t(language, 'common.connect', 'Connect')}</button>
          <button type="button" className="btn ghost-cd small" onClick={handleReportFraud}><i className="fa-solid fa-triangle-exclamation"/> {t(language, 'dashboard.reportFraud', 'Report Fraud')}</button>
          <button type="button" className="btn ghost-cd small subtle" onClick={handleSuggestEdit}><i className="fa-solid fa-pen"/> {t(language, 'dashboard.suggestEdit', 'Suggest Edit')}</button>
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

      {/* Report Fraud Modal */}
      {showReportFraudModal && (
        <div className="modal-overlay" onClick={() => !isSubmitting && setShowReportFraudModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2><i className="fa-solid fa-triangle-exclamation" style={{ marginRight: '8px', color: '#dc2626' }}></i>{t(language, 'dashboard.reportFraud', 'Report Fraud')}</h2>
              <button type="button" className="modal-close" onClick={() => !isSubmitting && setShowReportFraudModal(false)} disabled={isSubmitting}>
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="fraud-subject">{t(language, 'common.subjectOptional', 'Subject (Optional)')}</label>
                <input
                  type="text"
                  id="fraud-subject"
                  value={reportFraudData.subject}
                  onChange={(e) => setReportFraudData({ ...reportFraudData, subject: e.target.value })}
                  placeholder={t(language, 'dashboard.fraudSubjectPlaceholder', 'Brief description of the issue')}
                  disabled={isSubmitting}
                />
              </div>
              <div className="form-group">
                <label htmlFor="fraud-message">{t(language, 'common.message', 'Message')} <span style={{ color: '#dc2626' }}>*</span></label>
                <textarea
                  id="fraud-message"
                  value={reportFraudData.message}
                  onChange={(e) => setReportFraudData({ ...reportFraudData, message: e.target.value })}
                  placeholder={t(language, 'dashboard.fraudMessagePlaceholder', 'Please provide details about the fraud or suspicious activity...')}
                  rows={6}
                  required
                  disabled={isSubmitting}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn ghost-cd" onClick={() => setShowReportFraudModal(false)} disabled={isSubmitting}>
                {t(language, 'common.cancel', 'Cancel')}
              </button>
              <button type="button" className="btn primary" onClick={handleSubmitReportFraud} disabled={isSubmitting || !reportFraudData.message.trim()}>
                {isSubmitting ? t(language, 'common.submitting', 'Submitting...') : t(language, 'dashboard.submitReport', 'Submit Report')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suggest Edit Modal */}
      {showSuggestEditModal && (
        <div className="modal-overlay" onClick={() => !isSubmitting && setShowSuggestEditModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2><i className="fa-solid fa-pen" style={{ marginRight: '8px', color: '#2563eb' }}></i>{t(language, 'dashboard.suggestEdit', 'Suggest Edit')}</h2>
              <button type="button" className="modal-close" onClick={() => !isSubmitting && setShowSuggestEditModal(false)} disabled={isSubmitting}>
                <i className="fa-solid fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="edit-subject">{t(language, 'common.subjectOptional', 'Subject (Optional)')}</label>
                <input
                  type="text"
                  id="edit-subject"
                  value={suggestEditData.subject}
                  onChange={(e) => setSuggestEditData({ ...suggestEditData, subject: e.target.value })}
                  placeholder={t(language, 'dashboard.editSubjectPlaceholder', 'Brief description of your suggestion')}
                  disabled={isSubmitting}
                />
              </div>
              <div className="form-group">
                <label htmlFor="edit-message">{t(language, 'common.suggestion', 'Suggestion')} <span style={{ color: '#dc2626' }}>*</span></label>
                <textarea
                  id="edit-message"
                  value={suggestEditData.message}
                  onChange={(e) => setSuggestEditData({ ...suggestEditData, message: e.target.value })}
                  placeholder={t(language, 'dashboard.editMessagePlaceholder', 'Please describe your suggestion or edit...')}
                  rows={6}
                  required
                  disabled={isSubmitting}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn ghost-cd" onClick={() => setShowSuggestEditModal(false)} disabled={isSubmitting}>
                {t(language, 'common.cancel', 'Cancel')}
              </button>
              <button type="button" className="btn primary" onClick={handleSubmitSuggestEdit} disabled={isSubmitting || !suggestEditData.message.trim()}>
                {isSubmitting ? t(language, 'common.submitting', 'Submitting...') : t(language, 'dashboard.submitSuggestion', 'Submit Suggestion')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
