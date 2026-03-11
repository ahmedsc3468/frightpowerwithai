import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getJson, patchJson } from '../api/http';
import { useAuth } from './AuthContext';
import { isRtlLanguage, normalizeLanguage } from '../i18n/translate';

const UserSettingsContext = createContext(null);

const DEFAULT_SETTINGS = {
  language: 'English',
  time_zone: '',
  date_format: 'mdy',
  start_dashboard_view: 'dashboard',
  auto_save_edits: true,
  email_digest_enabled: true,

  notification_preferences: {
    compliance_alerts: true,
    messages: true,
    ai_tips: false,
  },
  calendar_sync: 'Google Calendar',
  calendar_reminders_enabled: true,

  font_size: 'Medium',
  high_contrast_mode: false,
  screen_reader_compatible: true,

  // Extended preferences (carrier/driver dashboards)
  default_currency: 'USD',
  notification_channels: {
    loads: { in_app: true, email: true, sms: false },
    compliance: { in_app: true, email: true, sms: true },
    finance: { in_app: true, email: true, sms: false },
  },
  quiet_hours_start: '10:00 PM',
  quiet_hours_end: '7:00 AM',

  invoice_prefix: 'FPA-',
  invoice_numbering_format: 'Sequential',
  payment_terms: 'Net 30',
  auto_send_invoices_on_complete: false,

  theme_preference: 'Light',
  default_view: 'My Loads Default View',
  my_loads_default_view: 'Active',

  auto_categorize_documents: true,
  auto_archive_completed_documents: false,
};

function coerceBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === 'off' || v === '') return false;
  }
  return Boolean(defaultValue);
}

function normalizeSettings(raw) {
  const s = raw || {};
  const notif = (s?.notification_preferences && typeof s.notification_preferences === 'object')
    ? s.notification_preferences
    : {};

  const notification_preferences = {
    compliance_alerts: coerceBoolean((notif?.compliance_alerts ?? notif?.complianceAlerts), true),
    messages: coerceBoolean(notif?.messages, true),
    ai_tips: coerceBoolean((notif?.ai_tips ?? notif?.aiTips), false),
  };

  const normalizeCalendarSync = (value) => {
    const v = String(value || '').trim().toLowerCase();
    if (v.includes('outlook')) return 'Outlook';
    if (v.includes('google')) return 'Google Calendar';
    return 'Google Calendar';
  };

  return {
    language: normalizeLanguage(s?.language),
    time_zone: s?.time_zone || '',
    date_format: (s?.date_format === 'dmy' ? 'dmy' : s?.date_format === 'ymd' ? 'ymd' : 'mdy'),
    start_dashboard_view: s?.start_dashboard_view || 'dashboard',
    auto_save_edits: coerceBoolean(s?.auto_save_edits, true),
    email_digest_enabled: coerceBoolean(s?.email_digest_enabled, true),

    notification_preferences,
    calendar_sync: normalizeCalendarSync(s?.calendar_sync),
    calendar_reminders_enabled: coerceBoolean(s?.calendar_reminders_enabled, true),

    font_size: (s?.font_size === 'Small' || s?.font_size === 'Large') ? s.font_size : 'Medium',
    high_contrast_mode: coerceBoolean(s?.high_contrast_mode, false),
    screen_reader_compatible: coerceBoolean(s?.screen_reader_compatible, true),

    default_currency: String(s?.default_currency || 'USD').trim().toUpperCase() || 'USD',
    notification_channels: (() => {
      const rawNc = (s?.notification_channels && typeof s.notification_channels === 'object') ? s.notification_channels : {};
      const normCat = (cat, defaults) => {
        const v = rawNc?.[cat];
        if (!v || typeof v !== 'object') return defaults;
        return {
          in_app: coerceBoolean(v?.in_app, defaults.in_app),
          email: coerceBoolean(v?.email, defaults.email),
          sms: coerceBoolean(v?.sms, defaults.sms),
        };
      };
      return {
        loads: normCat('loads', { in_app: true, email: true, sms: false }),
        compliance: normCat('compliance', { in_app: true, email: true, sms: true }),
        finance: normCat('finance', { in_app: true, email: true, sms: false }),
      };
    })(),
    quiet_hours_start: String(s?.quiet_hours_start || '10:00 PM'),
    quiet_hours_end: String(s?.quiet_hours_end || '7:00 AM'),

    invoice_prefix: String(s?.invoice_prefix || 'FPA-'),
    invoice_numbering_format: String(s?.invoice_numbering_format || 'Sequential'),
    payment_terms: String(s?.payment_terms || 'Net 30'),
    auto_send_invoices_on_complete: coerceBoolean(s?.auto_send_invoices_on_complete, false),

    theme_preference: String(s?.theme_preference || 'Light'),
    default_view: String(s?.default_view || 'My Loads Default View'),
    my_loads_default_view: String(s?.my_loads_default_view || 'Active'),

    auto_categorize_documents: coerceBoolean(s?.auto_categorize_documents, true),
    auto_archive_completed_documents: coerceBoolean(s?.auto_archive_completed_documents, false),
  };
}

