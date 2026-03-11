import React, { useEffect, useMemo, useState } from 'react';
import '../../styles/carrier/Messaging.css';
import { getJson, openEventSource, postJson } from '../../api/http';
import { AUTO_REFRESH_MS } from '../../constants/refresh';

function initials(value) {
  const s = String(value || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase()).join('') || '?';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Messaging({ initialThreadId = null } = {}) {
  const [threads, setThreads] = useState([]);
  const [selectedThread, setSelectedThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [adminThreads, setAdminThreads] = useState([]);
  const [unreadSummary, setUnreadSummary] = useState({ total_unread: 0, threads: {}, channels: {} });
  const [drivers, setDrivers] = useState([]);
  const [shippers, setShippers] = useState([]);
  const [peerType, setPeerType] = useState('drivers'); // drivers | shippers
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [error, setError] = useState('');
  const streamRef = React.useRef(null);
  const threadsStreamRef = React.useRef(null);
  const unreadRefreshTimerRef = React.useRef(null);
  const didInitSelectRef = React.useRef(false);

  // Responsive state: show chat or contacts on mobile
  const [showChatMobile, setShowChatMobile] = useState(false);

  const filterTypesForPeer = useMemo(() => {
    return peerType === 'drivers' ? ['All', 'Direct', 'Groups'] : ['All', 'Direct'];
  }, [peerType]);

  const availableNewPeers = useMemo(() => {
    const existing = new Set();
    (threads || []).forEach(t => {
      if (peerType === 'drivers' && t.kind === 'carrier_driver_direct') {
        const id = (t.driver_ids && t.driver_ids[0]) || null;
        if (id) existing.add(id);
      }
      if (peerType === 'shippers' && t.kind === 'shipper_carrier_direct') {
        const id = t.shipper_id || null;
        if (id) existing.add(id);
      }
    });

    const list = peerType === 'drivers' ? (drivers || []) : (shippers || []);
    return list.filter(p => !existing.has(p.id));
  }, [threads, peerType, drivers, shippers]);

  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (threads || []).filter(t => {
      const kind = t.kind;
      const peerOk = peerType === 'drivers'
        ? (kind === 'carrier_driver_direct' || kind === 'carrier_driver_group')
        : (kind === 'shipper_carrier_direct');

      const typeOk =
        filter === 'All' ||
        (filter === 'Direct' && (kind === 'carrier_driver_direct' || kind === 'shipper_carrier_direct')) ||
        (filter === 'Groups' && kind === 'carrier_driver_group');

      const title = String(t.display_title || t.other_display_name || t.title || '').toLowerCase();
      const last = String(t.last_message?.text || '').toLowerCase();
      const searchOk = !q || title.includes(q) || last.includes(q);
      return peerOk && typeOk && searchOk;
    });
  }, [threads, search, filter, peerType]);

  const filteredAdminThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (adminThreads || []).filter(t => {
      const title = String(t.display_title || t.title || '').toLowerCase();
      const last = String(t.last_message?.text || '').toLowerCase();
      return !q || title.includes(q) || last.includes(q);
    });
  }, [adminThreads, search]);

  async function refreshThreads() {
    const data = await getJson('/messaging/threads?limit=200', { timeoutMs: 45000, requestLabel: 'GET /messaging/threads?limit=200' });
    const next = data.threads || [];
    setThreads(next);
    try {
      localStorage.setItem('messaging:carrier:threads', JSON.stringify({ ts: Date.now(), threads: next }));
    } catch {
      // ignore
    }
  }

  async function refreshUnread() {
    const data = await getJson('/messaging/unread/summary', { timeoutMs: 30000, requestLabel: 'GET /messaging/unread/summary' });
    setUnreadSummary(data || { total_unread: 0, threads: {}, channels: {} });
    try {
      const total = Number(data?.total_unread || 0);
      window.dispatchEvent(new CustomEvent('messaging:unread', { detail: { total_unread: total } }));
    } catch {
      // ignore
    }
  }

  async function refreshAdminThreads() {
    const channels = await getJson('/messaging/notifications/channels', { timeoutMs: 30000, requestLabel: 'GET /messaging/notifications/channels' });
    const items = (channels.channels || []).map((ch) => {
      const last = ch.last_message || null;
      const lastText = last
        ? (last.title ? `${last.title}: ${last.text || ''}` : (last.text || ''))
        : '';

      return {
        id: `admin:${ch.id}`,
        kind: 'admin_channel',
        channel_id: ch.id,
        title: ch.name || ch.id,
        display_title: ch.name || ch.id,
        last_message: last ? { text: lastText } : null,
        last_message_at: ch.last_message_at || null,
        pinned: true,
      };
    });

    items.sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
    setAdminThreads(items);
  }

  async function refreshDrivers() {
    const data = await getJson('/messaging/carrier/drivers', { timeoutMs: 30000 });
    setDrivers(data.drivers || []);
  }

  async function refreshShippers() {
    const data = await getJson('/messaging/carrier/shippers', { timeoutMs: 30000 });
    setShippers(data.shippers || []);
  }

  async function selectThread(thread) {
    if (streamRef.current) {
      try { streamRef.current.close(); } catch { /* ignore */ }
      streamRef.current = null;
    }
    setSelectedThread(thread);
    setThreadLoading(true);
    setMessages([]);
    setThreadError('');

    if (thread.kind === 'admin_channel') {
      try {
        const data = await getJson(`/messaging/notifications/channels/${thread.channel_id}/messages?limit=200`, { timeoutMs: 30000 });
        setMessages(data.messages || []);
      } catch (e) {
        setThreadError(e?.message || 'Failed to load notifications');
      } finally {
        setThreadLoading(false);
      }
      try {
        await postJson(`/messaging/notifications/channels/${thread.channel_id}/read`, {});
        refreshUnread().catch(() => {});
      } catch {
        // ignore
      }
      return;
    }

    let data;
    try {
      data = await getJson(`/messaging/threads/${thread.id}/messages?limit=100`, { timeoutMs: 30000 });
      setMessages(data.messages || []);
    } catch (e) {
      setThreadError(e?.message || 'Failed to load conversation');
      return;
    } finally {
      setThreadLoading(false);
    }

    try {
      await postJson(`/messaging/threads/${thread.id}/read`, {});
      refreshUnread().catch(() => {});
    } catch {
      // ignore
    }

    try {
      const lastTs = (data.messages || []).length ? (data.messages[data.messages.length - 1].created_at || 0) : 0;
      const es = await openEventSource(`/messaging/threads/${thread.id}/stream`, { since: lastTs });
      streamRef.current = es;
      es.onmessage = (evt) => {
        try {
          const payload = JSON.parse(evt.data);
          if (payload?.type === 'message' && payload?.message) {
            setMessages((prev) => {
              const next = [...(prev || [])];
              if (!next.find(m => m.id === payload.message.id)) next.push(payload.message);
              return next;
            });
            refreshThreads().catch(() => {});
            // If user is currently viewing this thread, mark it read.
            postJson(`/messaging/threads/${thread.id}/read`, {}).then(() => refreshUnread().catch(() => {})).catch(() => {});
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // SSE might fail in dev if backend not running; UI still works via manual refresh.
    }
  }

  const handleSend = async () => {
    if (!message.trim() || !selectedThread) return;
    if (selectedThread.kind === 'admin_channel') return;
    const text = message.trim();
    setMessage('');
    await postJson(`/messaging/threads/${selectedThread.id}/messages`, { text }, { timeoutMs: 30000 });
    postJson(`/messaging/threads/${selectedThread.id}/read`, {}).catch(() => {});
    await refreshThreads();
    refreshUnread().catch(() => {});
    await selectThread({ ...selectedThread });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        // Instant UI: try cached threads first.
        try {
          const cached = JSON.parse(localStorage.getItem('messaging:carrier:threads') || 'null');
          if (cached?.threads?.length) setThreads(cached.threads);
        } catch {
          // ignore
        }
        // Fast initial render: load thread lists first.
        const attempt = async () => {
          const first = await Promise.allSettled([refreshThreads(), refreshAdminThreads()]);
          const firstErr = first.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        };
        try {
          await attempt();
        } catch (_e1) {
          // One retry for transient timeouts.
          await new Promise(r => setTimeout(r, 800));
          await attempt();
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load messaging');
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Non-blocking background loads
      Promise.allSettled([refreshDrivers(), refreshShippers(), refreshUnread()]).catch(() => {});
    })();
    return () => {
      cancelled = true;
      if (unreadRefreshTimerRef.current) {
        clearTimeout(unreadRefreshTimerRef.current);
        unreadRefreshTimerRef.current = null;
      }
      if (streamRef.current) {
        try { streamRef.current.close(); } catch { /* ignore */ }
        streamRef.current = null;
      }
      if (threadsStreamRef.current) {
        try { threadsStreamRef.current.close(); } catch { /* ignore */ }
        threadsStreamRef.current = null;
      }
    };
  }, []);

  // Deep-link support: auto-open a specific thread when navigating from an email.
  useEffect(() => {
    if (didInitSelectRef.current) return;
    const tid = String(initialThreadId || '').trim();
    if (!tid) return;
    if (selectedThread) {
      didInitSelectRef.current = true;
      return;
    }
    const match = (threads || []).find(t => t?.id === tid);
    if (match) {
      didInitSelectRef.current = true;
      setShowChatMobile(true);
      selectThread(match);
    }
  }, [initialThreadId, threads, selectedThread]);

  // Real-time sidebar updates via SSE (best-effort)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (threadsStreamRef.current) {
          try { threadsStreamRef.current.close(); } catch { /* ignore */ }
          threadsStreamRef.current = null;
        }

        const since = (threads || []).reduce((m, t) => Math.max(m, Number(t.updated_at || 0)), 0);
        const es = await openEventSource('/messaging/threads/stream', { since, limit: 200 });
        threadsStreamRef.current = es;
        es.onmessage = (evt) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse(evt.data);
            if (payload?.type !== 'threads' || !Array.isArray(payload.threads)) return;
            const incoming = payload.threads;
            setThreads((prev) => {
              const map = new Map((prev || []).map(t => [t.id, t]));
              incoming.forEach((t) => {
                if (!t?.id) return;
                map.set(t.id, { ...(map.get(t.id) || {}), ...t });
              });
              const out = Array.from(map.values());
              out.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
              return out;
            });

            // Debounced unread refresh (keeps badges in sync)
            if (unreadRefreshTimerRef.current) clearTimeout(unreadRefreshTimerRef.current);
            unreadRefreshTimerRef.current = setTimeout(() => {
              refreshUnread().catch(() => {});
            }, 400);
          } catch {
            // ignore
          }
        };
      } catch {
        // SSE best-effort; ignore.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll admin notifications so broadcasts show up without hard refresh
  useEffect(() => {
    let alive = true;
    const intervalId = setInterval(() => {
      refreshAdminThreads().catch(() => {});
      refreshUnread().catch(() => {});
      if (selectedThread?.kind === 'admin_channel') {
        getJson(`/messaging/notifications/channels/${selectedThread.channel_id}/messages?limit=200`)
          .then((data) => { if (alive) setMessages(data.messages || []); })
          .catch(() => {});
      }
    }, AUTO_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, [selectedThread]);

  // Handle selecting a chat (mobile: show chat screen)
  const handleSelectChat = (chat) => {
    selectThread(chat);
    if (window.innerWidth <= 640) setShowChatMobile(true);
  };

  // Handle back to contacts (mobile)
  const handleBack = () => {
    setShowChatMobile(false);
  };

  // Responsive: show only contacts or chat on mobile/medium (reactive, up to 900px)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900);
  React.useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= 900);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  React.useEffect(() => {
    if (!newChatOpen) return;
    const onDocClick = () => setNewChatOpen(false);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [newChatOpen]);

  return (
    <>
      {/* Messaging Header */}
      <header className="messaging-header">
        <div className="header-content">
          <h1>Messaging</h1>
          <p className="header-subtitle">Chat with your {peerType === 'drivers' ? 'drivers' : 'shippers'}</p>
        </div>
      </header>

      <div className="messaging-root">
        {/* Sidebar (Contacts) */}
        {(!isMobile || !showChatMobile) && (
          <aside className="sidebar">
            <div className="sidebar-header">
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    padding: 4,
                    borderRadius: 10,
                    background: '#f1f5f9',
                    alignItems: 'center'
                  }}
                >
                  <button
                    className={`chat-filter-btn${peerType === 'drivers' ? ' active' : ''}`}
                    style={{ padding: '6px 10px', borderRadius: 8 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPeerType('drivers');
                      setFilter('All');
                      setNewChatOpen(false);
                      setSelectedThread(null);
                      setMessages([]);
                    }}
                    title="Driver messages"
                  >
                    Drivers
                  </button>
                  <button
                    className={`chat-filter-btn${peerType === 'shippers' ? ' active' : ''}`}
                    style={{ padding: '6px 10px', borderRadius: 8 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPeerType('shippers');
                      setFilter('All');
                      setNewChatOpen(false);
                      setSelectedThread(null);
                      setMessages([]);
                    }}
                    title="Shipper messages"
                  >
                    Shippers
                  </button>
                </div>

                <div style={{ position: 'relative', marginLeft: 'auto' }}>
                  <button
                    className="chat-filter-btn"
                    style={{ padding: '6px 10px', borderRadius: 8 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNewChatOpen((s) => !s);
                    }}
                    title={`Start new ${peerType === 'drivers' ? 'driver' : 'shipper'} chat`}
                  >
                    +
                  </button>

                  {newChatOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        width: 280,
                        background: 'white',
                        border: '1px solid rgba(0,0,0,0.12)',
                        borderRadius: 10,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                        zIndex: 20,
                        overflow: 'hidden',
                        maxHeight: 300,
                        overflowY: 'auto'
                      }}
                    >
                      <div style={{ padding: '10px 12px', fontWeight: 700, fontSize: 13, borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                        Available {peerType === 'drivers' ? 'drivers' : 'shippers'}
                      </div>
                      {availableNewPeers.length === 0 ? (
                        <div style={{ padding: 12, opacity: 0.75, fontSize: 13 }}>
                          No {peerType === 'drivers' ? 'drivers' : 'shippers'} without chats.
                        </div>
                      ) : (
                        availableNewPeers.map((p) => (
                          <button
                            key={p.id}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '10px 12px',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              textAlign: 'left'
                            }}
                            onClick={async () => {
                              try {
                                setError('');
                                setNewChatOpen(false);
                                const res = peerType === 'drivers'
                                  ? await postJson('/messaging/carrier/threads/direct', { driver_id: p.id })
                                  : await postJson('/messaging/carrier/threads/shipper-direct', { shipper_id: p.id });
                                await refreshThreads();
                                await selectThread(res.thread);
                                if (window.innerWidth <= 640) setShowChatMobile(true);
                              } catch (err) {
                                setError(err?.message || 'Failed to start chat');
                              }
                            }}
                          >
                            {p.profile_picture_url ? (
                              <img src={p.profile_picture_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                            ) : (
                              <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>
                                {initials(p.name || p.email || p.id)}
                              </div>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name || p.email || p.id}</div>
                              {p.company_name && <div style={{ fontSize: 12, opacity: 0.75 }}>{p.company_name}</div>}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                <button
                  className="chat-filter-btn"
                  style={{ padding: '6px 10px', borderRadius: 8 }}
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      setError('');
                      setRefreshing(true);
                      const results = await Promise.allSettled([
                        refreshThreads(),
                        refreshAdminThreads(),
                        refreshDrivers(),
                        refreshShippers(),
                        refreshUnread(),
                      ]);
                      const firstErr = results.find(r => r.status === 'rejected')?.reason;
                      if (firstErr) setError(firstErr?.message || 'Refresh failed');
                    } catch (err) {
                      setError(err?.message || 'Refresh failed');
                    } finally {
                      setRefreshing(false);
                    }
                  }}
                  title="Refresh chats"
                >
                  Refresh
                </button>
              </div>
              <div className="sidebar-search">
                <i className="fa-solid fa-search"></i>
                <input
                  type="text"
                  placeholder="Search conversations..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="filter-buttons">
                {filterTypesForPeer.map(type => (
                  <button
                    key={type}
                    className={`chat-filter-btn${filter === type ? ' active' : ''}`}
                    onClick={() => setFilter(type)}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
            <div className="chats-list">
              {error && (
                <div style={{ padding: 12, color: '#b91c1c' }}>{error}</div>
              )}
              {loading && (
                <div style={{ padding: 12, opacity: 0.8 }}>Loading…</div>
              )}
              {refreshing && (
                <div style={{ padding: 12, opacity: 0.8 }}>Refreshing…</div>
              )}

              {!loading && filteredAdminThreads.length > 0 && (
                <div style={{ padding: '8px 20px 4px', fontSize: 12, fontWeight: 800, color: '#64748b' }}>
                  Admin Notifications
                </div>
              )}
              {filteredAdminThreads.map((t) => (
                <div
                  key={t.id}
                  className={`chat-item${selectedThread && selectedThread.id === t.id ? ' active' : ''}`}
                  onClick={() => handleSelectChat(t)}
                >
                  <div className="chat-avatar" style={{ background: '#fee2e2' }}>
                    <div style={{ position: 'relative', width: 36, height: 36 }}>
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#991b1b' }}>
                        {initials(t.display_title || 'Admin')}
                      </div>
                    </div>
                  </div>
                  <div className="chat-info">
                    <div className="chat-title">{t.display_title || 'Admin'}</div>
                    <div className="chat-last">{t.last_message?.text || 'One-way notifications'}</div>
                  </div>
                  <div className="chat-meta">
                    <span className="chat-time">{fmtTime(t.last_message_at)}</span>
                    {unreadSummary?.channels?.[t.channel_id]?.has_unread && (!selectedThread || selectedThread.id !== t.id) && (
                      <span className="chat-unread">●</span>
                    )}
                  </div>
                </div>
              ))}

              {!loading && filteredThreads.length === 0 && (
                <div style={{ padding: 12, opacity: 0.8 }}>No conversations yet.</div>
              )}
              {filteredThreads.map(chat => (
                <div
                  key={chat.id}
                  className={`chat-item${selectedThread && selectedThread.id === chat.id ? ' active' : ''}`}
                  onClick={() => handleSelectChat(chat)}
                >
                  <div className="chat-avatar">
                    <div style={{ position: 'relative', width: 36, height: 36 }}>
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {initials(chat.display_title || chat.other_display_name || chat.title)}
                      </div>
                      {chat.other_photo_url && (
                        <img
                          src={chat.other_photo_url}
                          alt="avatar"
                          style={{ position: 'absolute', inset: 0, width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }}
                          onError={(e) => { e.currentTarget.remove(); }}
                        />
                      )}
                    </div>
                  </div>
                  <div className="chat-info">
                    <div className="chat-title">{chat.display_title || chat.other_display_name || chat.title || 'Conversation'}</div>
                    <div className="chat-last">{chat.last_message?.text || ''}</div>
                  </div>
                  <div className="chat-meta">
                    <span className="chat-time">{fmtTime(chat.last_message_at)}</span>
                    {unreadSummary?.threads?.[chat.id]?.has_unread && (!selectedThread || selectedThread.id !== chat.id) && (
                      <span className="chat-unread">●</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}

        {/* Main Chat Area */}
        {((!isMobile && selectedThread) || (isMobile && showChatMobile && selectedThread)) && (
          <main className="main-chat">
            {/* Chat Header */}
            <div className="chat-header">
              {isMobile && (
                <button className="back-btn" onClick={handleBack} style={{marginRight:12,background:'none',border:'none',fontSize:20,cursor:'pointer'}}>
                  <i className="fa-solid fa-arrow-left"></i>
                </button>
              )}
              <div className="header-info">
                <div className="header-avatar">
                  <div style={{ position: 'relative', width: 44, height: 44 }}>
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {initials(selectedThread.display_title || selectedThread.other_display_name || selectedThread.title)}
                    </div>
                    {selectedThread.other_photo_url && (
                      <img
                        src={selectedThread.other_photo_url}
                        alt="avatar"
                        style={{ position: 'absolute', inset: 0, width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }}
                        onError={(e) => { e.currentTarget.remove(); }}
                      />
                    )}
                  </div>
                </div>
                <div>
                  <div className="header-title">{selectedThread.display_title || selectedThread.other_display_name || selectedThread.title || 'Conversation'}</div>
                </div>
              </div>
              <div className="header-actions">
                <i className="fa-solid fa-phone"></i>
                <i className="fa-solid fa-video"></i>
                <i className="fa-solid fa-ellipsis-v"></i>
              </div>
            </div>
            {/* Messages */}
            <div className="messages-area">
              {threadLoading && (
                <div style={{ padding: 16, opacity: 0.85, fontWeight: 700, color: '#64748b' }}>
                  Loading conversation…
                </div>
              )}
              {!!threadError && !threadLoading && (
                <div style={{ padding: 16, color: '#b91c1c', fontWeight: 700 }}>
                  {threadError}
                </div>
              )}
              {!threadLoading && messages.length === 0 && (
                <div style={{ padding: 16, opacity: 0.8 }}>
                  No messages yet.
                </div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={`message-row${msg.sender_role === 'carrier' ? ' sent' : ''}`}>
                  <div className="message-bubble">
                    {msg.title ? <div style={{ fontWeight: 800, marginBottom: 4 }}>{msg.title}</div> : null}
                    {msg.text}
                  </div>
                  <div className="message-meta">{fmtTime(msg.created_at)}</div>
                </div>
              ))}
            </div>
            {/* Message Input */}
            {selectedThread.kind === 'admin_channel' ? (
              <div className="message-input-area" style={{ justifyContent: 'center', opacity: 0.85 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#64748b' }}>Admin notifications are one-way.</div>
              </div>
            ) : (
              <div className="message-input-area">
                <input
                  className="message-input"
                  type="text"
                  placeholder="Type your message..."
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSend()}
                />
                <button className="send-btn" onClick={handleSend}>
                  <i className="fa-solid fa-paper-plane"></i>
                </button>
              </div>
            )}
          </main>
        )}

        {/* Empty state when nothing selected */}
        {(!selectedThread || (isMobile && showChatMobile && !selectedThread)) && !loading && (
          <main className="main-chat">
            <div className="messages-area">
              <div style={{ padding: 18, opacity: 0.85, fontWeight: 700, color: '#64748b' }}>
                Select a conversation to start.
              </div>
            </div>
          </main>
        )}
      </div>
    </>
  );
}
