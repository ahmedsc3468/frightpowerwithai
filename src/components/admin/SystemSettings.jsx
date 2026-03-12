import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../../styles/admin/SystemSettings.css';
import Toast from '../common/Toast';
import { postJson } from '../../api/http';
import { useUserSettings } from '../../contexts/UserSettingsContext';

export default function SystemSettings(){
  const { settings, loading: settingsLoading, patchSettings, refreshSettings } = useUserSettings();
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState({ state: 'idle', message: '' });
  const [initial, setInitial] = useState(null);
  const [draft, setDraft] = useState({
    language: 'English',
    time_zone: '',
    date_format: 'mdy',
    start_dashboard_view: 'dashboard',
    auto_save_edits: true,
    email_digest_enabled: true,
  });

  const prevAutoSaveEnabledRef = useRef(false);
  const autoSaveTimerRef = useRef(null);
  const autoSaveInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const didHydrateRef = useRef(false);

  const deviceTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  }, []);

  const timeZoneOptions = useMemo(() => {
    const base = [
      { value: '', label: 'System Auto' },
      ...(deviceTimeZone ? [{ value: deviceTimeZone, label: `Device (${deviceTimeZone})` }] : []),
      { value: 'UTC', label: 'UTC' },
      { value: 'America/Chicago', label: 'America/Chicago' },
      { value: 'America/New_York', label: 'America/New_York' },
      { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
      { value: 'Europe/London', label: 'Europe/London' },
    ];
    const seen = new Set();
    return base.filter((o) => {
      const key = String(o.value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [deviceTimeZone]);

  const startViewOptions = useMemo(() => ([
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'tracking', label: 'Tracking & Visibility' },
    { value: 'analytics', label: 'Analytics' },
    { value: 'users', label: 'Users & Roles' },
    { value: 'carriers', label: 'Carriers' },
    { value: 'shippers', label: 'Shippers / Brokers' },
    { value: 'drivers', label: 'Drivers' },
    { value: 'service-providers', label: 'Service Providers' },
    { value: 'marketplace', label: 'Marketplace' },
    { value: 'messages', label: 'Messages' },
    { value: 'tasks', label: 'Tasks / To-Do' },
  ]), []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Ensure we fetch the latest settings at least once when opening the page.
        // If they are already loaded, this is a cheap no-op on the client.
        await refreshSettings();
      } catch (e) {
        if (!cancelled) {
          setToast({ type: 'error', message: String(e?.message || e) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [refreshSettings]);

  useEffect(() => {
    // Keep local draft in sync with global settings.
    // Don't clobber user edits if they have unsaved changes.
    const isLoaded = !settingsLoading;
    setLoading(!isLoaded);
    if (!isLoaded) return;

    const next = settings;
    if (!didHydrateRef.current) {
      didHydrateRef.current = true;
      setInitial(next);
      setDraft(next);
      prevAutoSaveEnabledRef.current = !!next.auto_save_edits;
      return;
    }

    const dirty = initial && JSON.stringify(initial) !== JSON.stringify(draft);
    if (!dirty) {
      setInitial(next);
      setDraft(next);
      prevAutoSaveEnabledRef.current = !!next.auto_save_edits;
    } else {
      // Keep initial stable while user is editing.
    }
  }, [settingsLoading, settings]);

  const hasChanges = useMemo(() => {
    if (!initial) return true;
    return JSON.stringify(initial) !== JSON.stringify(draft);
  }, [initial, draft]);

  const buildPayload = () => {
    const payload = {};
    if (!initial || draft.language !== initial.language) payload.language = draft.language || null;
    if (!initial || draft.time_zone !== initial.time_zone) payload.time_zone = draft.time_zone || null;
    if (!initial || draft.date_format !== initial.date_format) payload.date_format = draft.date_format;
    if (!initial || draft.start_dashboard_view !== initial.start_dashboard_view) payload.start_dashboard_view = draft.start_dashboard_view;
    if (!initial || draft.auto_save_edits !== initial.auto_save_edits) payload.auto_save_edits = !!draft.auto_save_edits;
    if (!initial || draft.email_digest_enabled !== initial.email_digest_enabled) payload.email_digest_enabled = !!draft.email_digest_enabled;
    return payload;
  };

  const saveSettings = async ({ mode } = { mode: 'manual' }) => {
    const payload = buildPayload();
    if (!Object.keys(payload).length) return { changed: false };

    setSaving(true);
    if (mode === 'auto') setAutoSaveStatus({ state: 'saving', message: 'Auto-saving…' });
    try {
      const normalized = await patchSettings(payload, { requestLabel: 'PATCH /auth/settings', timeoutMs: 25000 });
      if (isMountedRef.current) {
        setInitial(normalized);
        setDraft(normalized);
      }
      if (mode === 'manual') setToast({ type: 'success', message: 'Settings saved.' });
      if (mode === 'auto') setAutoSaveStatus({ state: 'saved', message: 'Auto-saved' });
      return { changed: true };
    } catch (e) {
      console.error(e);
      if (mode === 'manual') setToast({ type: 'error', message: String(e?.message || e) });
      if (mode === 'auto') setAutoSaveStatus({ state: 'error', message: 'Auto-save failed' });
      throw e;
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const onCancel = () => {
    setToast(null);
    if (initial) {
      setDraft(initial);
      setToast({ type: 'info', message: 'Changes discarded' });
    }
  };

  const onSave = async () => {
    setToast(null);
    if (!hasChanges) {
      setToast({ type: 'success', message: 'No changes to save.' });
      return;
    }
    try {
      await saveSettings({ mode: 'manual' });
    } catch {
      // handled by saveSettings
    }
  };

  const onSendTestDigest = async () => {
    setToast(null);
    try {
      await postJson('/admin/email-digest/send-test', {}, { requestLabel: 'POST /admin/email-digest/send-test', timeoutMs: 30000 });
      setToast({ type: 'success', message: 'Test digest sent to your email.' });
    } catch (e) {
      console.error(e);
      setToast({ type: 'error', message: String(e?.message || e) });
    }
  };

  useEffect(() => {
    if (loading) return undefined;
    if (!initial) return undefined;

    const hasUnsaved = JSON.stringify(initial) !== JSON.stringify(draft);
    if (!hasUnsaved) {
      setAutoSaveStatus({ state: 'idle', message: '' });
      prevAutoSaveEnabledRef.current = !!draft.auto_save_edits;
      return undefined;
    }

    const wasAutoSaveEnabled = prevAutoSaveEnabledRef.current;
    const isAutoSaveEnabled = !!draft.auto_save_edits;
    prevAutoSaveEnabledRef.current = isAutoSaveEnabled;

    const autoSaveAllowed = isAutoSaveEnabled || wasAutoSaveEnabled;
    if (!autoSaveAllowed) return undefined;
    if (autoSaveInFlightRef.current) return undefined;

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      if (autoSaveInFlightRef.current) return;
      autoSaveInFlightRef.current = true;
      try {
        await saveSettings({ mode: 'auto' });
      } catch {
        // status set inside saveSettings
      } finally {
        autoSaveInFlightRef.current = false;
      }
    }, 350);

    return () => {
      // Flush pending auto-save when navigating away from the settings page.
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
        if (!autoSaveInFlightRef.current) {
          autoSaveInFlightRef.current = true;
          saveSettings({ mode: 'auto' })
            .catch(() => {})
            .finally(() => { autoSaveInFlightRef.current = false; });
        }
      }
    };
  }, [draft, initial, loading]);

  return (
    <div className="system-settings-root">
      <Toast message={toast?.message} type={toast?.type} onClose={() => setToast(null)} />
      <header className="fp-header">
        <div className="fp-header-titles">
          <h2>System Settings</h2>
          <p className="fp-subtitle">All settings apply to your account only.</p>
        </div>
      </header>

      <section className="card settings-card">
        <div className="card-header"><h3>General</h3></div>
        <div className="settings-body">
          <div className="settings-grid">
            <div>
              <label className="muted">Language</label>
              <select
                className="sbd-carrier-filter-select"
                style={{width:'100%'}}
                value={draft.language}
                disabled={loading || saving}
                onChange={(e) => setDraft((d) => ({ ...d, language: e.target.value }))}
              >
                <option value="English">English</option>
                <option value="Spanish">Spanish</option>
                <option value="Arabic">Arabic</option>
              </select>
            </div>
            <div>
              <label className="muted">Time Zone</label>
              <select
                className="sbd-carrier-filter-select"
                style={{width:'100%'}}
                value={draft.time_zone}
                disabled={loading || saving}
                onChange={(e) => setDraft((d) => ({ ...d, time_zone: e.target.value }))}
              >
                {timeZoneOptions.map((o) => (
                  <option key={o.value || 'auto'} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="muted">Date & Time Format</label>
              <div className="dtfmt-list">
                <label>
                  <input
                    type="radio"
                    name="dtfmt"
                    checked={draft.date_format === 'mdy'}
                    disabled={loading || saving}
                    onChange={() => setDraft((d) => ({ ...d, date_format: 'mdy' }))}
                  />
                  {' '}MM/DD/YYYY
                </label>
                <label>
                  <input
                    type="radio"
                    name="dtfmt"
                    checked={draft.date_format === 'dmy'}
                    disabled={loading || saving}
                    onChange={() => setDraft((d) => ({ ...d, date_format: 'dmy' }))}
                  />
                  {' '}DD/MM/YYYY
                </label>
              </div>
            </div>
            <div>
              <label className="muted">Start Dashboard View</label>
              <select
                className="sbd-carrier-filter-select"
                style={{width:'100%'}}
                value={draft.start_dashboard_view}
                disabled={loading || saving}
                onChange={(e) => setDraft((d) => ({ ...d, start_dashboard_view: e.target.value }))}
              >
                {startViewOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <label className="muted">Auto Save Edits</label>
            <label className="fp-toggle">
              <input
                type="checkbox"
                checked={!!draft.auto_save_edits}
                disabled={loading || saving}
                onChange={(e)=>setDraft((d) => ({ ...d, auto_save_edits: e.target.checked }))}
              />
              <span className="switch"><span className="knob"/></span>
            </label>
          </div>

          <div className="settings-row">
            <label className="muted">Enable Email Digest Summary</label>
            <label className="fp-toggle">
              <input
                type="checkbox"
                checked={!!draft.email_digest_enabled}
                disabled={loading || saving}
                onChange={(e)=>setDraft((d) => ({ ...d, email_digest_enabled: e.target.checked }))}
              />
              <span className="switch"><span className="knob"/></span>
            </label>
          </div>

          <div className="settings-row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn ghost-cd small"
              disabled={loading || saving || !draft.email_digest_enabled}
              onClick={onSendTestDigest}
              title={!draft.email_digest_enabled ? 'Enable Email Digest Summary first' : 'Send a test digest email to you'}
            >
              Send Test Digest
            </button>
          </div>
        </div>
      </section>
      <div className="settings-actions">
        <button className="btn ghost-cd small" disabled={loading || saving} onClick={onCancel}>Cancel</button>
        <button className="btn small-cd" disabled={loading || saving || !hasChanges} onClick={onSave}>
          {saving ? 'Saving…' : (loading ? 'Loading…' : 'Save All Changes')}
        </button>
        {autoSaveStatus?.state === 'saving' && (
          <div className="muted" style={{ marginLeft: 12 }}>{autoSaveStatus.message}</div>
        )}
        {autoSaveStatus?.state === 'saved' && (
          <div className="muted" style={{ marginLeft: 12 }}>{autoSaveStatus.message}</div>
        )}
        {autoSaveStatus?.state === 'error' && (
          <div className="muted" style={{ marginLeft: 12, color: '#b91c1c' }}>{autoSaveStatus.message}</div>
        )}
      </div>
    </div>
  );
}