function storageKey(uid) {
  return uid ? `fp_user_settings_v1:${uid}` : 'fp_user_settings_v1:anon';
}

export function UserSettingsProvider({ children }) {
  const { currentUser } = useAuth();
  const uid = currentUser?.uid || null;

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const isMountedRef = useRef(true);

  // Apply accessibility settings globally.
  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;

    root.classList.toggle('fp-high-contrast', Boolean(settings?.high_contrast_mode));

    const language = normalizeLanguage(settings?.language);
    root.setAttribute('lang', language === 'Arabic' ? 'ar' : language === 'Spanish' ? 'es' : 'en');
    root.setAttribute('dir', isRtlLanguage(language) ? 'rtl' : 'ltr');

    root.classList.remove('fp-font-small', 'fp-font-medium', 'fp-font-large');
    const size = settings?.font_size;
    if (size === 'Small') root.classList.add('fp-font-small');
    else if (size === 'Large') root.classList.add('fp-font-large');
    else root.classList.add('fp-font-medium');
  }, [settings?.high_contrast_mode, settings?.font_size, settings?.language]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Bootstrap from localStorage quickly, then refresh from API.
  useEffect(() => {
    let cancelled = false;
    const key = storageKey(uid);

    const readCached = () => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return normalizeSettings(JSON.parse(raw));
      } catch {
        return null;
      }
    };

    const cached = readCached();
    if (cached) setSettings(cached);

    (async () => {
      if (!uid) {
        if (!cancelled) {
          setSettings(DEFAULT_SETTINGS);
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      try {
        const remote = await getJson('/auth/settings', { requestLabel: 'GET /auth/settings' });
        const normalized = normalizeSettings(remote);
        if (cancelled) return;
        setSettings(normalized);
        try { localStorage.setItem(key, JSON.stringify(normalized)); } catch { /* ignore localStorage errors */ }
      } catch (_e) {
        // Best-effort: keep cached/default.
        if (!cancelled) {
          // still mark loaded so UI can proceed
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [uid]);

  const refreshSettings = useCallback(async () => {
    if (!uid) {
      setSettings(DEFAULT_SETTINGS);
      setLoading(false);
      return DEFAULT_SETTINGS;
    }

    setLoading(true);
    try {
      const remote = await getJson('/auth/settings', { requestLabel: 'GET /auth/settings' });
      const normalized = normalizeSettings(remote);
      setSettings(normalized);
      try { localStorage.setItem(storageKey(uid), JSON.stringify(normalized)); } catch { /* ignore localStorage errors */ }
      return normalized;
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [uid]);

  const patchSettings = useCallback(async (partial, options = {}) => {
    if (!uid) return DEFAULT_SETTINGS;
    const updated = await patchJson('/auth/settings', partial, {
      requestLabel: options.requestLabel || 'PATCH /auth/settings',
      timeoutMs: options.timeoutMs ?? 25000,
    });
    const normalized = normalizeSettings(updated);
    setSettings(normalized);
    try { localStorage.setItem(storageKey(uid), JSON.stringify(normalized)); } catch { /* ignore localStorage errors */ }
    return normalized;
  }, [uid]);

  const setSettingsSafe = useCallback((next) => {
    setSettings((prev) => {
      const resolved = (typeof next === 'function') ? next(prev) : next;
      const normalized = normalizeSettings(resolved);
      if (uid) {
        try { localStorage.setItem(storageKey(uid), JSON.stringify(normalized)); } catch { /* ignore localStorage errors */ }
      }
      return normalized;
    });
  }, [uid]);

  const value = useMemo(() => ({
    settings,
    loading,
    refreshSettings,
    patchSettings,
    setSettings: setSettingsSafe,
  }), [settings, loading, refreshSettings, patchSettings, setSettingsSafe]);

  return (
    <UserSettingsContext.Provider value={value}>
      {children}
    </UserSettingsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUserSettings() {
  const ctx = useContext(UserSettingsContext);
  if (!ctx) {
    return {
      settings: DEFAULT_SETTINGS,
      loading: false,
      refreshSettings: async () => DEFAULT_SETTINGS,
      patchSettings: async () => DEFAULT_SETTINGS,
      setSettings: () => {},
    };
  }
  return ctx;
}
