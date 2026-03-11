import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import '../../styles/carrier/Calendar.css';
import '../../styles/shipper/InviteCarrierModal.css';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toYmd(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function parseYmd(s) {
  const text = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDaysYmd(ymd, days) {
  const d = parseYmd(ymd);
  if (!d) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return toYmd(d);
}

function parseDateFlexible(value) {
  if (value == null) return null;

  if (typeof value === 'object') {
    const seconds = value?.seconds ?? value?._seconds;
    const millis = value?.milliseconds ?? value?._milliseconds;
    if (typeof millis === 'number' && Number.isFinite(millis)) {
      const d = new Date(millis);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return parseDateFlexible(n);
  }

  const ymd = parseYmd(text);
  if (ymd) return ymd;

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickFirstNonEmptyString(...vals) {
  for (const v of vals) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

function fmtMoney(amount) {
  const v = Number(amount || 0);
  if (!Number.isFinite(v)) return '$0';
  try {
    return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function normalizeReminderMinutes(list) {
  const raw = Array.isArray(list) ? list : [];
  const uniq = new Set();
  for (const x of raw) {
    const m = Number(x);
    if (!Number.isFinite(m)) continue;
    const clamped = Math.max(0, Math.min(7 * 24 * 60, Math.round(m)));
    uniq.add(clamped);
  }
  return Array.from(uniq).sort((a, b) => a - b);
}

export default function Calendar() {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const monthFetchInFlightRef = useRef(false);

  const [currentDate, setCurrentDate] = useState(new Date());

  const [calendarStatus, setCalendarStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [providerPref, setProviderPref] = useState(() => {
    try {
      return String(localStorage.getItem('fp_carrier_calendar_provider') || '').trim();
    } catch {
      return '';
    }
  });

  useEffect(() => {
    try {
      const qs = new URLSearchParams(location.search || '');
      const fromCb = String(qs.get('calendar_provider') || '').trim();
      if (fromCb) {
        localStorage.setItem('fp_carrier_calendar_provider', fromCb);
        setProviderPref(fromCb);
      }
    } catch {
      // ignore
    }
  }, [location.search]);

  const [internalEvents, setInternalEvents] = useState([]);
  const [loads, setLoads] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [complianceDocs, setComplianceDocs] = useState([]);

  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncWorking, setSyncWorking] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [form, setForm] = useState({
    title: '',
    start: toYmd(new Date()),
    description: '',
    location: '',
    reminder_minutes: 60,
  });

  const [dayOpen, setDayOpen] = useState(false);
  const [dayYmd, setDayYmd] = useState('');

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const getDaysInMonth = (date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();

    const days = [];

    for (let i = 0; i < startingDayOfWeek; i++) days.push(null);
    for (let day = 1; day <= daysInMonth; day++) days.push(day);

    while (days.length % 7 !== 0) days.push(null);
    return days;
  };

  const navigateMonth = (direction) => {
    const newDate = new Date(currentDate);
    newDate.setMonth(currentDate.getMonth() + direction);
    setCurrentDate(newDate);
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const monthRange = useMemo(() => {
    const y = currentDate.getFullYear();
    const m = currentDate.getMonth();
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    return { startYmd: toYmd(start), endYmd: toYmd(end) };
  }, [currentDate]);

  const fetchCalendarStatus = async () => {
    if (!currentUser) return;
    setStatusLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/calendar/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setCalendarStatus(data || null);
      return data || null;
    } catch {
      // ignore
    } finally {
      setStatusLoading(false);
    }
    return null;
  };

  const fetchMonthData = async () => {
    if (!currentUser) return;
    if (monthFetchInFlightRef.current) return;
    monthFetchInFlightRef.current = true;
    setDataLoading(true);
    setDataError('');
    try {
      const token = await currentUser.getIdToken();
      const qs = new URLSearchParams();
      qs.set('start', monthRange.startYmd);
      qs.set('end', monthRange.endYmd);

      const [eventsRes, loadsRes, invoicesRes, complianceRes] = await Promise.all([
        fetch(`${API_URL}/calendar/internal/events?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/loads?exclude_drafts=true&page=1&page_size=250`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/invoices?limit=500`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/compliance/status`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const failures = [];
      const maybeAddFailure = (name, res) => {
        if (!res || res.ok) return;
        failures.push(`${name} ${res.status}`);
      };
      maybeAddFailure('Events', eventsRes);
      maybeAddFailure('Loads', loadsRes);
      maybeAddFailure('Invoices', invoicesRes);
      maybeAddFailure('Compliance', complianceRes);

      const isAuthFailure = [eventsRes, loadsRes, invoicesRes, complianceRes].some((r) => r && (r.status === 401 || r.status === 403));
      if (isAuthFailure) {
        setDataError('Session expired. Please log in again.');
        return;
      }
      if (failures.length) {
        setDataError(`Some data could not be loaded (${failures.join(', ')}).`);
      }

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setInternalEvents(Array.isArray(data?.events) ? data.events : []);
      }
      if (loadsRes.ok) {
        const data = await loadsRes.json();
        setLoads(Array.isArray(data?.loads) ? data.loads : []);
      }
      if (invoicesRes.ok) {
        const data = await invoicesRes.json();
        setInvoices(Array.isArray(data?.invoices) ? data.invoices : []);
      }
      if (complianceRes.ok) {
        const data = await complianceRes.json();
        const docs = Array.isArray(data?.documents) ? data.documents : (Array.isArray(data?.items) ? data.items : []);
        setComplianceDocs(Array.isArray(docs) ? docs : []);
      }
    } catch {
      setDataError('Failed to load calendar data.');
    } finally {
      setDataLoading(false);
      monthFetchInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    fetchMonthData();
    fetchCalendarStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, monthRange.startYmd, monthRange.endYmd]);

  const derivedEvents = useMemo(() => {
    const items = [];

    for (const l of Array.isArray(loads) ? loads : []) {
      const loadId = String(l?.load_id || l?.id || '').trim();
      const loadNum = String(l?.load_number || '').trim();
      const label = loadNum ? `Load #${loadNum}` : (loadId ? `Load ${loadId.slice(-8)}` : 'Load');
      const origin = String(l?.origin || '').trim();
      const destination = String(l?.destination || '').trim();
      const route = origin && destination ? `${origin} → ${destination}` : (origin || destination || '');

      const pickupRaw = pickFirstNonEmptyString(l?.pickup_date, l?.pickup_datetime, l?.pickup_time, l?.pickupDate);
      const deliveryRaw = pickFirstNonEmptyString(l?.delivery_date, l?.delivery_datetime, l?.delivery_time, l?.deliveryDate);

      const pickupDate = pickupRaw ? parseDateFlexible(pickupRaw) : null;
      const deliveryDate = deliveryRaw ? parseDateFlexible(deliveryRaw) : null;

      if (pickupDate && !Number.isNaN(pickupDate.getTime())) {
        const ymd = toYmd(pickupDate);
        items.push({
          id: `load:${loadId || label}:pickup:${ymd}`,
          internal_id: `load:${loadId || label}:pickup`,
          type: 'loads',
          start: ymd,
          title: label,
          subtitle: route ? `Pickup • ${route}` : 'Pickup',
          description: route ? `Pickup for ${label} (${route})` : `Pickup for ${label}`,
          location: '',
        });
      }

      if (deliveryDate && !Number.isNaN(deliveryDate.getTime())) {
        const ymd = toYmd(deliveryDate);
        items.push({
          id: `load:${loadId || label}:delivery:${ymd}`,
          internal_id: `load:${loadId || label}:delivery`,
          type: 'loads',
          start: ymd,
          title: label,
          subtitle: route ? `Delivery • ${route}` : 'Delivery',
          description: route ? `Delivery for ${label} (${route})` : `Delivery for ${label}`,
          location: '',
        });
      }
    }

    for (const inv of Array.isArray(invoices) ? invoices : []) {
      const dueDate = parseDateFlexible(inv?.due_date || inv?.dueDate || inv?.due_at || inv?.dueAt);
      if (!dueDate) continue;
      const ymd = toYmd(dueDate);
      const invoiceId = String(inv?.invoice_id || '').trim();
      const invoiceNum = String(inv?.invoice_number || '').trim();
      const amount = Number(inv?.amount_total || 0);
      const status = String(inv?.status || '').trim();
      const title = invoiceNum ? `Invoice ${invoiceNum}` : (invoiceId ? `Invoice ${invoiceId.slice(-8)}` : 'Invoice');
      items.push({
        id: `invoice:${invoiceId || title}:due:${ymd}`,
        internal_id: `invoice:${invoiceId || title}:due`,
        type: 'finance',
        start: ymd,
        title,
        subtitle: status ? `Due ${fmtMoney(amount)} • ${status}` : `Due ${fmtMoney(amount)}`,
        description: `Invoice due: ${title} (${fmtMoney(amount)})`,
        location: '',
      });
    }

    for (const doc of Array.isArray(complianceDocs) ? complianceDocs : []) {
      const expiryRaw = pickFirstNonEmptyString(
        doc?.expiration_date,
        doc?.expiry_date,
        doc?.extracted_fields?.expiration_date,
        doc?.extracted_fields?.expiry_date,
      );
      const expiryDate = parseDateFlexible(expiryRaw);
      if (!expiryDate) continue;
      const ymd = toYmd(expiryDate);
      const docType = String(doc?.document_type || doc?.type || 'Document').trim();
      const file = String(doc?.file_name || doc?.filename || '').trim();
      const title = docType || file || 'Compliance Doc';
      const docId = String(doc?.id || file || docType || '').trim();
      items.push({
        id: `compliance:${docId}:expiry:${ymd}`,
        internal_id: `compliance:${docId}:expiry`,
        type: 'compliance',
        start: ymd,
        title: title.length > 28 ? `${title.slice(0, 25)}...` : title,
        subtitle: 'Expires',
        description: `Compliance document expires: ${title}`,
        location: '',
      });
    }

    for (const e of Array.isArray(internalEvents) ? internalEvents : []) {
      const start = String(e?.start || '').trim();
      const title = String(e?.title || 'Event').trim();
      const evId = String(e?.id || '').trim();
      if (!start) continue;
      items.push({
        id: evId || `internal:${start}:${title}`,
        internal_id: `internal:${evId || title}:${start}`,
        type: 'internal',
        start,
        title,
        subtitle: e?.location ? String(e.location) : '',
        description: String(e?.description || '').trim(),
        location: String(e?.location || '').trim(),
        reminders: Array.isArray(e?.reminders) ? e.reminders : [],
      });
    }

    const startYmd = monthRange.startYmd;
    const endYmd = monthRange.endYmd;
    return items
      .filter((it) => {
        const s = String(it?.start || '').trim();
        return s && s >= startYmd && s <= endYmd;
      })
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }, [loads, invoices, complianceDocs, internalEvents, monthRange.startYmd, monthRange.endYmd]);

  const eventsByDate = useMemo(() => {
    const map = new Map();
    for (const e of derivedEvents) {
      const key = String(e?.start || '').trim();
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    for (const [k, list] of map.entries()) {
      list.sort((a, b) => String(a.type).localeCompare(String(b.type)));
      map.set(k, list);
    }
    return map;
  }, [derivedEvents]);

  const getEventsForDate = (day) => {
    if (!day) return [];
    const dateString = `${currentDate.getFullYear()}-${pad2(currentDate.getMonth() + 1)}-${pad2(day)}`;
    return eventsByDate.get(dateString) || [];
  };

  const cardData = useMemo(() => {
    const normalizeStatus = (s) => String(s || '').trim().toLowerCase();
    const activeStatuses = new Set(['posted', 'tendered', 'covered', 'accepted', 'awarded', 'dispatched', 'in_transit']);

    const monthLoads = (Array.isArray(loads) ? loads : []).filter((l) => {
      const pickupRaw = pickFirstNonEmptyString(l?.pickup_date, l?.pickup_datetime, l?.pickupDate);
      const deliveryRaw = pickFirstNonEmptyString(l?.delivery_date, l?.delivery_datetime, l?.deliveryDate);
      const pickup = pickupRaw ? parseDateFlexible(pickupRaw) : null;
      const delivery = deliveryRaw ? parseDateFlexible(deliveryRaw) : null;
      const month = currentDate.getMonth();
      const year = currentDate.getFullYear();
      const pickupInMonth = pickup && !Number.isNaN(pickup.getTime()) && pickup.getMonth() === month && pickup.getFullYear() === year;
      const deliveryInMonth = delivery && !Number.isNaN(delivery.getTime()) && delivery.getMonth() === month && delivery.getFullYear() === year;
      return pickupInMonth || deliveryInMonth;
    });

    const activeLoads = monthLoads.filter((l) => activeStatuses.has(normalizeStatus(l?.status || l?.load_status)));

    let complianceUpcoming = 0;
    const now = Date.now();
    const horizon = now + 30 * 24 * 60 * 60 * 1000;
    for (const doc of Array.isArray(complianceDocs) ? complianceDocs : []) {
      const expiryRaw = pickFirstNonEmptyString(
        doc?.expiration_date,
        doc?.expiry_date,
        doc?.extracted_fields?.expiration_date,
        doc?.extracted_fields?.expiry_date,
      );
      const d = parseDateFlexible(expiryRaw);
      if (!d) continue;
      const ts = d.getTime();
      if (ts >= now && ts <= horizon) complianceUpcoming += 1;
    }

    let weekRevenue = 0;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    for (const inv of Array.isArray(invoices) ? invoices : []) {
      const s = normalizeStatus(inv?.status);
      if (s !== 'paid' && s !== 'partially_paid') continue;
      const paidAtDate = parseDateFlexible(inv?.paid_at || inv?.paidAt || inv?.paid_date || inv?.paidDate);
      if (!paidAtDate) continue;
      const ts = paidAtDate.getTime();
      if (ts < weekAgo || ts > now) continue;
      const amount = s === 'paid' ? Number(inv?.amount_total || 0) : Number(inv?.amount_paid || 0);
      weekRevenue += Number.isFinite(amount) ? amount : 0;
    }

    const status = calendarStatus || {};
    const googleConnected = Boolean(status?.google?.connected);
    const outlookConnected = Boolean(status?.outlook?.connected);
    const anyConnected = googleConnected || outlookConnected;

    let syncLabel = 'Not Connected';
    if (providerPref === 'google' && googleConnected) syncLabel = 'Google Connected';
    else if (providerPref === 'outlook' && outlookConnected) syncLabel = 'Outlook Connected';
    else if (googleConnected && outlookConnected) syncLabel = 'Google + Outlook Connected';
    else if (googleConnected) syncLabel = 'Google Connected';
    else if (outlookConnected) syncLabel = 'Outlook Connected';

    return {
      activeLoadsCount: activeLoads.length,
      complianceUpcoming,
      weekRevenueLabel: fmtMoney(weekRevenue),
      syncLabel,
      syncConnected: anyConnected,
    };
  }, [loads, invoices, complianceDocs, calendarStatus, currentDate, providerPref]);

  const startCalendarConnect = async (provider) => {
    if (!currentUser) return;
    const prov = String(provider || '').trim().toLowerCase();
    if (!prov) return;

    setSyncWorking(true);
    setSyncMsg('');

    try {
      const token = await currentUser.getIdToken();
      const returnTo = `/carrier-dashboard?nav=calendar`;
      const res = await fetch(`${API_URL}/calendar/oauth/${encodeURIComponent(prov)}/start?return_to=${encodeURIComponent(returnTo)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = res.ok ? await res.json() : null;
      const authUrl = String(data?.auth_url || '').trim();
      if (!authUrl) {
        setSyncMsg('Calendar OAuth is not configured yet on the backend.');
        return;
      }
      localStorage.setItem('fp_carrier_calendar_provider', prov);
      setProviderPref(prov);
      window.location.assign(authUrl);
    } catch {
      setSyncMsg('Failed to start calendar connection.');
    } finally {
      setSyncWorking(false);
    }
  };

  const syncExternal = async (provider) => {
    if (!currentUser) return;
    const prov = String(provider || '').trim().toLowerCase();
    if (!prov) {
      setSyncMsg('Select Google or Outlook.');
      return;
    }

    setSyncWorking(true);
    setSyncMsg('');

    try {
      const token = await currentUser.getIdToken();

      const now = new Date();
      const horizon = new Date(now);
      horizon.setDate(horizon.getDate() + 60);
      const startYmd = toYmd(new Date(now.getFullYear(), now.getMonth(), 1));
      const endYmd = toYmd(horizon);

      const events = derivedEvents
        .filter((e) => {
          const s = String(e?.start || '').trim();
          return s && s >= startYmd && s <= endYmd;
        })
        .slice(0, 250)
        .map((e) => ({
          internal_id: String(e?.internal_id || e?.id || '').trim() || `fp:${String(e?.type || 'event')}:${String(e?.start || '')}:${String(e?.title || '')}`,
          title: String(e?.title || 'Event').trim(),
          all_day: true,
          start: String(e?.start || '').trim(),
          end: addDaysYmd(String(e?.start || '').trim(), 1),
          description: String(e?.description || '').trim(),
          location: String(e?.location || '').trim(),
        }));

      const res = await fetch(`${API_URL}/calendar/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: prov, events, reminders_enabled: true }),
      });

      if (!res.ok) {
        const txt = await res.text();
        setSyncMsg(txt || 'Sync failed.');
        return;
      }

      const data = await res.json();
      setSyncMsg(`Synced ${Number(data?.synced || 0)} events to ${prov}.`);
      await fetchCalendarStatus();
    } catch {
      setSyncMsg('Sync failed.');
    } finally {
      setSyncWorking(false);
    }
  };

  const createInternalEvent = async () => {
    if (!currentUser) return;
    setAddSaving(true);
    setAddError('');

    const title = String(form.title || '').trim();
    if (!title) {
      setAddError('Title is required.');
      setAddSaving(false);
      return;
    }

    const start = String(form.start || '').trim();
    if (!parseYmd(start)) {
      setAddError('Date must be valid (YYYY-MM-DD).');
      setAddSaving(false);
      return;
    }

    const end = addDaysYmd(start, 1);
    const reminders = normalizeReminderMinutes([form.reminder_minutes]);

    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/calendar/internal/events`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          all_day: true,
          start,
          end,
          description: String(form.description || '').trim(),
          location: String(form.location || '').trim(),
          reminders,
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        setAddError(txt || 'Failed to create event.');
        return;
      }

      await fetchMonthData();
      setAddOpen(false);
      setForm((prev) => ({
        ...prev,
        title: '',
        description: '',
        location: '',
        reminder_minutes: 60,
      }));
    } catch {
      setAddError('Failed to create event.');
    } finally {
      setAddSaving(false);
    }
  };

  const days = getDaysInMonth(currentDate);

  const dayEvents = useMemo(() => {
    return dayYmd ? (eventsByDate.get(dayYmd) || []) : [];
  }, [dayYmd, eventsByDate]);

  const goToNav = (navKey) => {
    const key = String(navKey || '').trim();
    if (!key) return;
    navigate(`/carrier-dashboard?nav=${encodeURIComponent(key)}`);
  };

  return (
    <div className="calendar-container">
      {/* Header */}
      <div className="calendar-header">
        <div className="calendar-title-section">
          <h1>Calendar</h1>
        </div>
        <div className="calendar-actions">
          <button className="btn small ghost-cd" onClick={() => { setSyncMsg(''); setSyncOpen(true); }} disabled={Boolean(statusLoading)}>
            <i className="fa-solid fa-arrows-rotate"></i>
            Sync External
          </button>
          <button className="btn small-cd" onClick={() => { setAddError(''); setAddOpen(true); }} disabled={Boolean(dataLoading)}>
            <i className="fa-solid fa-plus"></i>
            Add Event
          </button>
        </div>
      </div>

      {/* Calendar Navigation */}
      <div className="calendar-nav">
        <div className="month-nav">
          <button className="nav-btn" onClick={() => navigateMonth(-1)}>
            <i className="fa-solid fa-chevron-left"></i>
          </button>
          <h2 className="current-month">
            {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
          </h2>
          <button className="nav-btn" onClick={() => navigateMonth(1)}>
            <i className="fa-solid fa-chevron-right"></i>
          </button>
        </div>
        <button className="btn small ghost-cd" onClick={goToToday}>Today</button>
      </div>

      {/* Legend */}
      <div className="calendar-legend">
        <div className="legend-item">
          <div className="legend-dot loads"></div>
          <span>Loads</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot compliance"></div>
          <span>Compliance</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot finance"></div>
          <span>Finance</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot internal"></div>
          <span>Internal</span>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="calendar-grid">
        {/* Day headers */}
        <div className="calendar-header-row">
          {dayNames.map(day => (
            <div key={day} className="day-header">{day}</div>
          ))}
        </div>
        
        {/* Calendar days */}
        <div className="calendar-body">
          {days.map((day, index) => {
            const events = getEventsForDate(day);
            const ymd = day
              ? `${currentDate.getFullYear()}-${pad2(currentDate.getMonth() + 1)}-${pad2(day)}`
              : '';

            const hasLoads = events.some((e) => e?.type === 'loads');
            const hasCompliance = events.some((e) => e?.type === 'compliance');
            const hasFinance = events.some((e) => e?.type === 'finance');
            const hasInternal = events.some((e) => e?.type === 'internal');
            return (
              <div
                key={index}
                className={`calendar-day ${!day ? 'empty' : 'clickable'}`}
                role={day ? 'button' : undefined}
                tabIndex={day ? 0 : undefined}
                onClick={() => {
                  if (!day) return;
                  setDayYmd(ymd);
                  setDayOpen(true);
                }}
                onKeyDown={(e) => {
                  if (!day) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setDayYmd(ymd);
                    setDayOpen(true);
                  }
                }}
                aria-label={day ? `Open events for ${ymd}` : undefined}
              >
                {day && (
                  <>
                    <div className="day-number">{day}</div>
                    <div className="day-dots" aria-hidden="true">
                      {hasLoads ? <span className="day-dot loads"></span> : null}
                      {hasCompliance ? <span className="day-dot compliance"></span> : null}
                      {hasFinance ? <span className="day-dot finance"></span> : null}
                      {hasInternal ? <span className="day-dot internal"></span> : null}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {dataError ? (
        <div style={{ marginBottom: 12, fontSize: 13 }}>{dataError}</div>
      ) : null}

      {syncOpen ? (
        <div className="ic-modal-backdrop" onClick={() => setSyncOpen(false)} role="dialog" aria-modal="true">
          <div className="ic-modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
            <div className="ic-modal-header">
              <h3>Sync External Calendar</h3>
              <button className="ic-close" onClick={() => setSyncOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="ic-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="ic-label" style={{ marginTop: 0 }}>Provider</label>
                <select
                  className="ic-select"
                  value={String(providerPref || '').trim().toLowerCase()}
                  onChange={(e) => {
                    const v = String(e.target.value || '').trim().toLowerCase();
                    localStorage.setItem('fp_carrier_calendar_provider', v);
                    setProviderPref(v);
                  }}
                  style={{ width: 220, marginTop: 0 }}
                >
                  <option value="">Select…</option>
                  <option value="google">Google Calendar</option>
                  <option value="outlook">Outlook Calendar</option>
                </select>
              </div>

              <div style={{ fontSize: 13, color: '#64748b' }}>
                Status: {String(cardData?.syncLabel || (statusLoading ? 'Checking…' : 'Not Connected'))}
              </div>

              {syncMsg ? (
                <div style={{ fontSize: 13 }}>{syncMsg}</div>
              ) : null}
            </div>
            <div className="ic-modal-footer">
              <div className="muted" style={{ fontSize: 12 }}>Syncs the next ~60 days</div>
              <div className="ic-actions">
                <button className="btn small ghost-cd" onClick={() => setSyncOpen(false)} disabled={Boolean(syncWorking)}>Close</button>
                <button
                  className="btn small ghost-cd"
                  onClick={async () => {
                    const prov = String(providerPref || '').trim().toLowerCase();
                    if (prov !== 'google' && prov !== 'outlook') {
                      setSyncMsg('Select Google or Outlook.');
                      return;
                    }
                    await startCalendarConnect(prov);
                  }}
                  disabled={Boolean(syncWorking)}
                >
                  {syncWorking ? 'Working…' : 'Connect'}
                </button>
                <button
                  className="btn small-cd"
                  onClick={async () => {
                    const latestStatus = await fetchCalendarStatus();
                    const status = latestStatus || calendarStatus || {};
                    const prov = String(providerPref || '').trim().toLowerCase();
                    if (prov !== 'google' && prov !== 'outlook') {
                      setSyncMsg('Select Google or Outlook.');
                      return;
                    }
                    if (!status?.[prov]?.connected) {
                      setSyncMsg(`${prov} is not connected yet. Click Connect first.`);
                      return;
                    }
                    await syncExternal(prov);
                  }}
                  disabled={Boolean(syncWorking)}
                >
                  {syncWorking ? 'Syncing…' : 'Sync Now'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {addOpen ? (
        <div className="ic-modal-backdrop" onClick={() => setAddOpen(false)} role="dialog" aria-modal="true">
          <div className="ic-modal" onClick={(e) => e.stopPropagation()} style={{ width: 620 }}>
            <div className="ic-modal-header">
              <h3>Add Internal Event</h3>
              <button className="ic-close" onClick={() => setAddOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="ic-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label className="ic-label">Title<span className="required">*</span></label>
              <input
                className="ic-input"
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="e.g., Maintenance, Safety Meeting"
              />

              <label className="ic-label">Date (YYYY-MM-DD)<span className="required">*</span></label>
              <input
                className="ic-input"
                value={form.start}
                onChange={(e) => setForm((p) => ({ ...p, start: e.target.value }))}
                placeholder="2026-03-11"
              />

              <label className="ic-label">Location</label>
              <input
                className="ic-input"
                value={form.location}
                onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))}
                placeholder="Optional"
              />

              <label className="ic-label">Description</label>
              <textarea
                className="ic-input"
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Optional"
                rows={3}
              />

              <label className="ic-label">Reminder (minutes before)</label>
              <input
                className="ic-input"
                type="number"
                value={form.reminder_minutes}
                onChange={(e) => setForm((p) => ({ ...p, reminder_minutes: e.target.value }))}
                min={0}
                max={10080}
              />

              {addError ? (
                <div style={{ fontSize: 13 }}>{addError}</div>
              ) : null}
            </div>
            <div className="ic-modal-footer">
              <div className="muted" style={{ fontSize: 12 }}>Saved as an internal FreightPower event</div>
              <div className="ic-actions">
                <button className="btn small ghost-cd" onClick={() => setAddOpen(false)} disabled={Boolean(addSaving)}>Cancel</button>
                <button className="btn small-cd" onClick={createInternalEvent} disabled={Boolean(addSaving)}>
                  {addSaving ? 'Saving…' : 'Create Event'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {dayOpen ? (
        <div className="ic-modal-backdrop" onClick={() => setDayOpen(false)} role="dialog" aria-modal="true">
          <div className="ic-modal" onClick={(e) => e.stopPropagation()} style={{ width: 720 }}>
            <div className="ic-modal-header">
              <h3>{dayYmd || 'Day Details'}</h3>
              <button className="ic-close" onClick={() => setDayOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="ic-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {dayEvents.length ? (
                dayEvents.map((ev) => (
                  <div key={String(ev.id)} className="day-detail-row">
                    <div className={`day-dot ${String(ev.type || '').trim() || 'internal'}`} aria-hidden="true"></div>
                    <div className="day-detail-text">
                      <div className="day-detail-title">{String(ev.title || 'Event')}</div>
                      {ev.subtitle ? <div className="day-detail-subtitle">{String(ev.subtitle)}</div> : null}
                      {ev.location ? <div className="day-detail-meta">{String(ev.location)}</div> : null}
                      {ev.description ? <div className="day-detail-desc">{String(ev.description)}</div> : null}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 13, color: '#64748b' }}>No events for this day.</div>
              )}
            </div>
            <div className="ic-modal-footer">
              <div className="muted" style={{ fontSize: 12 }}>Click a date to view details</div>
              <div className="ic-actions">
                <button className="btn small ghost-cd" onClick={() => setDayOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bottom Statistics */}
      <div className="calendar-stats">
        <div
          className="cal-stat-card"
          role="button"
          tabIndex={0}
          onClick={() => goToNav('my-loads')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goToNav('my-loads'); }}
          style={{ cursor: 'pointer' }}
        >
          <div className="cal-stat-icon loads">
            <i className="fa-solid fa-truck"></i>
          </div>
          <div className="cal-stat-info">
            <div className="cal-stat-label">This Month</div>
            <div className="cal-stat-number">{Number(cardData?.activeLoadsCount || 0)}</div>
            <div className="cal-stat-sublabel">Active Loads</div>
          </div>
        </div>

        <div
          className="cal-stat-card"
          role="button"
          tabIndex={0}
          onClick={() => goToNav('compliance')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goToNav('compliance'); }}
          style={{ cursor: 'pointer' }}
        >
          <div className="cal-stat-icon compliance">
            <i className="fa-solid fa-triangle-exclamation"></i>
          </div>
          <div className="cal-stat-info">
            <div className="cal-stat-label">Upcoming</div>
            <div className="cal-stat-number">{Number(cardData?.complianceUpcoming || 0)}</div>
            <div className="cal-stat-sublabel">Compliance Due</div>
          </div>
        </div>

        <div
          className="cal-stat-card"
          role="button"
          tabIndex={0}
          onClick={() => goToNav('factoring')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goToNav('factoring'); }}
          style={{ cursor: 'pointer' }}
        >
          <div className="cal-stat-icon revenue">
            <i className="fa-solid fa-dollar-sign"></i>
          </div>
          <div className="cal-stat-info">
            <div className="cal-stat-label">This Week</div>
            <div className="cal-stat-number">{String(cardData?.weekRevenueLabel || '$0')}</div>
            <div className="cal-stat-sublabel">Revenue</div>
          </div>
        </div>

        <div
          className="cal-stat-card"
          role="button"
          tabIndex={0}
          onClick={() => goToNav('integrations')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goToNav('integrations'); }}
          style={{ cursor: 'pointer' }}
        >
          <div className="cal-stat-icon sync">
            {cardData?.syncConnected ? (
              <i className="fa-solid fa-check"></i>
            ) : (
              <i className="fa-solid fa-xmark"></i>
            )}
          </div>
          <div className="cal-stat-info">
            <div className="cal-stat-label">Sync Status</div>
            <div className={`sync-status ${cardData?.syncConnected ? 'connected' : 'disconnected'}`}>
              {String(cardData?.syncLabel || (statusLoading ? 'Checking…' : 'Not Connected'))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}