
import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import { useTr } from '../../i18n/useTr';
import '../../styles/carrier/AlertsNotifications.css';

const AlertsNotifications = () => {
  const { currentUser } = useAuth();
  const { tr } = useTr();

  const TABS = {
    center: 'center',
    settings: 'settings',
  };

  const CATEGORY_OPTIONS = [
    { value: 'all', labelKey: 'alerts.filters.allCategories', labelFallback: 'All Categories' },
    { value: 'compliance', labelKey: 'alerts.category.compliance', labelFallback: 'Compliance' },
    { value: 'loads', labelKey: 'alerts.category.loads', labelFallback: 'Loads' },
    { value: 'finance', labelKey: 'alerts.category.finance', labelFallback: 'Finance' },
    { value: 'driver_dispatch', labelKey: 'alerts.category.driverDispatch', labelFallback: 'Driver/Dispatch' },
    { value: 'system', labelKey: 'alerts.category.system', labelFallback: 'System' },
    { value: 'partnership', labelKey: 'alerts.category.partnership', labelFallback: 'Partnership' },
  ];

  const STATUS_OPTIONS = [
    { value: 'all', labelKey: 'alerts.filters.allStatus', labelFallback: 'All Status' },
    { value: 'unread', labelKey: 'alerts.filters.unread', labelFallback: 'Unread' },
    { value: 'read', labelKey: 'alerts.filters.read', labelFallback: 'Read' },
    { value: 'critical', labelKey: 'alerts.priority.critical', labelFallback: 'Critical' },
    { value: 'warning', labelKey: 'alerts.priority.warning', labelFallback: 'Warning' },
  ];

  const [activeTab, setActiveTab] = useState(TABS.center);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [exporting, setExporting] = useState(false);

  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const [categoryToggles, setCategoryToggles] = useState({
    loads: true,
    compliance_alerts: true,
    finance: true,
    driver_dispatch: true,
    system: true,
  });

  const [deliveryChannels, setDeliveryChannels] = useState({
    loads: { in_app: true, email: true, sms: false, push: true },
    compliance: { in_app: true, email: true, sms: false, push: false },
    finance: { in_app: true, email: true, sms: false, push: false },
    driver_dispatch: { in_app: true, email: false, sms: false, push: false },
    system: { in_app: true, email: false, sms: false, push: true },
  });

  const [quietHoursEnabled, setQuietHoursEnabled] = useState(true);
  const [quietHoursStart, setQuietHoursStart] = useState('22:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState('06:00');

  const [digestFrequency, setDigestFrequency] = useState('realtime');
  const [escalationRulesEnabled, setEscalationRulesEnabled] = useState(false);
  const [testNotificationEnabled, setTestNotificationEnabled] = useState(true);

  const autoSaveTimerRef = useRef(null);
  const skipAutoSaveRef = useRef(true);

  // Fetch notifications from API
  useEffect(() => {
    if (currentUser && activeTab === TABS.center) {
      fetchNotifications();
    }
  }, [currentUser, activeTab]);

  useEffect(() => {
    if (currentUser && activeTab === TABS.settings) {
      fetchAlertSettings();
    }
  }, [currentUser, activeTab]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (activeTab !== TABS.settings) return;
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false;
      return;
    }
    scheduleAutoSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryToggles, deliveryChannels, quietHoursEnabled, quietHoursStart, quietHoursEnd, digestFrequency, escalationRulesEnabled, testNotificationEnabled, settingsLoaded, activeTab]);

  const fetchNotifications = async () => {
    if (!currentUser) return;
    
    setLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/notifications?page=1&page_size=50`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const formattedNotifications = (data.notifications || []).map(notif => {
          // Map notification type to category
          let category = 'system';
          let priority = 'info';
          let icon = 'fa-solid fa-bell';
          let bgColor = '#eff6ff';
          let borderColor = '#bfdbfe';

          if (notif.notification_type === 'system') {
            category = 'system';
            if (notif.title?.toLowerCase().includes('invitation')) {
              category = 'partnership';
              priority = 'info';
              icon = 'fa-solid fa-handshake';
              bgColor = '#f0fdf4';
              borderColor = '#bbf7d0';
            }
          } else if (notif.notification_type === 'load_update') {
            category = 'loads';
            icon = 'fa-solid fa-box';
          } else if (notif.notification_type === 'compliance_alert') {
            category = 'compliance';
            priority = 'critical';
            icon = 'fa-solid fa-exclamation-triangle';
            bgColor = '#fef2f2';
            borderColor = '#fecaca';
          } else if (notif.notification_type === 'payment') {
            category = 'finance';
            priority = 'success';
            icon = 'fa-solid fa-dollar-sign';
            bgColor = '#f0fdf4';
            borderColor = '#bbf7d0';
          }

          return {
            id: notif.id,
            category,
            priority,
            title: notif.title,
            description: notif.message,
            timestamp: notif.relative_time || notif.formatted_time || null,
            actions: notif.action_url ? ['viewDetails'] : [],
            isRead: notif.is_read || false,
            icon: icon,
            bgColor: bgColor,
            borderColor: borderColor,
            actionUrl: notif.action_url,
            resourceType: notif.resource_type,
            resourceId: notif.resource_id
          };
        });
        
        setNotifications(formattedNotifications);
        setUnreadCount(data.unread_count || 0);
      }
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAlertSettings = async () => {
    if (!currentUser) return;

    setSettingsLoading(true);
    setSettingsError('');
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/auth/settings`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(tr('alerts.errors.loadSettingsFailed', 'Failed to load alert settings'));
      }

      const data = await response.json();
      const prefs = (data && typeof data === 'object' && data.notification_preferences && typeof data.notification_preferences === 'object')
        ? data.notification_preferences
        : {};

      // Category toggles
      setCategoryToggles(prev => ({
        ...prev,
        loads: prefs.loads !== undefined ? !!prefs.loads : prev.loads,
        compliance_alerts: prefs.compliance_alerts !== undefined ? !!prefs.compliance_alerts : prev.compliance_alerts,
        finance: prefs.finance !== undefined ? !!prefs.finance : prev.finance,
        driver_dispatch: prefs.driver_dispatch !== undefined ? !!prefs.driver_dispatch : prev.driver_dispatch,
        system: prefs.system !== undefined ? !!prefs.system : prev.system,
      }));

      // Delivery channels
      const channels = (data && typeof data === 'object' && data.notification_channels && typeof data.notification_channels === 'object')
        ? data.notification_channels
        : {};

      setDeliveryChannels(prev => {
        const merged = { ...prev };
        for (const [cat, val] of Object.entries(channels)) {
          if (!val || typeof val !== 'object') continue;
          if (!merged[cat]) merged[cat] = { in_app: true, email: false, sms: false, push: false };
          merged[cat] = {
            ...merged[cat],
            in_app: val.in_app !== undefined ? !!val.in_app : merged[cat].in_app,
            email: val.email !== undefined ? !!val.email : merged[cat].email,
            sms: val.sms !== undefined ? !!val.sms : merged[cat].sms,
            push: val.push !== undefined ? !!val.push : merged[cat].push,
          };
        }
        return merged;
      });

      // Quiet hours
      const qStart = data?.quiet_hours_start || null;
      const qEnd = data?.quiet_hours_end || null;
      const enabled = !!(qStart && qEnd);
      setQuietHoursEnabled(enabled);
      setQuietHoursStart(enabled ? qStart : '22:00');
      setQuietHoursEnd(enabled ? qEnd : '06:00');

      const df = String(data?.digest_frequency || '').toLowerCase() || 'realtime';
      setDigestFrequency(['realtime', 'daily', 'weekly'].includes(df) ? df : 'realtime');
      setEscalationRulesEnabled(!!data?.escalation_rules_enabled);
      setTestNotificationEnabled(prefs.test_notifications !== undefined ? !!prefs.test_notifications : true);

      skipAutoSaveRef.current = true;
      setSettingsLoaded(true);
    } catch (error) {
      console.error('Error fetching alert settings:', error);
      setSettingsError(tr('alerts.errors.loadSettingsFailedShort', 'Failed to load settings'));
      setSettingsLoaded(false);
    } finally {
      setSettingsLoading(false);
    }
  };

  const buildSettingsPatchPayload = () => {
    const notification_preferences = {
      ...categoryToggles,
      // Keep legacy key in sync: backend already uses "messages" for filtering.
      messages: !!categoryToggles.driver_dispatch,
      test_notifications: !!testNotificationEnabled,
    };

    const quiet_hours_start = quietHoursEnabled ? quietHoursStart : null;
    const quiet_hours_end = quietHoursEnabled ? quietHoursEnd : null;

    return {
      notification_preferences,
      notification_channels: deliveryChannels,
      quiet_hours_start,
      quiet_hours_end,
      digest_frequency: digestFrequency,
      escalation_rules_enabled: escalationRulesEnabled,
    };
  };

  const saveAlertSettings = async () => {
    if (!currentUser) return;

    setSettingsSaving(true);
    setSettingsError('');
    try {
      const token = await currentUser.getIdToken();
      const payload = buildSettingsPatchPayload();
      const response = await fetch(`${API_URL}/auth/settings`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(tr('alerts.errors.saveSettingsFailed', 'Failed to save settings'));
      }

      // Keep local state aligned with canonical values.
      const data = await response.json();
      if (data && typeof data === 'object') {
        setEscalationRulesEnabled(!!data.escalation_rules_enabled);
        const df = String(data.digest_frequency || '').toLowerCase() || digestFrequency;
        setDigestFrequency(['realtime', 'daily', 'weekly'].includes(df) ? df : digestFrequency);
      }
    } catch (error) {
      console.error('Error saving alert settings:', error);
      setSettingsError(tr('alerts.errors.saveSettingsFailed', 'Failed to save settings'));
    } finally {
      setSettingsSaving(false);
    }
  };

  const scheduleAutoSave = () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      saveAlertSettings();
    }, 600);
  };

  const handleSendTestNotification = async () => {
    if (!currentUser) return;
    if (!testNotificationEnabled) return;
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/notifications/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error(tr('alerts.errors.sendTestFailed', 'Failed to send test notification'));
      }
      // Refresh notification center data so the new item appears immediately.
      await fetchNotifications();
      alert(tr('alerts.test.sent', 'Test notification sent.'));
    } catch (error) {
      console.error('Error sending test notification:', error);
      alert(tr('alerts.test.failed', 'Failed to send test notification.'));
    }
  };

  const escapeCsvCell = (value) => {
    if (value === null || value === undefined) return '';
    let text = value;
    if (typeof value === 'object') {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    text = String(text);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const downloadCsv = (csvText, filename) => {
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const fetchAllNotificationsForExport = async () => {
    if (!currentUser) return [];

    const token = await currentUser.getIdToken();
    const pageSize = 200;
    let page = 1;
    let total = null;
    const all = [];

    while (true) {
      const response = await fetch(`${API_URL}/notifications?page=${page}&page_size=${pageSize}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch notifications (page ${page})`);
      }

      const data = await response.json();
      const batch = Array.isArray(data.notifications) ? data.notifications : [];
      if (total === null && typeof data.total === 'number') {
        total = data.total;
      }

      all.push(...batch);

      if (batch.length === 0) break;
      if (total !== null && all.length >= total) break;
      if (batch.length < pageSize) break;
      page += 1;
      if (page > 1000) break;
    }

    return all;
  };

  const buildNotificationsCsv = (rawNotifications) => {
    const rows = Array.isArray(rawNotifications) ? rawNotifications : [];

    const preferredOrder = [
      'id',
      'title',
      'message',
      'notification_type',
      'category',
      'priority',
      'is_read',
      'created_at',
      'formatted_time',
      'relative_time',
      'action_url',
      'resource_type',
      'resource_id',
      'read_at',
      'user_id'
    ];

    const keys = new Set();
    for (const n of rows) {
      if (n && typeof n === 'object') {
        Object.keys(n).forEach((k) => keys.add(k));
      }
    }

    const remaining = Array.from(keys)
      .filter((k) => !preferredOrder.includes(k))
      .sort((a, b) => a.localeCompare(b));

    const headers = [...preferredOrder.filter((k) => keys.has(k)), ...remaining];

    const headerLine = headers.map(escapeCsvCell).join(',');
    const dataLines = rows.map((n) => headers.map((h) => escapeCsvCell(n?.[h])).join(','));
    return [headerLine, ...dataLines].join('\n');
  };

  const handleExportCsv = async () => {
    if (!currentUser || exporting) return;

    setExporting(true);
    try {
      const raw = await fetchAllNotificationsForExport();
      const csv = buildNotificationsCsv(raw);
      const dateStamp = new Date().toISOString().slice(0, 10);
      downloadCsv(csv, `notifications_${dateStamp}.csv`);
    } catch (error) {
      console.error('Error exporting notifications:', error);
      alert(tr('alerts.errors.exportFailedTryAgain', 'Failed to export notifications. Please try again.'));
    } finally {
      setExporting(false);
    }
  };

  const handleMarkAsRead = async (notificationId) => {
    if (!currentUser) return;

    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/notifications/${notificationId}/mark-read`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        // Update local state
        setNotifications(prev => prev.map(n => 
          n.id === notificationId ? { ...n, isRead: true } : n
        ));
        setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  };

  const handleActionClick = (notification) => {
    if (notification.actionUrl) {
      // Navigate to the action URL (could be an invitation, relationship, etc.)
      window.location.href = notification.actionUrl;
    }
    // Mark as read when action is clicked
    if (!notification.isRead) {
      handleMarkAsRead(notification.id);
    }
  };

  const displayNotifications = loading ? [] : notifications;

  const filteredNotifications = displayNotifications.filter(notification => {
    const matchesSearch = notification.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         notification.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || notification.category === categoryFilter;
    const matchesStatus = statusFilter === 'all' ||
                         (statusFilter === 'unread' && !notification.isRead) ||
                         (statusFilter === 'read' && notification.isRead) ||
                         notification.priority === statusFilter;
    
    return matchesSearch && matchesCategory && matchesStatus;
  });

  const getPriorityBadgeClass = (priority) => {
    switch (priority) {
      case 'critical': return 'alert-priority-critical';
      case 'warning': return 'alert-priority-warning';
      case 'success': return 'alert-priority-success';
      case 'info': return 'alert-priority-info';
      case 'update': return 'alert-priority-update';
      default: return 'alert-priority-info';
    }
  };

  const categoryLabel = (value) => {
    const opt = CATEGORY_OPTIONS.find((o) => o.value === value);
    return opt ? tr(opt.labelKey, opt.labelFallback) : tr('common.unknown', 'Unknown');
  };

  const priorityLabel = (value) => {
    if (value === 'critical') return tr('alerts.priority.critical', 'Critical');
    if (value === 'warning') return tr('alerts.priority.warning', 'Warning');
    if (value === 'success') return tr('alerts.priority.success', 'Success');
    if (value === 'update') return tr('alerts.priority.update', 'Update');
    return tr('alerts.priority.info', 'Info');
  };

  const actionLabel = (actionKey) => {
    if (actionKey === 'viewDetails') return tr('alerts.actions.viewDetails', 'View Details');
    return tr('common.view', 'View');
  };

  return (
    <div className="alert-notifications">
      {/* Header */}
      <div className="alert-header">
        <div className="alert-header-content">
          <h1>{tr('alerts.title', 'Alerts & Notifications')}</h1>
          <p className="alert-header-subtitle">{tr('alerts.subtitle', 'Manage your notifications and alert preferences')}</p>
        </div>
        <div className="alert-header-actions">
          <button className="btn small ghost-cd" onClick={handleExportCsv} disabled={!currentUser || exporting}>
            <i className="fas fa-download"></i>
            {exporting ? tr('alerts.export.exporting', 'Exporting...') : tr('common.export', 'Export')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="alert-tabs">
        <button 
          className={`alert-tab-btn ${activeTab === TABS.center ? 'active' : ''}`}
          onClick={() => setActiveTab(TABS.center)}
        >
          {tr('alerts.tabs.center', 'Notification Center')}
        </button>
        <button 
          className={`alert-tab-btn ${activeTab === TABS.settings ? 'active' : ''}`}
          onClick={() => setActiveTab(TABS.settings)}
        >
          {tr('common.settings', 'Settings')}
        </button>
      </div>

      {activeTab === TABS.center && (
        <>
          {/* Filter Bar */}
          <div className="alert-filters">
            <div className="alert-search-section">
              <div className="alert-search-box">
                <i className="fas fa-search"></i>
                <input
                  type="text"
                  placeholder={tr('alerts.search.placeholder', 'Search notifications...')}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            
            <div className="alert-filter-section">
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="alert-filter-select"
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{tr(opt.labelKey, opt.labelFallback)}</option>
                ))}
              </select>
              
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="alert-filter-select"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{tr(opt.labelKey, opt.labelFallback)}</option>
                ))}
              </select>
              
              <button 
                className="btn small-cd"
                onClick={async () => {
                  if (!currentUser || notifications.length === 0) return;
                  for (const notif of notifications.filter(n => !n.isRead)) {
                    await handleMarkAsRead(notif.id);
                  }
                }}
              >
                {tr('alerts.actions.markAllRead', 'Mark All as Read')}
              </button>
            </div>
          </div>

          {/* Notifications List */}
          <div className="alert-notifications-container">
            {loading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280' }}>
                <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', marginBottom: '8px' }}></i>
                <p>{tr('alerts.loading', 'Loading notifications...')}</p>
              </div>
            ) : (
              <>
                {filteredNotifications.map(notification => (
                  <div 
                    key={notification.id}
                    className={`alert-notification-card ${!notification.isRead ? 'unread' : ''}`}
                    data-type={notification.category}
                    onClick={() => !notification.isRead && handleMarkAsRead(notification.id)}
                    style={{ cursor: !notification.isRead ? 'pointer' : 'default' }}
                  >
                    <div className="alert-notification-header">
                      <div className="alert-notification-meta">
                        <span className="alert-notification-icon">
                          <i className={notification.icon}></i>
                        </span>
                        <span className="alert-notification-type">{categoryLabel(notification.category)}</span>
                        <span className={`alert-priority-badge ${getPriorityBadgeClass(notification.priority)}`}>
                          {priorityLabel(notification.priority)}
                        </span>
                        <span className="alert-notification-time">{notification.timestamp || tr('alerts.recently', 'Recently')}</span>
                      </div>
                      {!notification.isRead && <div className="alert-unread-indicator"></div>}
                    </div>
                    
                    <div className="alert-notification-content">
                      <h3 className="alert-notification-title">{notification.title}</h3>
                      <p className="alert-notification-description">{notification.description}</p>
                    </div>
                    
                    <div className="alert-notification-actions">
                      {notification.actions.map((action, index) => (
                        <button 
                          key={index} 
                          className="alert-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleActionClick(notification);
                          }}
                        >
                          {actionLabel(action)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                
                {filteredNotifications.length === 0 && (
                  <div className="alert-no-notifications">
                    <i className="fas fa-bell-slash"></i>
                    <p>{tr('alerts.empty', 'No notifications found matching your filters.')}</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Load More */}
          <div className="alert-load-more-section">
            <button className="btn small ghost-cd">{tr('alerts.actions.loadMore', 'Load More Notifications')}</button>
          </div>
        </>
      )}

      {activeTab === TABS.settings && (
        <div className="alert-settings-content">
          {/* Alert Categories */}
          <div className="alert-settings-section">
            <h3 className="alert-section-title">{tr('alerts.settings.categories.title', 'Alert Categories')}</h3>
            <p className="alert-section-subtitle">{tr('alerts.settings.categories.subtitle', 'Enable or disable specific types of notifications')}</p>
            
            <div className="alert-category-list">
              <div className="alert-category-item">
                <div className="alert-category-info">
                  <div className="alert-category-icon loads">
                    <i className="fa-solid fa-truck"></i>
                  </div>
                  <div className="alert-category-details">
                    <h4>{tr('alerts.category.loads', 'Loads')}</h4>
                    <p>{tr('alerts.settings.categories.loads.desc', 'Deliveries, Updates, Compliance')}</p>
                  </div>
                </div>
                <label className="alert-toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!categoryToggles.loads}
                    onChange={(e) => setCategoryToggles(prev => ({ ...prev, loads: e.target.checked }))}
                    disabled={settingsLoading}
                  />
                  <span className="alert-slider"></span>
                </label>
              </div>

              <div className="alert-category-item">
                <div className="alert-category-info">
                  <div className="alert-category-icon compliance">
                    <i className="fa-solid fa-shield-halved"></i>
                  </div>
                  <div className="alert-category-details">
                    <h4>{tr('alerts.category.compliance', 'Compliance')}</h4>
                    <p>{tr('alerts.settings.categories.compliance.desc', 'Expiring Docs, Safety Alerts, FMCSA Updates')}</p>
                  </div>
                </div>
                <label className="alert-toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!categoryToggles.compliance_alerts}
                    onChange={(e) => setCategoryToggles(prev => ({ ...prev, compliance_alerts: e.target.checked }))}
                    disabled={settingsLoading}
                  />
                  <span className="alert-slider"></span>
                </label>
              </div>

              <div className="alert-category-item">
                <div className="alert-category-info">
                  <div className="alert-category-icon finance">
                    <i className="fa-solid fa-dollar-sign"></i>
                  </div>
                  <div className="alert-category-details">
                    <h4>{tr('alerts.category.finance', 'Finance')}</h4>
                    <p>{tr('alerts.settings.categories.finance.desc', 'Invoice Paid, Factoring Status')}</p>
                  </div>
                </div>
                <label className="alert-toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!categoryToggles.finance}
                    onChange={(e) => setCategoryToggles(prev => ({ ...prev, finance: e.target.checked }))}
                    disabled={settingsLoading}
                  />
                  <span className="alert-slider"></span>
                </label>
              </div>

              <div className="alert-category-item">
                <div className="alert-category-info">
                  <div className="alert-category-icon dispatch">
                    <i className="fa-solid fa-route"></i>
                  </div>
                  <div className="alert-category-details">
                    <h4>{tr('alerts.category.driverDispatch', 'Driver/Dispatch')}</h4>
                    <p>{tr('alerts.settings.categories.driverDispatch.desc', 'HOS Violations, Equipment, Inspections')}</p>
                  </div>
                </div>
                <label className="alert-toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!categoryToggles.driver_dispatch}
                    onChange={(e) => setCategoryToggles(prev => ({ ...prev, driver_dispatch: e.target.checked }))}
                    disabled={settingsLoading}
                  />
                  <span className="alert-slider"></span>
                </label>
              </div>

              <div className="alert-category-item">
                <div className="alert-category-info">
                  <div className="alert-category-icon system">
                    <i className="fa-solid fa-cog"></i>
                  </div>
                  <div className="alert-category-details">
                    <h4>{tr('alerts.category.system', 'System')}</h4>
                    <p>{tr('alerts.settings.categories.system.desc', 'Maintenance Events, Updates, Security Alerts')}</p>
                  </div>
                </div>
                <label className="alert-toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!categoryToggles.system}
                    onChange={(e) => setCategoryToggles(prev => ({ ...prev, system: e.target.checked }))}
                    disabled={settingsLoading}
                  />
                  <span className="alert-slider"></span>
                </label>
              </div>
            </div>
          </div>

          {/* Delivery Methods */}
          <div className="alert-settings-section">
            <h3 className="alert-section-title">{tr('alerts.settings.delivery.title', 'Delivery Methods')}</h3>
            <p className="alert-section-subtitle">{tr('alerts.settings.delivery.subtitle', 'Choose how you want to receive notifications for each category')}</p>
            
            <div className="alert-delivery-scrollwrap">
              <div className="alert-delivery-table">
              <div className="alert-delivery-header">
                <div className="alert-category-col">{tr('alerts.settings.delivery.categoryCol', 'Category')}</div>
                <div className="alert-method-col">
                  <i className="fa-solid fa-bell"></i>
                  {tr('alerts.settings.delivery.inApp', 'In-App')}
                </div>
                <div className="alert-method-col">
                  <i className="fa-solid fa-envelope"></i>
                  {tr('common.email', 'Email')}
                </div>
                <div className="alert-method-col">
                  <i className="fa-solid fa-mobile-screen"></i>
                  {tr('alerts.settings.delivery.sms', 'SMS')}
                </div>
                <div className="alert-method-col">
                  <i className="fa-solid fa-satellite-dish"></i>
                  {tr('alerts.settings.delivery.push', 'Push')}
                </div>
              </div>

              <div className="alert-delivery-row">
                <div className="alert-category-name">{tr('alerts.category.loads', 'Loads')}</div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.loads?.in_app}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, loads: { ...(prev.loads || {}), in_app: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.loads?.email}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, loads: { ...(prev.loads || {}), email: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.loads?.sms}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, loads: { ...(prev.loads || {}), sms: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.loads?.push}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, loads: { ...(prev.loads || {}), push: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
              </div>

              <div className="alert-delivery-row">
                <div className="alert-category-name">{tr('alerts.category.compliance', 'Compliance')}</div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.compliance?.in_app}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, compliance: { ...(prev.compliance || {}), in_app: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.compliance?.email}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, compliance: { ...(prev.compliance || {}), email: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.compliance?.sms}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, compliance: { ...(prev.compliance || {}), sms: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.compliance?.push}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, compliance: { ...(prev.compliance || {}), push: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
              </div>

              <div className="alert-delivery-row">
                <div className="alert-category-name">{tr('alerts.category.finance', 'Finance')}</div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.finance?.in_app}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, finance: { ...(prev.finance || {}), in_app: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.finance?.email}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, finance: { ...(prev.finance || {}), email: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.finance?.sms}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, finance: { ...(prev.finance || {}), sms: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.finance?.push}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, finance: { ...(prev.finance || {}), push: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
              </div>

              <div className="alert-delivery-row">
                <div className="alert-category-name">{tr('alerts.category.driverDispatch', 'Driver/Dispatch')}</div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.driver_dispatch?.in_app}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, driver_dispatch: { ...(prev.driver_dispatch || {}), in_app: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.driver_dispatch?.email}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, driver_dispatch: { ...(prev.driver_dispatch || {}), email: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.driver_dispatch?.sms}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, driver_dispatch: { ...(prev.driver_dispatch || {}), sms: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.driver_dispatch?.push}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, driver_dispatch: { ...(prev.driver_dispatch || {}), push: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
              </div>

              <div className="alert-delivery-row">
                <div className="alert-category-name">{tr('alerts.category.system', 'System')}</div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.system?.in_app}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, system: { ...(prev.system || {}), in_app: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.system?.email}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, system: { ...(prev.system || {}), email: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.system?.sms}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, system: { ...(prev.system || {}), sms: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
                <div className="alert-method-checkbox">
                  <input
                    type="checkbox"
                    checked={!!deliveryChannels.system?.push}
                    onChange={(e) => setDeliveryChannels(prev => ({ ...prev, system: { ...(prev.system || {}), push: e.target.checked } }))}
                    disabled={settingsLoading}
                  />
                </div>
              </div>
              </div>
            </div>
          </div>

          {/* Quiet Hours */}
          <div className="alert-settings-section">
            <h3 className="alert-section-title">{tr('alerts.settings.quietHours.title', 'Quiet Hours')}</h3>
            <p className="alert-section-subtitle">{tr('alerts.settings.quietHours.subtitle', "Set hours when you don't want to receive push notifications")}</p>
            
            <div className="alert-quiet-hours-toggle">
              <label className="alert-toggle-switch">
                <input
                  type="checkbox"
                  checked={!!quietHoursEnabled}
                  onChange={(e) => setQuietHoursEnabled(e.target.checked)}
                  disabled={settingsLoading}
                />
                <span className="alert-slider"></span>
              </label>
              <span className="alert-toggle-label">{tr('alerts.settings.quietHours.enable', 'Enable Quiet Hours')}</span>
            </div>

            <div className="alert-time-inputs">
              <div className="alert-time-group">
                <label>{tr('alerts.settings.quietHours.startTime', 'Start Time')}</label>
                <div className="alert-time-input">
                  <input
                    type="time"
                    value={quietHoursStart}
                    onChange={(e) => setQuietHoursStart(e.target.value)}
                    disabled={settingsLoading || !quietHoursEnabled}
                  />
                </div>
              </div>
              <div className="alert-time-separator">to</div>
              <div className="alert-time-group">
                <label>{tr('alerts.settings.quietHours.endTime', 'End Time')}</label>
                <div className="alert-time-input">
                  <input
                    type="time"
                    value={quietHoursEnd}
                    onChange={(e) => setQuietHoursEnd(e.target.value)}
                    disabled={settingsLoading || !quietHoursEnabled}
                  />
                </div>
              </div>
            </div>

            <div className="alert-quiet-hours-note">
              <i className="fa-solid fa-info-circle"></i>
              <span>{tr('alerts.settings.quietHours.note', "Alerts will still be logged in your notification feed but won't trigger push notifications during quiet hours")}</span>
            </div>
          </div>

          {/* Digest Mode */}
          <div className="alert-settings-section">
            <h3 className="alert-section-title">{tr('alerts.settings.digest.title', 'Digest Mode')}</h3>
            <p className="alert-section-subtitle">{tr('alerts.settings.digest.subtitle', 'Choose how frequently you want to receive notification summaries')}</p>
            
            <div className="alert-digest-options">
              <label className="alert-digest-option">
                <input
                  type="radio"
                  name="digest"
                  value="realtime"
                  checked={digestFrequency === 'realtime'}
                  onChange={() => setDigestFrequency('realtime')}
                  disabled={settingsLoading}
                />
                <div className="alert-option-content">
                  <div className="alert-option-icon">
                    <i className="fa-solid fa-bolt"></i>
                  </div>
                  <div className="alert-option-details">
                    <h4>{tr('alerts.settings.digest.realtime.title', 'Real-Time')}</h4>
                    <p>{tr('alerts.settings.digest.realtime.desc', 'Receive notifications immediately as they occur')}</p>
                  </div>
                </div>
              </label>

              <label className="alert-digest-option">
                <input
                  type="radio"
                  name="digest"
                  value="daily"
                  checked={digestFrequency === 'daily'}
                  onChange={() => setDigestFrequency('daily')}
                  disabled={settingsLoading}
                />
                <div className="alert-option-content">
                  <div className="alert-option-icon">
                    <i className="fa-solid fa-calendar-day"></i>
                  </div>
                  <div className="alert-option-details">
                    <h4>{tr('alerts.settings.digest.daily.title', 'Daily Digest')}</h4>
                    <p>{tr('alerts.settings.digest.daily.desc', 'Get a daily summary once per day')}</p>
                  </div>
                </div>
              </label>

              <label className="alert-digest-option">
                <input
                  type="radio"
                  name="digest"
                  value="weekly"
                  checked={digestFrequency === 'weekly'}
                  onChange={() => setDigestFrequency('weekly')}
                  disabled={settingsLoading}
                />
                <div className="alert-option-content">
                  <div className="alert-option-icon">
                    <i className="fa-solid fa-calendar-week"></i>
                  </div>
                  <div className="alert-option-details">
                    <h4>{tr('alerts.settings.digest.weekly.title', 'Weekly Digest')}</h4>
                    <p>{tr('alerts.settings.digest.weekly.desc', 'Receive a summary once per week')}</p>
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Escalation Rules */}
          <div className="alert-settings-section">
            <h3 className="alert-section-title">{tr('alerts.settings.escalation.title', 'Escalation Rules')}</h3>
            <p className="alert-section-subtitle">{tr('alerts.settings.escalation.subtitle', 'Automatically escalate critical alerts if not acknowledged')}</p>
            
            <div className="alert-escalation-toggle">
              <label className="alert-toggle-switch">
                <input
                  type="checkbox"
                  checked={!!escalationRulesEnabled}
                  onChange={(e) => setEscalationRulesEnabled(e.target.checked)}
                  disabled={settingsLoading}
                />
                <span className="alert-slider"></span>
              </label>
              <span className="alert-toggle-label">{tr('alerts.settings.escalation.enable', 'Enable Escalation Rules')}</span>
            </div>
          </div>

          {/* Test & App Settings */}
          <div className="alert-settings-section">
            <h3 className="alert-section-title">{tr('alerts.settings.test.title', 'Test & App Settings')}</h3>
            <p className="alert-section-subtitle">{tr('alerts.settings.test.subtitle', 'Test your notification settings before saving changes')}</p>
            
            <div className="alert-test-settings">
              <div className="alert-test-notification">
                <label className="alert-toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!testNotificationEnabled}
                    onChange={(e) => setTestNotificationEnabled(e.target.checked)}
                    disabled={settingsLoading}
                  />
                  <span className="alert-slider"></span>
                </label>
                <span className="alert-toggle-label">{tr('alerts.settings.test.testNotification', 'Test Notification')}</span>
              </div>

              <button className="btn small-cd" onClick={handleSendTestNotification} disabled={settingsLoading || settingsSaving || !testNotificationEnabled}>
                {tr('alerts.settings.test.sendTest', 'Send Test')}
              </button>
            </div>

            <div className="alert-app-settings-note">
              <div className="alert-note-content">
                <i className="fa-solid fa-info-circle"></i>
                <div className="alert-note-text">
                  <strong>Pro Tip</strong>
                  <p>{tr('alerts.settings.test.proTipBody', 'Use the test notification feature to verify your delivery methods are working correctly. All changes are auto-saved when toggled, but content settings require manual saving.')}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Save Settings Button */}
          <div className="alert-settings-actions">
            <button
              className="btn small-cd"
              onClick={() => {
                if (autoSaveTimerRef.current) {
                  clearTimeout(autoSaveTimerRef.current);
                  autoSaveTimerRef.current = null;
                }
                saveAlertSettings();
              }}
              disabled={settingsLoading || settingsSaving}
            >
              <i className="fa-solid fa-check"></i>
              {settingsSaving ? tr('alerts.settings.saving', 'Saving...') : tr('alerts.settings.save', 'Save Settings')}
            </button>
            {(settingsLoading || settingsError) && (
              <div style={{ marginTop: '8px', color: settingsError ? '#b91c1c' : '#6b7280', fontSize: '12px' }}>
                {settingsLoading ? tr('alerts.settings.loading', 'Loading settings...') : settingsError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AlertsNotifications;