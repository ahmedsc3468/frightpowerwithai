import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import { getJson, postJson } from '../../api/http';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { startRegistration } from '../../utils/webauthn';
import '../../styles/driver/AccountSettings.css';
import '../../styles/carrier/Marketplace.css';
import { LANGUAGE_OPTIONS, t } from '../../i18n/translate';

export default function AccountSettings({ onProfileUpdate, onNavigate }) {
  const { currentUser } = useAuth();
  const location = useLocation();
  const { settings: userSettings, patchSettings, setSettings: setUserSettings } = useUserSettings();
  const language = userSettings?.language || 'English';
  const tr = useCallback((key, fallback) => t(language, key, fallback), [language]);
  const fileInputRef = useRef(null);
  const userSettingsRef = useRef(userSettings);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [profileData, setProfileData] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    profilePicture: null,
    emergency_contact_name: '',
    emergency_contact_relationship: '',
    emergency_contact_phone: ''
  });
  const [message, setMessage] = useState({ type: '', text: '' });
  const [prefsSaving, setPrefsSaving] = useState(false);

  // Profile section tabs
  const [profileTab, setProfileTab] = useState('profile'); // 'profile' | 'onboarding'

  // Onboarding Center state
  const [requiredDocs, setRequiredDocs] = useState(null);
  const [requiredDocsLoading, setRequiredDocsLoading] = useState(false);
  const [requiredDocsError, setRequiredDocsError] = useState('');
  const [onboardingSaving, setOnboardingSaving] = useState(false);

  const didLoadOnboardingOnceRef = useRef(false);
  const lastUserIdRef = useRef(null);

  // Calendar integration (OAuth + sync)
  const [calendarStatus, setCalendarStatus] = useState({
    google: { connected: false, updated_at: null },
    outlook: { connected: false, updated_at: null },
    last_synced_at: null,
  });
  const [calendarBusy, setCalendarBusy] = useState(false);
  const didAutoSyncRef = useRef(false);

  // Reports + Support
  const [reportBusy, setReportBusy] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportForm, setSupportForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [supportBusy, setSupportBusy] = useState(false);

  // Security section state
  const [securityView, setSecurityView] = useState(null); // 'password' | 'mfa' | 'biometric' | 'sessions'
  const [me, setMe] = useState(null);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [pwForm, setPwForm] = useState({ current_password: '', new_password: '' });
  const [profileUpdates, setProfileUpdates] = useState([]);

  // Marketplace profile preview modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewDriverCard, setPreviewDriverCard] = useState(null);

  useEffect(() => {
    userSettingsRef.current = userSettings;
  }, [userSettings]);

  useEffect(() => {
    try {
      const qs = new URLSearchParams(location.search || '');
      const tab = String(qs.get('tab') || qs.get('settingsTab') || '').trim().toLowerCase();
      if (tab === 'onboarding' || tab === 'onboarding_center' || tab === 'onboarding-center') {
        setProfileTab('onboarding');
      }
    } catch {
      // ignore
    }
  }, [location.search]);

  useEffect(() => {
    const uid = currentUser?.uid || null;
    if (uid !== lastUserIdRef.current) {
      lastUserIdRef.current = uid;
      didLoadOnboardingOnceRef.current = false;
    }
  }, [currentUser]);

  const trRequiredStatus = useCallback((status) => {
    if (status === 'Missing') return tr('accountSettings.onboarding.status.missing', 'Missing');
    if (status === 'Expired') return tr('accountSettings.onboarding.status.expired', 'Expired');
    if (status === 'Expiring Soon') return tr('accountSettings.onboarding.status.expiringSoon', 'Expiring Soon');
    if (status === 'Valid') return tr('accountSettings.onboarding.status.valid', 'Valid');
    if (status === 'Complete') return tr('accountSettings.onboarding.status.complete', 'Complete');
    return String(status || '');
  }, [tr]);

  const requiredItemTitle = useCallback((key, fallback) => {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return fallback || '';
    return tr(`accountSettings.onboarding.items.${k}.title`, fallback || k);
  }, [tr]);

  const requiredItemDescription = useCallback((key, fallback) => {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return fallback || '';
    return tr(`accountSettings.onboarding.items.${k}.description`, fallback || '');
  }, [tr]);

  const fetchRequiredDocs = useCallback(async () => {
    if (!currentUser) return;
    try {
      setRequiredDocsLoading(true);
      setRequiredDocsError('');
      const data = await getJson('/onboarding/driver/required-docs', {
        requestLabel: 'GET /onboarding/driver/required-docs (onboarding center)',
        timeoutMs: 45000,
      });
      setRequiredDocs(data);
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.toLowerCase().includes('request timed out')) {
        setRequiredDocsError(tr('accountSettings.onboarding.requestTimedOut', 'Request timed out. Please click Refresh to try again.'));
      } else {
        setRequiredDocsError(msg || tr('accountSettings.onboarding.failedToLoad', 'Failed to load onboarding checklist.'));
      }
    } finally {
      setRequiredDocsLoading(false);
    }
  }, [currentUser, tr]);

  useEffect(() => {
    if (profileTab !== 'onboarding') return;
    if (didLoadOnboardingOnceRef.current) return;
    didLoadOnboardingOnceRef.current = true;
    fetchRequiredDocs();
  }, [profileTab, fetchRequiredDocs]);

  const openDocUpload = useCallback((docType) => {
    const dt = String(docType || '').trim();
    if (!dt) return;
    if (typeof onNavigate === 'function') {
      onNavigate('docs');
      setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent('fp:documentvault-open-upload', { detail: { docType: dt } }));
        } catch {
          // ignore
        }
      }, 120);
      return;
    }
    setMessage({ type: 'error', text: tr('accountSettings.onboarding.unableToOpenDocs', 'Unable to open Document Vault from this screen.') });
  }, [onNavigate, tr]);

  const openConsent = useCallback(() => {
    if (typeof onNavigate === 'function') {
      onNavigate('esign');
      return;
    }
    setMessage({ type: 'error', text: tr('accountSettings.onboarding.unableToOpenConsent', 'Unable to open Consent & E-Signature from this screen.') });
  }, [onNavigate, tr]);

  const saveOnboardingQuickFixes = useCallback(async () => {
    if (!currentUser) return;
    try {
      setOnboardingSaving(true);
      setMessage({ type: '', text: '' });

      const payload = {
        fullName: profileData.fullName,
        phone: profileData.phone,
      };

      await postJson('/onboarding/update-profile', payload, { requestLabel: 'POST /onboarding/update-profile (onboarding center quick fixes)' });

      setMessage({ type: 'success', text: tr('accountSettings.onboarding.saved', 'Onboarding updates saved.') });
      if (typeof onProfileUpdate === 'function') onProfileUpdate();
      fetchRequiredDocs();
      setTimeout(() => setMessage({ type: '', text: '' }), 2500);
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.onboarding.saveFailed', 'Failed to save onboarding updates.') });
    } finally {
      setOnboardingSaving(false);
    }
  }, [currentUser, profileData.fullName, profileData.phone, postJson, tr, onProfileUpdate, fetchRequiredDocs]);

  useEffect(() => {
    const detectDark = () => {
      const dashboardRoot = document.querySelector('.dd-driver-dashboard');
      if (dashboardRoot) return dashboardRoot.classList.contains('dark-root');
      return (
        document.body.classList.contains('dark-root') ||
        document.documentElement.classList.contains('dark-root')
      );
    };

    const update = () => setIsDarkMode(detectDark());
    update();

    const dashboardRoot = document.querySelector('.dd-driver-dashboard');
    if (!dashboardRoot) return;
    const observer = new MutationObserver(() => update());
    observer.observe(dashboardRoot, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const asTheme = {
    text: isDarkMode ? '#f1f5f9' : '#0f172a',
    body: isDarkMode ? '#d1d5db' : '#374151',
    muted: isDarkMode ? '#94a3b8' : '#6b7280',
    border: isDarkMode ? '#353535' : '#e2e8f0',
    surface: isDarkMode ? '#2c2c2c' : '#ffffff',
    surfaceAlt: isDarkMode ? '#1f2937' : '#f8fafc'
  };

  useEffect(() => {
    fetchProfileData();
  }, [currentUser]);

  useEffect(() => {
    // Keep a fresh /auth/me snapshot for Security UI.
    if (!currentUser) {
      setMe(null);
      return;
    }
    (async () => {
      try {
        const data = await getJson('/auth/me', { requestLabel: 'GET /auth/me (driver security)' });
        setMe(data);
      } catch {
        // ignore
      }
    })();
  }, [currentUser]);

  const fetchProfileData = async () => {
    if (!currentUser) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      // Use /auth/me as the canonical profile source.
      // This avoids relying on onboarding documents and ensures emergency contacts persist.
      const me = await getJson('/auth/me', { requestLabel: 'GET /auth/me (driver settings)' });
      setProfileData({
        fullName: me?.name || '',
        email: me?.email || currentUser.email || '',
        phone: me?.phone || '',
        address: me?.address || '',
        profilePicture: me?.profile_picture_url || null,
        emergency_contact_name: me?.emergency_contact_name || '',
        emergency_contact_relationship: me?.emergency_contact_relationship || '',
        emergency_contact_phone: me?.emergency_contact_phone || ''
      });
    } catch (error) {
      console.error('Error fetching profile:', error);
      setMessage({ type: 'error', text: tr('accountSettings.profile.failedToLoad', 'Failed to load profile data') });
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field, value) => {
    setProfileData(prev => ({ ...prev, [field]: value }));
  };

  const handlePhotoClick = () => {
    fileInputRef.current?.click();
  };

  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setMessage({ type: 'error', text: tr('accountSettings.profile.invalidFileType', 'Invalid file type. Please upload JPG, PNG, GIF, or WebP') });
      return;
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ type: 'error', text: tr('accountSettings.profile.fileTooLarge', 'File size must be less than 5MB') });
      return;
    }

    try {
      setUploading(true);
      setMessage({ type: '', text: '' });
      const token = await currentUser.getIdToken();
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API_URL}/auth/profile/picture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      if (response.ok) {
        const result = await response.json();
        setProfileData(prev => ({ ...prev, profilePicture: result.profile_picture_url }));
        setMessage({ type: 'success', text: tr('accountSettings.profile.photoUploadSuccess', 'Profile picture uploaded successfully!') });
        if (onProfileUpdate) onProfileUpdate();
        setTimeout(() => setMessage({ type: '', text: '' }), 3000);
      } else {
        const error = await response.json();
        setMessage({ type: 'error', text: error.detail || tr('accountSettings.profile.photoUploadFailed', 'Failed to upload profile picture') });
      }
    } catch (error) {
      console.error('Error uploading picture:', error);
      setMessage({ type: 'error', text: tr('accountSettings.profile.photoUploadFailed', 'Failed to upload profile picture') });
    } finally {
      setUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSaveProfile = async () => {
    if (!currentUser) return;

    try {
      setSaving(true);
      setMessage({ type: '', text: '' });
      const _token = await currentUser.getIdToken();
      
      const updateData = {
        phone: profileData.phone,
        address: profileData.address,
        emergency_contact_name: profileData.emergency_contact_name,
        emergency_contact_relationship: profileData.emergency_contact_relationship,
        emergency_contact_phone: profileData.emergency_contact_phone,
      };

      // Add name field if it exists
      if (profileData.fullName) {
        updateData.name = profileData.fullName;
        updateData.fullName = profileData.fullName;
        const nameParts = profileData.fullName.split(' ');
        if (nameParts.length > 0) {
          updateData.first_name = nameParts[0];
          if (nameParts.length > 1) {
            updateData.last_name = nameParts.slice(1).join(' ');
          }
        }
      }

      // Update via backend profile endpoint (single source of truth).
      await postJson('/auth/profile/update', updateData, { requestLabel: 'POST /auth/profile/update (driver settings)' });

      console.log('✅ Profile saved:', updateData);
      setMessage({ type: 'success', text: tr('accountSettings.profile.saved', 'Profile updated and saved!') });
      if (onProfileUpdate) onProfileUpdate();
      // Refresh from backend to ensure UI reflects persisted data.
      await fetchProfileData();
      setTimeout(() => setMessage({ type: '', text: '' }), 3000);
    } catch (error) {
      console.error('Error saving profile:', error);
      const detail = error?.message || tr('accountSettings.profile.saveFailedTryAgain', 'Failed to update profile. Please try again.');
      setMessage({ type: 'error', text: detail });
    } finally {
      setSaving(false);
    }
  };

  const updateSettings = async (partial, label) => {
    const before = userSettingsRef.current;

    try {
      setPrefsSaving(true);

      // Optimistic UI update so accessibility/theming changes apply immediately.
      setUserSettings((prev) => {
        const safePrev = prev || {};
        const next = { ...safePrev, ...partial };

        if (partial?.notification_preferences && typeof partial.notification_preferences === 'object') {
          next.notification_preferences = {
            ...(safePrev.notification_preferences || {}),
            ...partial.notification_preferences,
          };
        }

        return next;
      });

      await patchSettings(partial, { requestLabel: label || 'PATCH /auth/settings (driver settings)' });
      setMessage({ type: 'success', text: tr('accountSettings.preferences.saved', 'Preferences saved') });
      setTimeout(() => setMessage({ type: '', text: '' }), 2000);
    } catch (e) {
      // Roll back optimistic update if the server rejects the change.
      if (before) setUserSettings(before);
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.preferences.saveFailed', 'Failed to save preferences') });
    } finally {
      setPrefsSaving(false);
    }
  };

  const selectedCalendarProvider = useMemo(() => {
    const v = String(userSettings?.calendar_sync || '').toLowerCase();
    if (v.includes('outlook')) return 'outlook';
    return 'google';
  }, [userSettings?.calendar_sync]);

  const fetchCalendarStatus = useCallback(async () => {
    if (!currentUser) return;
    try {
      const status = await getJson('/calendar/status', { requestLabel: 'GET /calendar/status' });
      setCalendarStatus(status || {
        google: { connected: false, updated_at: null },
        outlook: { connected: false, updated_at: null },
        last_synced_at: null,
      });
    } catch {
      // ignore
    }
  }, [currentUser]);

  useEffect(() => {
    fetchCalendarStatus();
  }, [fetchCalendarStatus]);

  const startCalendarConnect = useCallback(async () => {
    if (!currentUser) return;
    setCalendarBusy(true);
    setMessage({ type: '', text: '' });
    try {
      const returnTo = `${window.location.pathname}${window.location.search || ''}`;
      const data = await getJson(
        `/calendar/oauth/${selectedCalendarProvider}/start?return_to=${encodeURIComponent(returnTo)}`,
        { requestLabel: `GET /calendar/oauth/${selectedCalendarProvider}/start`, timeoutMs: 25000 }
      );
      const url = data?.auth_url;
      if (!url) throw new Error(tr('accountSettings.calendar.startFailed', 'Failed to start calendar connection'));
      window.location.assign(url);
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.calendar.connectFailed', 'Failed to connect calendar') });
      setCalendarBusy(false);
    }
  }, [currentUser, selectedCalendarProvider]);

  const disconnectCalendar = useCallback(async () => {
    if (!currentUser) return;
    setCalendarBusy(true);
    setMessage({ type: '', text: '' });
    try {
      await postJson(
        '/calendar/disconnect',
        { provider: selectedCalendarProvider },
        { requestLabel: 'POST /calendar/disconnect' }
      );
      await fetchCalendarStatus();
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.calendar.disconnectFailed', 'Failed to disconnect calendar') });
    } finally {
      setCalendarBusy(false);
    }
  }, [currentUser, fetchCalendarStatus, selectedCalendarProvider]);

  const buildUpcomingEvents = useCallback(async () => {
    const parseDateOnly = (value) => {
      const s = String(value || '').trim();
      if (!s) return null;
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]) - 1;
        const d = Number(m[3]);
        const dt = new Date(y, mo, d);
        if (!Number.isNaN(dt.getTime())) return dt;
      }
      const dt = new Date(s);
      if (!Number.isNaN(dt.getTime())) return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      return null;
    };

    const pad2 = (n) => String(n).padStart(2, '0');
    const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const addDays = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + Number(days || 0));

    const today = new Date();
    const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const [loadsResp, docsResp] = await Promise.all([
      getJson('/loads', { requestLabel: 'GET /loads (calendar sync)' }).catch(() => ({})),
      getJson('/documents', { requestLabel: 'GET /documents (calendar sync)' }).catch(() => ({})),
    ]);

    const loads = Array.isArray(loadsResp?.loads) ? loadsResp.loads : [];
    const docs = Array.isArray(docsResp?.documents) ? docsResp.documents : (Array.isArray(docsResp) ? docsResp : []);

    const events = [];

    for (const l of loads) {
      const loadId = String(l?.load_id || l?.id || l?.loadId || '').trim();
      const loadNumber = String(l?.load_number || '').trim() || loadId || '—';
      const status = String(l?.status || '').trim();

      const pickup = parseDateOnly(l?.pickup_date);
      const delivery = parseDateOnly(l?.delivery_date);

      if (pickup && pickup.getTime() >= todayDateOnly.getTime()) {
        const start = toYmd(pickup);
        const end = toYmd(addDays(pickup, 1));
        events.push({
          internal_id: `load:${loadId}:pickup:${start}`,
          title: tr('accountSettings.calendar.pickupLoadPrefix', 'Pickup: Load ') + loadNumber,
          all_day: true,
          start,
          end,
          description: loadId
            ? tr('accountSettings.calendar.descLoadPrefix', 'Load: ') + loadId + '\n' + tr('accountSettings.calendar.descStatusPrefix', 'Status: ') + status
            : undefined,
        });
      }

      if (delivery && delivery.getTime() >= todayDateOnly.getTime()) {
        const start = toYmd(delivery);
        const end = toYmd(addDays(delivery, 1));
        events.push({
          internal_id: `load:${loadId}:delivery:${start}`,
          title: tr('accountSettings.calendar.deliveryLoadPrefix', 'Delivery: Load ') + loadNumber,
          all_day: true,
          start,
          end,
          description: loadId
            ? tr('accountSettings.calendar.descLoadPrefix', 'Load: ') + loadId + '\n' + tr('accountSettings.calendar.descStatusPrefix', 'Status: ') + status
            : undefined,
        });
      }
    }

    for (const d of docs) {
      const exp = parseDateOnly(d?.expiry_date || d?.extracted_fields?.expiry_date);
      if (!exp) continue;
      if (exp.getTime() < todayDateOnly.getTime()) continue;
      const kind = String(d?.type || d?.document_type || tr('accountSettings.calendar.documentKindDefault', 'Document')).replace(/_/g, ' ').toUpperCase();
      const docId = String(d?.id || d?.doc_id || '').trim();
      const start = toYmd(exp);
      const end = toYmd(addDays(exp, 1));
      events.push({
        internal_id: `doc:${docId}:expiry:${start}`,
        title: `${kind}${tr('accountSettings.calendar.expiresSuffix', ' expires')}`,
        all_day: true,
        start,
        end,
        description: docId ? tr('accountSettings.calendar.descDocumentPrefix', 'Document: ') + docId : undefined,
      });
    }

    const seen = new Set();
    const out = [];
    for (const e of events) {
      const id = String(e?.internal_id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(e);
    }
    return out;
  }, []);

  const syncUpcomingEvents = useCallback(async (opts = {}) => {
    if (!currentUser) return;
    setCalendarBusy(true);
    setMessage({ type: '', text: '' });
    try {
      const events = await buildUpcomingEvents();
      const remindersEnabled = Boolean(userSettingsRef.current?.calendar_reminders_enabled !== false);
      const res = await postJson(
        '/calendar/sync',
        {
          provider: selectedCalendarProvider,
          events,
          reminders_enabled: remindersEnabled,
        },
        { requestLabel: 'POST /calendar/sync', timeoutMs: 25000 }
      );
      await fetchCalendarStatus();
      if (!opts?.silent) {
        const synced = Number(res?.synced || 0);
        setMessage({
          type: 'success',
          text: synced
            ? tr('accountSettings.calendar.syncedPrefix', 'Synced ') + synced + tr('accountSettings.calendar.syncedSuffix', ' events to your calendar.')
            : tr('accountSettings.calendar.noUpcomingToSync', 'No upcoming events to sync.'),
        });
        setTimeout(() => setMessage({ type: '', text: '' }), 3000);
      }
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.calendar.syncFailed', 'Calendar sync failed') });
    } finally {
      setCalendarBusy(false);
    }
  }, [buildUpcomingEvents, currentUser, fetchCalendarStatus, selectedCalendarProvider]);

  useEffect(() => {
    // Redirect back from OAuth callback: /driver-dashboard?nav=settings&calendar_connected=1&calendar_auto_sync=1
    try {
      const qs = new URLSearchParams(window.location.search || '');
      const connected = qs.get('calendar_connected') === '1';
      const autoSync = qs.get('calendar_auto_sync') === '1';
      if (!connected) return;
      fetchCalendarStatus();
      if (autoSync && !didAutoSyncRef.current) {
        didAutoSyncRef.current = true;
        setTimeout(() => {
          syncUpcomingEvents({ silent: false }).catch(() => {});
        }, 350);
      }
    } catch {
      // ignore
    }
  }, [fetchCalendarStatus, syncUpcomingEvents]);

  const formatDriverForMarketplaceCard = (driver) => {
    const endorsements = [];
    if (driver?.hazmat_endorsement) endorsements.push('hazmat');
    if (driver?.tanker_endorsement) endorsements.push('tanker');
    if (driver?.doubles_triples) endorsements.push('doubleTriple');
    if (driver?.passenger_endorsement) endorsements.push('passenger');
    if (endorsements.length === 0) endorsements.push('none');

    const equipmentTypes = [];
    if (driver?.cdl_verified) equipmentTypes.push({ code: 'cdlValid', variant: 'valid', icon: 'fa-check-circle' });
    if (driver?.medical_card_verified) equipmentTypes.push({ code: 'medCardActive', variant: 'valid', icon: 'fa-check-circle' });
    if (driver?.drug_test_status === 'passed') equipmentTypes.push({ code: 'mvrClean', variant: 'valid', icon: 'fa-check-circle' });

    const name = driver?.name || tr('accountSettings.marketplacePreview.unknownDriver', 'Unknown Driver');
    const photo = driver?.profile_picture_url
      || driver?.photo_url
      || driver?.photo
      || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || tr('accountSettings.common.driverFallback', 'Driver'))}&background=random`;

    return {
      id: driver?.id || driver?.driver_id,
      name,
      rating: driver?.rating || 0,
      trips: driver?.total_deliveries || driver?.total_loads || 0,
      class: driver?.cdl_class ? `${driver?.cdl_class} - ${driver?.cdl_state || ''}` : tr('accountSettings.common.na', 'N/A'),
      location: driver?.current_location || driver?.current_city || tr('accountSettings.common.unknown', 'Unknown'),
      lastActivity: tr('accountSettings.marketplacePreview.recentlyActive', 'Recently active'),
      endorsements,
      safetyScore: driver?.safety_score || 0,
      available: driver?.status === 'available',
      equipmentTypes: equipmentTypes.length > 0 ? equipmentTypes : [{ code: 'pendingVerification', variant: 'invalid', icon: 'fa-times-circle' }],
      photo,
    };
  };

  const endorsementLabel = (code) => {
    switch (code) {
      case 'hazmat':
        return tr('accountSettings.marketplacePreview.endorsementHazmat', 'Hazmat');
      case 'tanker':
        return tr('accountSettings.marketplacePreview.endorsementTanker', 'Tanker');
      case 'doubleTriple':
        return tr('accountSettings.marketplacePreview.endorsementDoubleTriple', 'Double/Triple');
      case 'passenger':
        return tr('accountSettings.marketplacePreview.endorsementPassenger', 'Passenger');
      case 'none':
      default:
        return tr('accountSettings.marketplacePreview.endorsementNone', 'None');
    }
  };

  const equipmentLabel = (code) => {
    switch (code) {
      case 'cdlValid':
        return tr('accountSettings.marketplacePreview.equipmentCdlValid', 'CDL Valid');
      case 'medCardActive':
        return tr('accountSettings.marketplacePreview.equipmentMedCardActive', 'Med Card Active');
      case 'mvrClean':
        return tr('accountSettings.marketplacePreview.equipmentMvrClean', 'MVR Clean');
      case 'pendingVerification':
      default:
        return tr('accountSettings.marketplacePreview.equipmentPendingVerification', 'Pending Verification');
    }
  };

  const openPreviewMarketplaceProfile = async () => {
    setPreviewOpen(true);
    if (previewDriverCard || previewBusy) return;

    setPreviewBusy(true);
    setPreviewError('');
    try {
      const raw = await getJson('/drivers/me', { requestLabel: 'GET /drivers/me (driver preview)' });
      setPreviewDriverCard(formatDriverForMarketplaceCard(raw || {}));
    } catch {
      setPreviewError(tr('accountSettings.marketplacePreview.failedToLoad', 'Failed to load marketplace profile preview.'));
    } finally {
      setPreviewBusy(false);
    }
  };

  const openSecurity = async (view) => {
    setSecurityView(view);

    if (view === 'sessions') {
      try {
        const res = await getJson('/auth/profile/updates', { requestLabel: 'GET /auth/profile/updates' });
        setProfileUpdates(Array.isArray(res?.items) ? res.items : []);
      } catch (e) {
        setProfileUpdates([]);
        setMessage({ type: 'error', text: e?.message || tr('accountSettings.security.activityLogLoadFailed', 'Failed to load activity log') });
      }
    }
  };

  const closeSecurity = () => {
    setSecurityView(null);
    setSecurityBusy(false);
    setPwForm({ current_password: '', new_password: '' });
  };

  const handleChangePassword = async () => {
    try {
      setSecurityBusy(true);
      await postJson('/auth/password/change', pwForm, { requestLabel: 'POST /auth/password/change' });
      setMessage({ type: 'success', text: tr('accountSettings.security.passwordUpdated', 'Password updated successfully') });
      closeSecurity();
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.security.passwordChangeFailed', 'Failed to change password') });
    } finally {
      setSecurityBusy(false);
    }
  };

  const handleToggleMfa = async (enable) => {
    try {
      setSecurityBusy(true);
      await postJson('/auth/mfa-toggle', { enable: Boolean(enable), method: 'sms' }, { requestLabel: 'POST /auth/mfa-toggle (sms)' });
      const fresh = await getJson('/auth/me', { requestLabel: 'GET /auth/me (after mfa-toggle)' });
      setMe(fresh);
      setMessage({
        type: 'success',
        text: enable
          ? tr('accountSettings.security.mfaEnabled', 'Two-factor authentication enabled')
          : tr('accountSettings.security.mfaDisabled', 'Two-factor authentication disabled'),
      });
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.security.mfaUpdateFailed', 'Failed to update MFA') });
    } finally {
      setSecurityBusy(false);
    }
  };

  const handleEnableBiometric = async () => {
    try {
      setSecurityBusy(true);
      // 1) Get registration options from backend (challenge stored server-side)
      const opts = await postJson('/auth/biometric/register/options', {}, { requestLabel: 'POST /auth/biometric/register/options' });
      const challengeId = opts?.challengeId;
      const options = opts?.options;
      if (!challengeId || !options) throw new Error(tr('accountSettings.security.invalidBiometricOptions', 'Invalid biometric registration options'));

      // 2) Let the OS/browser pick the modality (Face/Touch/Hello) via WebAuthn
      const response = await startRegistration(options);

      // 3) Verify attestation on backend and persist public key
      await postJson(
        '/auth/biometric/register/verify',
        { challengeId, response },
        { requestLabel: 'POST /auth/biometric/register/verify' }
      );

      const fresh = await getJson('/auth/me', { requestLabel: 'GET /auth/me (after biometric enable)' });
      setMe(fresh);
      setMessage({ type: 'success', text: tr('accountSettings.security.biometricEnabled', 'Biometric login enabled for this account') });
      closeSecurity();
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.security.biometricEnableFailed', 'Failed to enable biometric login') });
    } finally {
      setSecurityBusy(false);
    }
  };

  const downloadTextFile = (filename, text, mime = 'text/plain') => {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      // fallback
      console.error('Download failed', e);
    }
  };

  const toCsv = (rows) => {
    const safe = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      const escaped = s.replace(/"/g, '""');
      return /[\n,"]/g.test(escaped) ? `"${escaped}"` : escaped;
    };
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const cols = Array.from(rows.reduce((set, r) => {
      Object.keys(r || {}).forEach((k) => set.add(k));
      return set;
    }, new Set()));
    const header = cols.map(safe).join(',');
    const lines = rows.map((r) => cols.map((c) => safe(r?.[c])).join(','));
    return [header, ...lines].join('\n');
  };

  const parseCityState = (value) => {
    const s = (value || '').toString().trim();
    if (!s) return { city: '', state: '' };
    // Common format: "City, ST" or "City, ST 12345"
    const parts = s.split(',');
    if (parts.length >= 2) {
      const city = (parts[0] || '').trim();
      const rest = (parts.slice(1).join(',') || '').trim();
      const state = (rest.split(/\s+/)[0] || '').trim();
      return { city, state };
    }
    return { city: s, state: '' };
  };

  const exportComplianceReport = async (format = 'json', opts = {}) => {
    try {
      if (!opts.suppressBusy) setReportBusy(true);
      const status = await getJson('/compliance/status', { requestLabel: 'GET /compliance/status (report)' });
      const tasks = await getJson('/compliance/tasks', { requestLabel: 'GET /compliance/tasks (report)' });

      const payload = {
        generated_at: new Date().toISOString(),
        compliance_status: status,
        compliance_tasks: tasks,
      };

      if (format === 'csv') {
        const base = tr('accountSettings.download.complianceReportFileBase', 'compliance_report');
        const taskList = Array.isArray(tasks) ? tasks : Array.isArray(tasks?.tasks) ? tasks.tasks : [];
        const rows = taskList.map((t) => ({
            category: t.category,
            title: t.title,
            description: t.description,
            due_date: t.due_date,
            status: t.status,
          }))
        downloadTextFile(`${base}_${Date.now()}.csv`, toCsv(rows), 'text/csv');
      } else {
        const base = tr('accountSettings.download.complianceReportFileBase', 'compliance_report');
        downloadTextFile(`${base}_${Date.now()}.json`, JSON.stringify(payload, null, 2), 'application/json');
      }
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.reports.complianceExportFailed', 'Failed to export compliance report') });
    } finally {
      if (!opts.suppressBusy) setReportBusy(false);
    }
  };

  const exportLoadReport = async (format = 'csv', opts = {}) => {
    try {
      if (!opts.suppressBusy) setReportBusy(true);
      const res = await getJson('/loads?page_size=200&exclude_drafts=false', { requestLabel: 'GET /loads (report)' });
      const loads = Array.isArray(res?.loads) ? res.loads : [];

      if (format === 'json') {
        const base = tr('accountSettings.download.loadReportFileBase', 'load_report');
        downloadTextFile(`${base}_${Date.now()}.json`, JSON.stringify({ generated_at: new Date().toISOString(), loads }, null, 2), 'application/json');
        return;
      }

      const signedInDriverName =
        (profileData?.fullName || profileData?.name || me?.full_name || me?.display_name || currentUser?.displayName || '').toString().trim();

      const rows = loads.map((l) => {
        const origin = l?.origin || l?.pickup_location || l?.pickup || '';
        const destination = l?.destination || l?.delivery_location || l?.delivery || '';
        const pu = parseCityState(origin);
        const del = parseCityState(destination);

        const assignedCarrierName =
          (l?.assigned_carrier_name || l?.carrier_name || l?.assigned_carrier_display_name || l?.assigned_carrier || '').toString().trim();

        return {
          load_id: l.load_id,
          status: l.status,
          pickup_city: pu.city,
          pickup_state: pu.state,
          delivery_city: del.city,
          delivery_state: del.state,
          assigned_driver: signedInDriverName || (l?.assigned_driver_name || l?.assigned_driver || ''),
          assigned_carrier: assignedCarrierName,
          created_by: l.created_by,
          created_at: l.created_at,
        };
      });
      {
        const base = tr('accountSettings.download.loadReportFileBase', 'load_report');
        downloadTextFile(`${base}_${Date.now()}.csv`, toCsv(rows), 'text/csv');
      }
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.reports.loadExportFailed', 'Failed to export load report') });
    } finally {
      if (!opts.suppressBusy) setReportBusy(false);
    }
  };

  const exportActivityLog = async (format = 'csv', opts = {}) => {
    try {
      if (!opts.suppressBusy) setReportBusy(true);
      const res = await getJson('/auth/profile/updates', { requestLabel: 'GET /auth/profile/updates (report)' });
      const items = Array.isArray(res?.items) ? res.items : [];
      if (format === 'json') {
        const base = tr('accountSettings.download.activityLogFileBase', 'activity_log');
        downloadTextFile(`${base}_${Date.now()}.json`, JSON.stringify({ generated_at: new Date().toISOString(), items }, null, 2), 'application/json');
        return;
      }
      const rows = items.map((it) => ({
        timestamp: it.timestamp,
        source: it.source,
        actor_role: it.actor_role,
        changed_keys: Object.keys(it.changes || {}).join('|'),
      }));
      {
        const base = tr('accountSettings.download.activityLogFileBase', 'activity_log');
        downloadTextFile(`${base}_${Date.now()}.csv`, toCsv(rows), 'text/csv');
      }
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.reports.activityExportFailed', 'Failed to export activity log') });
    } finally {
      if (!opts.suppressBusy) setReportBusy(false);
    }
  };

  const requestFullDataDownload = async () => {
    try {
      setReportBusy(true);
      await exportComplianceReport('json', { suppressBusy: true });
      await exportLoadReport('csv', { suppressBusy: true });
      await exportActivityLog('csv', { suppressBusy: true });
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.reports.downloadAllFailed', 'Failed to download all reports') });
    } finally {
      setReportBusy(false);
    }
  };

  const submitSupport = async () => {
    try {
      setSupportBusy(true);
      await postJson('/support/submit', supportForm, { requestLabel: 'POST /support/submit' });
      setMessage({ type: 'success', text: tr('accountSettings.support.submitted', 'Support request submitted') });
      setSupportOpen(false);
      setSupportForm({ name: '', email: '', subject: '', message: '' });
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || tr('accountSettings.support.submitFailed', 'Failed to submit support request') });
    } finally {
      setSupportBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="account-settings-container">
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '400px' }}>
          <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
          <span style={{ marginLeft: '10px' }}>{tr('accountSettings.profile.loading', 'Loading profile...')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="account-settings-container">
      <header className="account-settings-header">
        <h2>{tr('accountSettings.header.title', 'Account & Settings')}</h2>
        <p>{tr('accountSettings.header.subtitle', 'Manage your profile, preferences, security, and integrations')}</p>
      </header>

      {message.text && (
        <div className={`profile-message ${message.type}`} style={{
          padding: '12px 16px',
          marginBottom: '20px',
          borderRadius: '8px',
          backgroundColor: message.type === 'success' ? '#d1fae5' : '#fee2e2',
          color: message.type === 'success' ? '#065f46' : '#991b1b',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <i className={`fa-solid ${message.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}`}></i>
          {message.text}
        </div>
      )}

      {/* Profile & Preferences Section */}
      <div className="profile-preferences-section">
        {/* Profile Card */}
        <div className="profile-card">
          <div className="profile-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>{tr('accountSettings.profile.cardTitle', 'Profile')}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn small-cd"
                onClick={() => setProfileTab('profile')}
                disabled={saving || uploading || onboardingSaving}
                style={{ opacity: profileTab === 'profile' ? 1 : 0.75 }}
              >
                {tr('accountSettings.tabs.profile', 'Profile')}
              </button>
              <button
                type="button"
                className="btn small-cd"
                onClick={() => setProfileTab('onboarding')}
                disabled={saving || uploading || onboardingSaving}
                style={{ opacity: profileTab === 'onboarding' ? 1 : 0.75 }}
              >
                {tr('accountSettings.tabs.onboardingCenter', 'Onboarding Center')}
              </button>
            </div>
          </div>

          {profileTab === 'onboarding' ? (
            <>
              <div style={{ marginTop: 10, padding: 12, border: `1px solid ${asTheme.border}`, background: asTheme.surfaceAlt, borderRadius: 10 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>{tr('accountSettings.onboarding.quickFixesTitle', 'Quick fixes')}</div>
                <div style={{ fontSize: 13, color: asTheme.muted, marginBottom: 10 }}>
                  {tr('accountSettings.onboarding.quickFixesDesc', 'Update your basic profile info and resolve missing onboarding items below.')}
                </div>

                <div className="profile-field">
                  <label>{tr('accountSettings.onboarding.fullNameLabel', 'Full Name')}</label>
                  <input
                    type="text"
                    value={profileData.fullName}
                    onChange={(e) => handleInputChange('fullName', e.target.value)}
                    placeholder={tr('accountSettings.onboarding.fullNamePlaceholder', 'Full Name')}
                  />
                </div>
                <div className="profile-field">
                  <label>{tr('accountSettings.onboarding.phoneLabel', 'Phone')}</label>
                  <input
                    type="text"
                    value={profileData.phone}
                    onChange={(e) => handleInputChange('phone', e.target.value)}
                    placeholder={tr('accountSettings.onboarding.phonePlaceholder', '+1 (555) 123-4567')}
                  />
                </div>

                <button
                  type="button"
                  className="btn small-cd"
                  onClick={saveOnboardingQuickFixes}
                  disabled={onboardingSaving}
                  style={{ marginTop: 8 }}
                >
                  {onboardingSaving ? tr('accountSettings.onboarding.saving', 'Saving...') : tr('accountSettings.onboarding.saveChanges', 'Save Changes')}
                </button>
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 900 }}>{tr('accountSettings.onboarding.checklistTitle', 'Onboarding checklist')}</div>
                  <button
                    type="button"
                    className="btn small-cd"
                    onClick={fetchRequiredDocs}
                    disabled={requiredDocsLoading}
                  >
                    {requiredDocsLoading ? tr('accountSettings.onboarding.refreshing', 'Refreshing...') : tr('accountSettings.onboarding.refresh', 'Refresh')}
                  </button>
                </div>

                {requiredDocsError && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: `1px solid ${asTheme.border}`, color: asTheme.text, background: asTheme.surfaceAlt }}>
                    {requiredDocsError}
                  </div>
                )}

                {requiredDocsLoading && !requiredDocs && (
                  <div style={{ marginTop: 10, fontSize: 13, color: asTheme.muted }}>
                    {tr('accountSettings.onboarding.loading', 'Loading onboarding checklist...')}
                  </div>
                )}

                {!requiredDocsLoading && requiredDocs && (
                  <>
                    <div style={{ marginTop: 10, fontSize: 13, color: asTheme.muted }}>
                      {tr('accountSettings.onboarding.progressPrefix', 'Progress: ')}
                      {String(requiredDocs?.summary?.percent ?? 0)}%
                      {` (${String(requiredDocs?.summary?.completed_required ?? 0)}/${String(requiredDocs?.summary?.total_required ?? 0)})`}
                    </div>

                    <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                      {(() => {
                        const required = Array.isArray(requiredDocs?.required) ? requiredDocs.required : [];
                        const incomplete = required.filter((it) => {
                          const s = String(it?.status || '');
                          return s === 'Missing' || s === 'Expired' || s === 'Expiring Soon';
                        });
                        if (incomplete.length === 0) {
                          return (
                            <div style={{ padding: 12, borderRadius: 10, border: `1px solid ${asTheme.border}`, background: asTheme.surfaceAlt, color: asTheme.muted }}>
                              {tr('accountSettings.onboarding.allSet', 'All onboarding items look complete.')}
                            </div>
                          );
                        }

                        return incomplete.map((it) => {
                          const k = String(it?.key || '').toLowerCase();
                          const title = requiredItemTitle(k, it?.title || k);
                          const desc = requiredItemDescription(k, it?.description || '');
                          const status = trRequiredStatus(it?.status);
                          const kind = String(it?.kind || '').toLowerCase();
                          const blocked = Boolean(it?.blocked_by_consent);
                          const docType = it?.action?.document_type || it?.action?.documentType || it?.upload_document_type || k;

                          return (
                            <div key={`req-${k}`} style={{ padding: 12, borderRadius: 10, border: `1px solid ${asTheme.border}`, background: asTheme.surfaceAlt }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 10 }}>
                                <div>
                                  <div style={{ fontWeight: 900 }}>{title}</div>
                                  {desc ? <div style={{ fontSize: 13, color: asTheme.muted, marginTop: 2 }}>{desc}</div> : null}
                                </div>
                                <div style={{ fontSize: 12, color: asTheme.muted, whiteSpace: 'nowrap' }}>
                                  {tr('accountSettings.onboarding.statusLabel', 'Status:')} {status}
                                </div>
                              </div>

                              {blocked && (
                                <div style={{ marginTop: 8, fontSize: 13, color: asTheme.muted }}>
                                  {tr('accountSettings.onboarding.blockedByConsent', 'Blocked until consent is signed.')}
                                </div>
                              )}

                              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                                {k === 'consent' || kind === 'consent' ? (
                                  <button type="button" className="btn small-cd" onClick={openConsent}>
                                    {tr('accountSettings.onboarding.openConsent', 'Open Consent & E-Signature')}
                                  </button>
                                ) : kind === 'document' ? (
                                  <button
                                    type="button"
                                    className="btn small-cd"
                                    onClick={() => openDocUpload(docType)}
                                    disabled={blocked}
                                  >
                                    {tr('accountSettings.onboarding.uploadDocument', 'Upload Document')}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn small-cd"
                                    onClick={() => setProfileTab('profile')}
                                  >
                                    {tr('accountSettings.onboarding.openProfile', 'Open Profile')}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
          <div className="profile-card-header">
            <img 
              src={profileData.profilePicture || "https://randomuser.me/api/portraits/men/32.jpg"} 
              alt={tr('accountSettings.profile.photoAlt', 'Profile')} 
              className="profile-avatar"
              onError={(e) => {
                e.target.src = "https://randomuser.me/api/portraits/men/32.jpg";
              }}
            />
            <div>
              <div className="profile-name">{profileData.fullName || tr('accountSettings.common.driverFallback', 'Driver')}</div>
              <button 
                className="change-photo-btn" 
                onClick={handlePhotoClick}
                disabled={uploading}
              >
                {uploading ? tr('accountSettings.profile.uploading', 'Uploading...') : tr('accountSettings.profile.changePhoto', 'Change Photo')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                onChange={handlePhotoChange}
                style={{ display: 'none' }}
              />
            </div>
          </div>
          <div className="profile-field">
            <label>{tr('accountSettings.profile.fullNameLabel', 'Full Name')}</label>
            <input 
              type="text" 
              value={profileData.fullName} 
              onChange={(e) => handleInputChange('fullName', e.target.value)}
              placeholder={tr('accountSettings.profile.fullNamePlaceholder', 'Full Name')}
            />
          </div>
          <div className="profile-field">
            <label>{tr('accountSettings.profile.phoneLabel', 'Phone')}</label>
            <input 
              type="text" 
              value={profileData.phone} 
              onChange={(e) => handleInputChange('phone', e.target.value)}
              placeholder={tr('accountSettings.profile.phonePlaceholder', '+1 (555) 123-4567')}
            />
          </div>
          <div className="profile-field">
            <label>{tr('accountSettings.profile.emailLabel', 'Email')}</label>
            <input 
              type="email" 
              value={profileData.email} 
              readOnly 
              style={{ backgroundColor: isDarkMode ? asTheme.surfaceAlt : '#f3f4f6', color: asTheme.muted, cursor: 'not-allowed' }}
            />
          </div>
          <div className="profile-field">
            <label>{tr('accountSettings.profile.addressLabel', 'Address')}</label>
            <textarea 
              value={profileData.address} 
              rows={2}
              onChange={(e) => handleInputChange('address', e.target.value)}
              placeholder={tr('accountSettings.profile.addressPlaceholder', '123 Main St, Dallas, TX 75201')}
            />
          </div>
          <div className="emergency-contact-label">{tr('accountSettings.profile.emergencyContactLabel', 'Emergency Contact')}</div>
          <div className="profile-field">
            <input 
              type="text" 
              placeholder={tr('accountSettings.profile.emergencyContactNamePlaceholder', 'Contact Name')}
              value={profileData.emergency_contact_name}
              onChange={(e) => handleInputChange('emergency_contact_name', e.target.value)}
            />
          </div>
          <div className="profile-field">
            <input 
              type="text" 
              placeholder={tr('accountSettings.profile.emergencyContactRelationshipPlaceholder', 'Relationship')}
              value={profileData.emergency_contact_relationship}
              onChange={(e) => handleInputChange('emergency_contact_relationship', e.target.value)}
            />
          </div>
          <div className="profile-field">
            <input 
              type="text" 
              placeholder={tr('accountSettings.profile.emergencyContactPhonePlaceholder', 'Phone Number')}
              value={profileData.emergency_contact_phone}
              onChange={(e) => handleInputChange('emergency_contact_phone', e.target.value)}
            />
          </div>
          <button 
            className="btn small-cd" 
            onClick={handleSaveProfile}
            disabled={saving}
            style={{ marginTop: '16px' }}
          >
            {saving ? tr('accountSettings.profile.saving', 'Saving...') : tr('accountSettings.profile.saveChanges', 'Save Changes')}
          </button>
          <button className="btn small-cd" style={{ marginTop: '8px' }} onClick={openPreviewMarketplaceProfile}>
            {tr('accountSettings.marketplacePreview.openButton', 'Preview Marketplace Profile')}
          </button>
            </>
          )}
        </div>

        {/* Preferences Card */}
        <div className="preferences-card">
          <h2 className="preferences-card-title">
            {tr('accountSettings.preferences.cardTitle', 'Preferences')}
          </h2>
          <div className="preferences-field">
            <label>{tr('settings.language', 'Language')}</label>
            <select
              value={userSettings?.language || 'English'}
              disabled={prefsSaving}
              onChange={(e) => updateSettings({ language: e.target.value }, 'PATCH /auth/settings (language)')}
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="preferences-section-label">{tr('accountSettings.preferences.notificationsSection', 'Notifications')}</div>
          <div className="preferences-checkbox">
            <label>{tr('accountSettings.preferences.complianceAlerts', 'Compliance Alerts')}</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(userSettings?.notification_preferences?.compliance_alerts)}
                disabled={prefsSaving}
                onChange={(e) => updateSettings({
                  notification_preferences: {
                    ...(userSettings?.notification_preferences || {}),
                    compliance_alerts: e.target.checked,
                  }
                }, 'PATCH /auth/settings (notification_preferences)')}
              />
              <span className="slider"></span>
            </label>
          </div>
          <div className="preferences-checkbox">
            <label>{tr('accountSettings.preferences.messages', 'Messages')}</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(userSettings?.notification_preferences?.messages)}
                disabled={prefsSaving}
                onChange={(e) => updateSettings({
                  notification_preferences: {
                    ...(userSettings?.notification_preferences || {}),
                    messages: e.target.checked,
                  }
                }, 'PATCH /auth/settings (notification_preferences)')}
              />
              <span className="slider"></span>
            </label>
          </div>
          <div className="preferences-checkbox">
            <label>{tr('accountSettings.preferences.aiTips', 'AI Tips')}</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(userSettings?.notification_preferences?.ai_tips)}
                disabled={prefsSaving}
                onChange={(e) => updateSettings({
                  notification_preferences: {
                    ...(userSettings?.notification_preferences || {}),
                    ai_tips: e.target.checked,
                  }
                }, 'PATCH /auth/settings (notification_preferences)')}
              />
              <span className="slider"></span>
            </label>
          </div>
          <div className="preferences-link">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (typeof onNavigate === 'function') {
                  onNavigate('alerts');
                  return;
                }
                setMessage({ type: 'error', text: tr('accountSettings.preferences.unableToOpenNotifications', 'Unable to open notifications from this screen.') });
              }}
            >
              {tr('settings.notificationHistory', 'View Notification History')}
            </a>
          </div>
          <div className="preferences-field">
            <label>{tr('settings.calendarSync', 'Calendar Sync')}</label>
            <select
              value={userSettings?.calendar_sync || 'Google Calendar'}
              disabled={prefsSaving}
              onChange={(e) => updateSettings({ calendar_sync: e.target.value }, 'PATCH /auth/settings (calendar_sync)')}
            >
              <option value="Google Calendar">{tr('accountSettings.calendar.providerGoogle', 'Google Calendar')}</option>
              <option value="Outlook">{tr('accountSettings.calendar.providerOutlook', 'Outlook')}</option>
            </select>
          </div>

          <div className="preferences-checkbox" style={{ marginTop: 8 }}>
            <label>{tr('accountSettings.calendar.reminders', 'Reminders')}</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(userSettings?.calendar_reminders_enabled !== false)}
                disabled={prefsSaving}
                onChange={(e) => updateSettings({ calendar_reminders_enabled: e.target.checked }, 'PATCH /auth/settings (calendar_reminders_enabled)')}
              />
              <span className="slider"></span>
            </label>
          </div>

          <div className="preferences-section-label" style={{ marginTop: 12 }}>{tr('accountSettings.calendar.connectSection', 'Connect Calendar')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ fontSize: 13, color: asTheme.muted }}>
              {tr('accountSettings.calendar.statusPrefix', 'Status: ')}
              {calendarStatus?.[selectedCalendarProvider]?.connected
                ? tr('accountSettings.calendar.connected', 'Connected')
                : tr('accountSettings.calendar.notConnected', 'Not connected')}
            </div>
            {!calendarStatus?.[selectedCalendarProvider]?.connected ? (
              <button
                className="btn small-cd"
                type="button"
                disabled={Boolean(calendarBusy)}
                onClick={startCalendarConnect}
              >
                {selectedCalendarProvider === 'outlook'
                  ? tr('accountSettings.calendar.connectOutlook', 'Connect Outlook')
                  : tr('accountSettings.calendar.connectGoogle', 'Connect Google')}
              </button>
            ) : (
              <>
                <button
                  className="btn small-cd"
                  type="button"
                  disabled={Boolean(calendarBusy)}
                  onClick={() => syncUpcomingEvents({ silent: false })}
                >
                  {tr('accountSettings.calendar.syncUpcomingEvents', 'Sync Upcoming Events')}
                </button>
                <button
                  className="btn small-cd"
                  type="button"
                  disabled={Boolean(calendarBusy)}
                  onClick={disconnectCalendar}
                >
                  {tr('accountSettings.calendar.disconnect', 'Disconnect')}
                </button>
              </>
            )}
          </div>

        </div>
      </div>
      
      {/* Security & Accessibility Section */}
      <div className="security-accessibility-section">
        <div className="security-card">
          <h3 className="card-title">{tr('accountSettings.security.cardTitle', 'Security')}</h3>
          <ul className="action-list">
            <li className="action-item" onClick={() => openSecurity('password')} role="button" tabIndex={0}>
              {tr('accountSettings.security.changePassword', 'Change Password')} <span className="chev">›</span>
            </li>
            <li className="action-item" onClick={() => openSecurity('mfa')} role="button" tabIndex={0}>
              <div className="action-left">
                <div className="action-title">{tr('accountSettings.security.twoFactor', 'Two-Factor Authentication')}</div>
                <div className={`int-status-badge ${me?.mfa_enabled ? 'active' : 'disconnected'}`}
                  style={{ minWidth: 90, textAlign: 'center' }}
                >
                  {me?.mfa_enabled
                    ? tr('accountSettings.common.enabled', 'Enabled')
                    : tr('accountSettings.common.disabled', 'Disabled')}
                </div>
              </div>
              <span className="chev">›</span>
            </li>
            <li className="action-item" onClick={() => openSecurity('biometric')} role="button" tabIndex={0}>
              {tr('accountSettings.security.biometricLogin', 'Biometric Login')} <span className="chev">›</span>
            </li>
            <li className="action-item" onClick={() => openSecurity('sessions')} role="button" tabIndex={0}>
              {tr('accountSettings.security.sessionDevice', 'Session & Device Management')} <span className="chev">›</span>
            </li>
          </ul>
        </div>

        <div className="accessibility-card">
          <h3 className="card-title">{tr('accountSettings.accessibility.cardTitle', 'Accessibility')}</h3>
          <div className="access-field">
            <label>{tr('accountSettings.accessibility.fontSize', 'Font Size')}</label>
            <select
              value={userSettings?.font_size || 'Medium'}
              disabled={prefsSaving}
              onChange={(e) => updateSettings({ font_size: e.target.value }, 'PATCH /auth/settings (font_size)')}
            >
              <option value="Small">{tr('accountSettings.accessibility.fontSmall', 'Small')}</option>
              <option value="Medium">{tr('accountSettings.accessibility.fontMedium', 'Medium')}</option>
              <option value="Large">{tr('accountSettings.accessibility.fontLarge', 'Large')}</option>
            </select>
          </div>
          <div className="preferences-section-label">{tr('accountSettings.accessibility.assistiveFeatures', 'Assistive Features')}</div>
          <div className="preferences-checkbox">
            <label>{tr('accountSettings.accessibility.highContrast', 'High Contrast Mode')}</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(userSettings?.high_contrast_mode)}
                disabled={prefsSaving}
                onChange={(e) => updateSettings({ high_contrast_mode: e.target.checked }, 'PATCH /auth/settings (high_contrast_mode)')}
              />
              <span className="slider"></span>
            </label>
          </div>
          <div className="preferences-checkbox">
            <label>{tr('accountSettings.accessibility.screenReader', 'Screen Reader Compatible')}</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(userSettings?.screen_reader_compatible !== false)}
                disabled={prefsSaving}
                onChange={(e) => updateSettings({ screen_reader_compatible: e.target.checked }, 'PATCH /auth/settings (screen_reader_compatible)')}
              />
              <span className="slider"></span>
            </label>
          </div>
          <div className="preferences-checkbox muted">
            <label>{tr('accountSettings.accessibility.voiceCommands', 'Voice Commands')}</label>
            <div className="coming-soon">{tr('accountSettings.common.comingSoon', 'Coming Soon')}</div>
          </div>
        </div>
      </div>

      {/* Simple security modal */}
      {securityView && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
            padding: 16,
          }}
          onClick={closeSecurity}
        >
          <div
            style={{
              width: 'min(560px, 100%)',
              background: asTheme.surface,
              borderRadius: 12,
              padding: 16,
              boxShadow: isDarkMode ? 'none' : '0 18px 40px rgba(16,24,40,0.25)',
              border: `1px solid ${asTheme.border}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: asTheme.text }}>
                {securityView === 'password' && tr('accountSettings.security.changePassword', 'Change Password')}
                {securityView === 'mfa' && tr('accountSettings.security.twoFactor', 'Two-Factor Authentication')}
                {securityView === 'biometric' && tr('accountSettings.security.biometricPasskeys', 'Biometric Login (Passkeys)')}
                {securityView === 'sessions' && tr('accountSettings.security.sessionDevice', 'Session & Device Management')}
              </div>
              <button className="btn small ghost-cd" onClick={closeSecurity} disabled={securityBusy}>{tr('accountSettings.common.close', 'Close')}</button>
            </div>

            {securityView === 'password' && (
              <div style={{ marginTop: 12 }}>
                <div className="profile-field">
                  <label>{tr('accountSettings.security.currentPassword', 'Current Password')}</label>
                  <input
                    type="password"
                    value={pwForm.current_password}
                    onChange={(e) => setPwForm((p) => ({ ...p, current_password: e.target.value }))}
                    placeholder={tr('accountSettings.security.currentPasswordPlaceholder', 'Enter current password')}
                    autoComplete="current-password"
                  />
                </div>
                <div className="profile-field">
                  <label>{tr('accountSettings.security.newPassword', 'New Password')}</label>
                  <input
                    type="password"
                    value={pwForm.new_password}
                    onChange={(e) => setPwForm((p) => ({ ...p, new_password: e.target.value }))}
                    placeholder={tr('accountSettings.security.newPasswordPlaceholder', 'At least 8 characters')}
                    autoComplete="new-password"
                  />
                </div>
                <button className="btn small-cd" onClick={handleChangePassword} disabled={securityBusy}>
                  {securityBusy
                    ? tr('accountSettings.security.updating', 'Updating...')
                    : tr('accountSettings.security.updatePassword', 'Update Password')}
                </button>
              </div>
            )}

            {securityView === 'mfa' && (
              <div style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 10px 0', color: asTheme.body }}>
                  {tr('accountSettings.security.mfaDescription', 'Two-factor authentication for drivers uses SMS OTP during login.')}
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    className="btn small-cd"
                    onClick={() => handleToggleMfa(true)}
                    disabled={securityBusy || me?.mfa_enabled}
                  >
                    {tr('accountSettings.common.enable', 'Enable')}
                  </button>
                  <button
                    className="btn small ghost-cd"
                    onClick={() => handleToggleMfa(false)}
                    disabled={securityBusy || !me?.mfa_enabled}
                  >
                    {tr('accountSettings.common.disable', 'Disable')}
                  </button>
                </div>
              </div>
            )}

            {securityView === 'biometric' && (
              <div style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 10px 0', color: asTheme.body }}>
                  {tr('accountSettings.security.biometricDescriptionLine1', 'This uses WebAuthn passkeys. Your device decides Face/Touch/Hello automatically.')}
                  {' '}
                  {tr('accountSettings.security.biometricDescriptionLine2', 'No biometric data is stored.')}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: asTheme.text }}>{tr('accountSettings.common.status', 'Status')}</div>
                    <div style={{ color: asTheme.muted }}>
                      {me?.biometricEnabled
                        ? tr('accountSettings.common.enabled', 'Enabled')
                        : tr('accountSettings.security.notEnabled', 'Not enabled')}
                    </div>
                  </div>
                  <button
                    className="btn small-cd"
                    onClick={handleEnableBiometric}
                    disabled={securityBusy || me?.biometricEnabled}
                  >
                    {securityBusy
                      ? tr('accountSettings.security.enabling', 'Enabling...')
                      : tr('accountSettings.security.enableOnThisDevice', 'Enable on this device')}
                  </button>
                </div>
              </div>
            )}

            {securityView === 'sessions' && (
              <div style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 10px 0', color: asTheme.body }}>
                  {tr('accountSettings.security.recentChanges', 'Recent profile/security changes (from backend audit trail).')}
                </p>
                <div style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${asTheme.border}`, borderRadius: 10, background: asTheme.surfaceAlt }}>
                  {(profileUpdates || []).length === 0 ? (
                    <div style={{ padding: 12, color: asTheme.muted }}>{tr('accountSettings.security.noRecentActivity', 'No recent activity found.')}</div>
                  ) : (
                    (profileUpdates || []).map((it) => (
                      <div key={it.id} style={{ padding: 12, borderBottom: `1px solid ${asTheme.border}` }}>
                        <div style={{ fontWeight: 600, color: asTheme.text }}>{it.source || tr('accountSettings.security.profileUpdateSourceFallback', 'profile.update')}</div>
                        <div style={{ fontSize: 12, color: asTheme.muted }}>{String(it.timestamp || '')}</div>
                        <div style={{ fontSize: 12, color: asTheme.body }}>{Object.keys(it.changes || {}).join(', ') || '—'}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

       {/* Reports & Integrations Section */}
      <div className="reports-integrations-section">
        <div className="reports-card">
          <h3 className="card-title">{tr('accountSettings.reports.cardTitle', 'Reports')}</h3>
          <ul className="action-list">
            <li className="action-item" onClick={() => exportComplianceReport('json')} role="button" tabIndex={0}>
              {tr('accountSettings.reports.complianceReport', 'Compliance Report')} <span className="download"><i className='fa-solid fa-download'></i></span>
            </li>
            <li className="action-item" onClick={() => exportLoadReport('csv')} role="button" tabIndex={0}>
              {tr('accountSettings.reports.loadReport', 'Load Report')} <span className="download"><i className='fa-solid fa-download'></i></span>
            </li>
            <li className="action-item" onClick={() => exportActivityLog('csv')} role="button" tabIndex={0}>
              {tr('accountSettings.reports.activityLog', 'Activity Log')} <span className="download"><i className='fa-solid fa-download'></i></span>
            </li>
          </ul>

          <div className="divider" />
          <div className="export-label">{tr('accountSettings.reports.exportOptions', 'Export Options')}</div>
          <div className="export-options">
            <button
              className="btn small-cd"
              style={{width: '100%'}}
              disabled={reportBusy}
              onClick={() => exportComplianceReport('json')}
            >
              {reportBusy ? tr('accountSettings.common.working', 'Working...') : tr('accountSettings.common.json', 'JSON')}
            </button>
            <button
              className="btn small-cd"
              style={{width: '100%'}}
              disabled={reportBusy}
              onClick={() => exportComplianceReport('csv')}
            >
              {reportBusy ? tr('accountSettings.common.working', 'Working...') : tr('accountSettings.common.csv', 'CSV')}
            </button>
          </div>
          <button
            className="btn small ghost-cd"
            disabled={reportBusy}
            onClick={requestFullDataDownload}
          >
            {tr('accountSettings.reports.requestFullDownload', 'Request Full Data Download')}
          </button>
        </div>

        <div className="integrations-card fp-coming-soon-card">
          <h3 className="card-title">{tr('accountSettings.integrations.cardTitle', 'Integrations')}</h3>
          <div className="fp-coming-soon-wrap">
            <div className="fp-coming-soon-overlay">{tr('accountSettings.common.comingSoon', 'Coming Soon')}</div>
            <div className="fp-coming-soon-content">
              <ul className="integration-list">
                <li className="integration-item">
                  <div>
                    <div className="integration-title">{tr('accountSettings.integrations.eldDevice', 'ELD Device')}</div>
                    <div className="integration-desc">{tr('accountSettings.integrations.eldDesc', 'Garmin eLog 2.0 - Device ID: #GL2024567')}</div>
                  </div>
                  <div className="int-status-badge active">{tr('accountSettings.calendar.connected', 'Connected')}</div>
                </li>
                <li className="integration-item">
                  <div>
                    <div className="integration-title">{tr('accountSettings.integrations.fuelServices', 'Fuel Services')}</div>
                    <div className="integration-desc">{tr('accountSettings.integrations.fuelDesc', 'TVC Pro Driver - Fleet Card Integration')}</div>
                  </div>
                  <div className="int-status-badge active">{tr('accountSettings.calendar.connected', 'Connected')}</div>
                </li>
                <li className="integration-item">
                  <div>
                    <div className="integration-title">{tr('accountSettings.integrations.trainingProvider', 'Training Provider')}</div>
                    <div className="integration-desc">{tr('accountSettings.integrations.trainingDesc', 'Connect training services for compliance tracking')}</div>
                  </div>
                  <div className="int-status-badge disconnected">{tr('accountSettings.calendar.notConnected', 'Not connected')}</div>
                </li>
              </ul>
              <button className="btn small-cd" style={{marginTop: '20px'}}>{tr('accountSettings.integrations.managePermissions', 'Manage Permissions')}</button>
            </div>
          </div>
        </div>
      </div>
      {/* Support & Help Section */}
      <div className="support-help-section">
        <div className="support-card">
          <h3 className="card-title">{tr('accountSettings.support.cardTitle', 'Support & Help')}</h3>
          <ul className="action-list">
            <li
              className="action-item"
              onClick={() => window.open('/help-center', '_blank')}
              role="button"
              tabIndex={0}
            >
              {tr('accountSettings.support.helpCenter', 'Help Center & FAQ')} <span className="external">↗</span>
            </li>
            <li
              className="action-item"
              onClick={() => {
                setSupportForm({
                  name: profileData.fullName || '',
                  email: profileData.email || currentUser?.email || '',
                  subject: '',
                  message: '',
                });
                setSupportOpen(true);
              }}
              role="button"
              tabIndex={0}
            >
              {tr('accountSettings.support.contactSupport', 'Contact Support')} <span className="chev">›</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Marketplace profile preview modal */}
      {previewOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2400,
            padding: 16,
          }}
          onClick={() => setPreviewOpen(false)}
        >
          <div
            style={{
              width: 'min(860px, 100%)',
              background: asTheme.surface,
              borderRadius: 12,
              padding: 16,
              boxShadow: isDarkMode ? 'none' : '0 18px 40px rgba(16,24,40,0.25)',
              border: `1px solid ${asTheme.border}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: asTheme.text }}>
                {tr('accountSettings.marketplacePreview.title', 'Marketplace Profile Preview')}
              </div>
              <button className="btn small ghost-cd" onClick={() => setPreviewOpen(false)} disabled={previewBusy}>{tr('accountSettings.common.close', 'Close')}</button>
            </div>

            <div style={{ marginTop: 12 }}>
              {previewBusy && (
                <div style={{ padding: 16, textAlign: 'center', color: asTheme.body }}>
                  <i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 10 }} /> {tr('accountSettings.marketplacePreview.loading', 'Loading preview...')}
                </div>
              )}

              {!previewBusy && previewError && (
                <div style={{ padding: 16, color: asTheme.body }}>{previewError}</div>
              )}

              {!previewBusy && !previewError && previewDriverCard && (
                <div className="marketplace-driver-card" style={{ margin: 0 }}>
                  <div className="marketplace-driver-header">
                    <div className="marketplace-driver-left">
                      <div className="marketplace-driver-avatar">
                        <img src={previewDriverCard.photo} alt={previewDriverCard.name} />
                      </div>
                      <div className="marketplace-driver-info">
                        <div className="marketplace-driver-name-row">
                          <h3 className="marketplace-driver-name">{previewDriverCard.name}</h3>
                          <div className="marketplace-driver-rating">
                            <i className="fa-solid fa-star" />
                            <span>{previewDriverCard.rating}</span>
                            <span className="marketplace-trips-count">• {previewDriverCard.trips} {tr('accountSettings.marketplacePreview.trips', 'trips')}</span>
                          </div>
                        </div>

                        <div className="marketplace-driver-details">
                          <div className="marketplace-detail-item">
                            <span className="marketplace-detail-label">{tr('accountSettings.marketplacePreview.cdlInfo', 'CDL INFO')}</span>
                            <span className="marketplace-detail-value">{tr('accountSettings.marketplacePreview.classPrefix', 'Class ')}{previewDriverCard.class}</span>
                            <span className="marketplace-detail-sub">{tr('accountSettings.marketplacePreview.expPrefix', 'Exp: ')}03/2025</span>
                          </div>

                          <div className="marketplace-detail-item">
                            <span className="marketplace-detail-label">{tr('accountSettings.marketplacePreview.location', 'LOCATION')}</span>
                            <span className="marketplace-detail-value">{previewDriverCard.location}</span>
                            <span className="marketplace-detail-sub">{previewDriverCard.lastActivity}</span>
                          </div>

                          <div className="marketplace-detail-item">
                            <span className="marketplace-detail-label">{tr('accountSettings.marketplacePreview.status', 'STATUS')}</span>
                            <span className={`marketplace-detail-value marketplace-status-${previewDriverCard.available ? 'available' : 'unavailable'}`}>
                              <i className="fa-solid fa-circle" />
                              {previewDriverCard.available
                                ? tr('accountSettings.marketplacePreview.available', 'Available')
                                : tr('accountSettings.marketplacePreview.notAvailable', 'Not Available')}
                            </span>
                          </div>

                          <div className="marketplace-detail-item">
                            <span className="marketplace-detail-label">{tr('accountSettings.marketplacePreview.aiSafetyScore', 'AI SAFETY SCORE')}</span>
                            <span className="marketplace-detail-value marketplace-safety-score">
                              {previewDriverCard.safetyScore}/100
                            </span>
                          </div>
                        </div>

                        <div className="marketplace-driver-tags">
                          <div className="marketplace-endorsements">
                            <span className="marketplace-tags-label">{tr('accountSettings.marketplacePreview.endorsementsLabel', 'Endorsements:')}</span>
                            {(previewDriverCard.endorsements || []).map((endorsementCode, index) => (
                              <span key={index} className="marketplace-endorsement-tag">{endorsementLabel(endorsementCode)}</span>
                            ))}
                          </div>

                          <div className="marketplace-equipment-status">
                            {(previewDriverCard.equipmentTypes || []).map((equipment, index) => (
                              <span
                                key={index}
                                className={`marketplace-equipment-tag ${equipment?.variant || 'invalid'}`}
                              >
                                <i className={`fa-solid ${equipment?.icon || 'fa-times-circle'}`} />
                                {equipmentLabel(equipment?.code)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="marketplace-driver-actions">
                      <button className={`marketplace-btn-hire ${previewDriverCard.available ? 'available' : 'unavailable'}`} disabled>
                        <i className="fa-solid fa-plus" /> {tr('accountSettings.marketplacePreview.hireDriver', 'Hire Driver')}
                      </button>
                      <div className="marketplace-driver-menu">
                        <button className="marketplace-menu-btn" title={tr('accountSettings.marketplacePreview.viewDetails', 'View Details')} disabled>
                          <i className="fa-solid fa-file-text" />
                        </button>
                        <button className="marketplace-menu-btn" title={tr('accountSettings.marketplacePreview.message', 'Message')} disabled>
                          <i className="fa-solid fa-message" />
                        </button>
                        <button className="marketplace-menu-btn" title={tr('accountSettings.marketplacePreview.favorite', 'Favorite')} disabled>
                          <i className="fa-regular fa-heart" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Support modal */}
      {supportOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
            padding: 16,
          }}
          onClick={() => setSupportOpen(false)}
        >
          <div
            style={{
              width: 'min(640px, 100%)',
              background: asTheme.surface,
              borderRadius: 12,
              padding: 16,
              boxShadow: isDarkMode ? 'none' : '0 18px 40px rgba(16,24,40,0.25)',
              border: `1px solid ${asTheme.border}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: asTheme.text }}>{tr('accountSettings.support.contactSupport', 'Contact Support')}</div>
              <button className="btn small ghost-cd" onClick={() => setSupportOpen(false)} disabled={supportBusy}>{tr('accountSettings.common.close', 'Close')}</button>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="profile-field">
                <label>{tr('accountSettings.support.name', 'Name')}</label>
                <input value={supportForm.name} onChange={(e) => setSupportForm((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div className="profile-field">
                <label>{tr('accountSettings.support.email', 'Email')}</label>
                <input value={supportForm.email} onChange={(e) => setSupportForm((p) => ({ ...p, email: e.target.value }))} />
              </div>
              <div className="profile-field">
                <label>{tr('accountSettings.support.subject', 'Subject')}</label>
                <input value={supportForm.subject} onChange={(e) => setSupportForm((p) => ({ ...p, subject: e.target.value }))} placeholder={tr('accountSettings.support.subjectPlaceholder', 'What do you need help with?')} />
              </div>
              <div className="profile-field">
                <label>{tr('accountSettings.support.message', 'Message')}</label>
                <textarea rows={4} value={supportForm.message} onChange={(e) => setSupportForm((p) => ({ ...p, message: e.target.value }))} placeholder={tr('accountSettings.support.messagePlaceholder', 'Describe the issue...')} />
              </div>
              <button className="btn small-cd" onClick={submitSupport} disabled={supportBusy}>
                {supportBusy
                  ? tr('accountSettings.support.submitting', 'Submitting...')
                  : tr('accountSettings.support.submit', 'Submit Request')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
