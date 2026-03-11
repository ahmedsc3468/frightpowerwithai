import React from 'react';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { t } from '../../i18n/translate';

export default function AlertsNotifications({
  items,
  loading,
  isDarkMode,
  onRefresh,
  onAction,
  onMarkRead,
}) {
  const { settings } = useUserSettings();
  const language = settings?.language || 'English';
  const tr = (key, fallback) => t(language, key, fallback);

  const list = Array.isArray(items) ? items : [];
  const unopened = list.filter((n) => !n?.is_read);
  const opened = list.filter((n) => Boolean(n?.is_read));

  return (
    <div className="dd-alerts-view">
      <header className="fp-header">
        <div className="fp-header-titles">
          <h2>{tr('alerts.title', 'Alerts & Notifications')}</h2>
          <p className="fp-subtitle">{tr('alerts.subtitle', 'Updates, reminders, and important alerts.')}</p>
        </div>
        <div className="fp-header-controls">
          <button
            type="button"
            className="btn small ghost-cd"
            onClick={onRefresh}
            disabled={Boolean(loading)}
          >
            {loading ? tr('common.loading', 'Loading…') : tr('common.refresh', 'Refresh')}
          </button>
        </div>
      </header>

      <section className="fp-grid dd-alerts-grid">
        <div className="card dd-notifications-card">
          <div className="card-header">
            <h3>{tr('alerts.notificationsHeading', 'Notifications')}</h3>
          </div>

          <div className="dd-notifications-body">
            {loading ? (
              <div style={{ padding: 14, color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 13 }}>{tr('common.loading', 'Loading…')}</div>
            ) : list.length === 0 ? (
              <div style={{ padding: 14, color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 13 }}>{tr('alerts.noNotifications', 'No notifications yet.')}</div>
            ) : (
              <>
                <div style={{ padding: '10px 12px', fontWeight: 900, fontSize: 12, color: isDarkMode ? '#cbd5e1' : '#334155' }}>
                  {tr('alerts.unopened', 'Unopened')} ({unopened.length})
                </div>
                {unopened.length === 0 ? (
                  <div style={{ padding: 14, color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 13 }}>{tr('alerts.noUnopened', 'No unopened notifications.')}</div>
                ) : (
                  unopened.map((n) => {
                    const id = String(n?.id || '').trim();
                    const title = String(n?.title || tr('alerts.notification', 'Notification'));
                    const body = String(n?.message || n?.body || '');
                    const when = String(n?.relative_time || n?.formatted_time || n?.created_at_human || n?.created_at || '').trim();

                    return (
                      <div
                        key={id || Math.random()}
                        role="button"
                        tabIndex={0}
                        onClick={() => onAction?.(n)}
                        onKeyDown={(e) => e.key === 'Enter' && onAction?.(n)}
                        style={{
                          padding: 12,
                          borderTop: isDarkMode ? '1px solid rgba(148,163,184,0.14)' : '1px solid #f1f5f9',
                          background: isDarkMode ? 'rgba(59,130,246,0.10)' : '#eff6ff',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 800, color: isDarkMode ? '#e2e8f0' : '#0f172a', fontSize: 13 }}>
                              {title}
                            </div>
                            {body ? (
                              <div style={{ color: isDarkMode ? '#cbd5e1' : '#475569', fontSize: 12, lineHeight: 1.35, marginTop: 4 }}>
                                {body}
                              </div>
                            ) : null}
                            {when ? (
                              <div style={{ color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 11, marginTop: 6 }}>
                                {when}
                              </div>
                            ) : null}
                          </div>

                          <button
                            type="button"
                            className="btn small ghost-cd"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (id) onMarkRead?.(id);
                            }}
                          >
                            {tr('alerts.markRead', 'Mark read')}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}

                <div style={{ padding: '12px 12px 10px', fontWeight: 900, fontSize: 12, color: isDarkMode ? '#cbd5e1' : '#334155' }}>
                  {tr('alerts.opened', 'Opened')} ({opened.length})
                </div>
                {opened.length === 0 ? (
                  <div style={{ padding: 14, color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 13 }}>{tr('alerts.noOpened', 'No opened notifications.')}</div>
                ) : (
                  opened.map((n) => {
                    const id = String(n?.id || '').trim();
                    const title = String(n?.title || tr('alerts.notification', 'Notification'));
                    const body = String(n?.message || n?.body || '');
                    const when = String(n?.relative_time || n?.formatted_time || n?.created_at_human || n?.created_at || '').trim();

                    return (
                      <div
                        key={id || Math.random()}
                        role="button"
                        tabIndex={0}
                        onClick={() => onAction?.(n)}
                        onKeyDown={(e) => e.key === 'Enter' && onAction?.(n)}
                        style={{
                          padding: 12,
                          borderTop: isDarkMode ? '1px solid rgba(148,163,184,0.14)' : '1px solid #f1f5f9',
                          background: 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 800, color: isDarkMode ? '#e2e8f0' : '#0f172a', fontSize: 13 }}>
                            {title}
                          </div>
                          {body ? (
                            <div style={{ color: isDarkMode ? '#cbd5e1' : '#475569', fontSize: 12, lineHeight: 1.35, marginTop: 4 }}>
                              {body}
                            </div>
                          ) : null}
                          {when ? (
                            <div style={{ color: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 11, marginTop: 6 }}>
                              {when}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
