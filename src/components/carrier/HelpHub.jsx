import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../../styles/carrier/HelpHub.css';
import {
  chatWithRoleAssistant,
  deleteRoleAssistantConversation,
  exportRoleAssistantConversation,
  getRoleAssistantConversation,
  listRoleAssistantConversations,
} from '../../api/roleAssistant';
import { downloadText } from '../../utils/fileDownload';

function normalizeMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isSameMessageApprox(a, b) {
  const roleA = String(a?.role || '').trim().toLowerCase();
  const roleB = String(b?.role || '').trim().toLowerCase();
  if (!roleA || roleA !== roleB) return false;

  const textA = normalizeMessageText(a?.content);
  const textB = normalizeMessageText(b?.content);
  if (!textA || textA !== textB) return false;

  const tsA = Number(a?.created_at || 0);
  const tsB = Number(b?.created_at || 0);
  if (!Number.isFinite(tsA) || !Number.isFinite(tsB) || tsA <= 0 || tsB <= 0) return true;
  return Math.abs(tsA - tsB) <= 15;
}

function mergeRemoteWithLocalPending(remoteMessages, currentMessages) {
  const remote = Array.isArray(remoteMessages) ? remoteMessages : [];
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const pendingLocal = current.filter((m) => String(m?.id || '').startsWith('local-'));
  if (pendingLocal.length === 0) return remote;
  const merged = [...remote];
  pendingLocal.forEach((m) => {
    const duplicateExists = remote.some((r) => isSameMessageApprox(r, m));
    if (!duplicateExists) {
      merged.push(m);
    }
  });
  merged.sort((a, b) => Number(a?.created_at || 0) - Number(b?.created_at || 0));
  const deduped = [];
  merged.forEach((m) => {
    const last = deduped[deduped.length - 1];
    if (last && isSameMessageApprox(last, m)) return;
    deduped.push(m);
  });
  return deduped;
}

const HelpHub = () => {
  const [activeTab, setActiveTab] = useState('ai-assistant');
  const [message, setMessage] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All Status');
  const [selectedCategory, setSelectedCategory] = useState('All Categories');
  const [selectedPriority, setSelectedPriority] = useState('All Priority');
  const [searchTickets, setSearchTickets] = useState('');
  const [searchResources, setSearchResources] = useState('');
  const [_calendarView, _setCalendarView] = useState('Monthly');
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState([
    {
      id: 'seed-assistant',
      role: 'assistant',
      content:
        "Hello! I'm your FreightPower AI assistant. I can help you with loads, compliance, documentation, and more. What can I help you with today?",
      created_at: Date.now() / 1000,
    },
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const chatEndRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const historyAbortRef = useRef(null);
  const listAbortRef = useRef(null);
  const sendAbortRef = useRef(null);
  const hasUserInteractedRef = useRef(false);
  const sendInFlightRef = useRef(false);

  // Sample data for tickets
  const tickets = [
    {
      id: 'BTK-2025-001',
      subject: 'Load payment delay issue',
      category: 'Finance',
      priority: 'Critical',
      status: 'In Progress',
      lastUpdated: 'Jan 15, 2025 2:30 PM'
    },
    {
      id: 'BTK-2025-002',
      subject: 'BOL upload not working',
      category: 'Loads',
      priority: 'High',
      status: 'Open',
      lastUpdated: 'Jan 14, 2025 10:15 AM'
    },
    {
      id: 'BTK-2025-003',
      subject: 'ELD integration setup help',
      category: 'Integrations',
      priority: 'Medium',
      status: 'Active',
      lastUpdated: 'Jan 12, 2025 4:45 PM'
    }
  ];

  // Quick Commands
  const quickCommands = [
    "How do I upload a BOL?",
    "Show me compliance steps",
    "Help with driver scheduling",
    "Invoice payment status",
    "Marketplace best practices"
  ];

  // Featured Resources
  const featuredResources = [
    {
      type: 'FAQ',
      title: 'How to upload a BOL?',
      description: 'Step-by-step guide for uploading bills of lading',
      icon: 'fa-regular fa-circle-question'
    },
    {
      type: 'Video • 3:30',
      title: 'Set up QuickBooks integration',
      description: 'Connect your accounting software in minutes',
      icon: 'fa-solid fa-play'
    },
    {
      type: 'Guide',
      title: 'Assign drivers to loads',
      description: 'Manage driver assignments efficiently',
      icon: 'fa-solid fa-book'
    }
  ];

  // FAQ Items
  const faqItems = [
    "How do I track my loads?",
    "What documents do I need for DOT compliance?",
    "How to set up factoring integration?"
  ];

  // Step-by-Step Guides
  const guides = [
    {
      title: 'Load Management Basics',
      description: 'Complete guide to managing loads from start to finish',
      action: 'View Guide'
    },
    {
      title: 'Driver Onboarding Process',
      description: 'How to properly onboard new drivers to your fleet',
      action: 'View Guide'
    }
  ];

  // Video Tutorials
  const videoTutorials = [
    {
      title: 'Dashboard Overview',
      duration: '2:15',
      thumbnail: ''
    },
    {
      title: 'Creating New Loads',
      duration: '3:45',
      thumbnail: ''
    },
    {
      title: 'Invoice Generation',
      duration: '2:30',
      thumbnail: ''
    }
  ];

  // Calendar data for support sessions
  const supportSessions = [
    {
      type: 'Platform Training',
      date: 'Jan 3, 2025 • 2:00 PM',
      agent: 'Sarah Davis',
      status: 'Confirmed'
    },
    {
      type: 'Technical Support',
      date: 'Jan 10, 2025 • 10:00 AM',
      agent: 'Mike Johnson',
      status: 'Pending'
    },
    {
      type: 'Compliance Review',
      date: 'Jan 15, 2025 • 3:30 PM',
      agent: 'Lisa Rodriguez',
      status: 'Scheduled'
    }
  ];

  const tabs = [
    { key: 'ai-assistant', label: 'AI Assistant', },
    { key: 'my-tickets', label: 'My Tickets', },
    { key: 'resources', label: 'Resources', },
    { key: 'schedule-support', label: 'Schedule Support', }
  ];

  const refreshConversations = useCallback(async () => {
    if (listAbortRef.current) {
      listAbortRef.current.abort();
    }
    const controller = new AbortController();
    listAbortRef.current = controller;
    try {
      const data = await listRoleAssistantConversations(20, { signal: controller.signal });
      return Array.isArray(data?.conversations) ? data.conversations : [];
    } catch (e) {
      if (e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('request cancelled')) {
        return [];
      }
      throw e;
    } finally {
      if (listAbortRef.current === controller) {
        listAbortRef.current = null;
      }
    }
  }, []);

  const loadConversation = async (id, options = {}) => {
    const cid = String(id || '').trim();
    if (!cid) return;
    const preserveLocal = Boolean(options?.preserveLocal);
    const skipIfUserInteracted = Boolean(options?.skipIfUserInteracted);
    if (historyAbortRef.current) {
      historyAbortRef.current.abort();
    }
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryLoading(true);
    try {
      const data = await getRoleAssistantConversation(cid, 200, { signal: controller.signal });
      if (skipIfUserInteracted && hasUserInteractedRef.current) {
        return;
      }
      const rows = Array.isArray(data?.messages) ? data.messages : [];
      setMessages((prev) => (preserveLocal ? mergeRemoteWithLocalPending(rows, prev) : rows));
      setConversationId(cid);
    } catch (e) {
      if (e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('request cancelled')) {
        return;
      }
      setChatError(e?.message || 'Failed to load conversation');
    } finally {
      if (historyAbortRef.current === controller) {
        historyAbortRef.current = null;
      }
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    hasUserInteractedRef.current = false;
    (async () => {
      try {
        const list = await refreshConversations();
        if (!alive || hasUserInteractedRef.current) return;
        const first = Array.isArray(list) ? list[0] : null;
        if (first?.conversation_id) {
          await loadConversation(first.conversation_id, { preserveLocal: true, skipIfUserInteracted: true });
        }
      } catch {
        // Keep seeded message.
      }
    })();
    return () => {
      alive = false;
      if (historyAbortRef.current) {
        historyAbortRef.current.abort();
        historyAbortRef.current = null;
      }
      if (listAbortRef.current) {
        listAbortRef.current.abort();
        listAbortRef.current = null;
      }
      if (sendAbortRef.current) {
        sendAbortRef.current.abort();
        sendAbortRef.current = null;
      }
    };
  }, [refreshConversations]);

  useEffect(() => {
    const node = chatMessagesRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'auto' });
  }, [messages.length, chatLoading, historyLoading]);

  const handleSendMessage = async (raw) => {
    const text = String(raw ?? message).trim();
    if (!text || chatLoading || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    hasUserInteractedRef.current = true;
    if (historyAbortRef.current) {
      historyAbortRef.current.abort();
      historyAbortRef.current = null;
    }
    if (listAbortRef.current) {
      listAbortRef.current.abort();
      listAbortRef.current = null;
    }
    if (sendAbortRef.current) {
      sendAbortRef.current.abort();
      sendAbortRef.current = null;
    }
    setChatError('');
    setChatLoading(true);
    setMessage('');

    setMessages((prev) => [
      ...prev,
      { id: `local-user-${Date.now()}`, role: 'user', content: text, created_at: Date.now() / 1000 },
    ]);

    try {
      const controller = new AbortController();
      sendAbortRef.current = controller;
      const response = await chatWithRoleAssistant({
        message: text,
        conversation_id: conversationId || undefined,
        include_history: true,
        max_history_messages: 30,
        auto_tool_inference: true,
      }, { signal: controller.signal });
      if (sendAbortRef.current === controller) {
        sendAbortRef.current = null;
      }
      const cid = String(response?.conversation_id || '').trim();
      const assistantMessageId = String(response?.message_id || '').trim();
      const assistantMessage = {
        id: assistantMessageId || `local-assistant-${Date.now()}`,
        role: 'assistant',
        content: String(response?.reply || ''),
        created_at: Number(response?.created_at || Date.now() / 1000),
        metadata: {},
      };
      if (cid) {
        setConversationId(cid);
        setMessages((prev) => [...prev, assistantMessage]);
      } else {
        setMessages((prev) => [...prev, assistantMessage]);
      }
    } catch (e) {
      if (e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('request cancelled')) {
        return;
      }
      setChatError(e?.message || 'Failed to send message');
    } finally {
      if (sendAbortRef.current) {
        sendAbortRef.current = null;
      }
      setChatLoading(false);
      sendInFlightRef.current = false;
    }
  };

  const handleQuickCommand = (command) => {
    setMessage(command);
    handleSendMessage(command);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleExportConversation = async () => {
    const cid = String(conversationId || '').trim();
    if (!cid || exportBusy) return;
    setExportBusy(true);
    setChatError('');
    try {
      const out = await exportRoleAssistantConversation(cid, { format: 'markdown', limit: 2000 });
      downloadText(`carrier_aihub_${cid}.md`, String(out || ''), 'text/markdown;charset=utf-8');
    } catch (e) {
      setChatError(e?.message || 'Failed to export conversation');
    } finally {
      setExportBusy(false);
    }
  };

  const handleDeleteConversation = async () => {
    const cid = String(conversationId || '').trim();
    if (!cid || deleteBusy || chatLoading) return;
    const ok = window.confirm('Delete this conversation? This cannot be undone.');
    if (!ok) return;

    setDeleteBusy(true);
    setChatError('');
    try {
      if (historyAbortRef.current) {
        historyAbortRef.current.abort();
        historyAbortRef.current = null;
      }
      if (listAbortRef.current) {
        listAbortRef.current.abort();
        listAbortRef.current = null;
      }
      if (sendAbortRef.current) {
        sendAbortRef.current.abort();
        sendAbortRef.current = null;
      }
      await deleteRoleAssistantConversation(cid);
      setConversationId('');
      setMessages([
        {
          id: 'seed-assistant',
          role: 'assistant',
          content:
            "Hello! I'm your FreightPower AI assistant. I can help you with loads, compliance, documentation, and more. What can I help you with today?",
          created_at: Date.now() / 1000,
          metadata: {},
        },
      ]);
    } catch (e) {
      setChatError(e?.message || 'Failed to delete conversation');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="help-hub-container">
      <header className="help-hub-header">
        <div className="help-hub-title-section">
          <h1>Help Hub</h1>
          <p>Get instant support through AI assistance, submit tickets, or access training resources</p>
        </div>
      </header>

      <div className="tabs" style={{ marginBottom: "20px" }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <i className={tab.icon}></i>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="help-hub-content">
        {/* AI Assistant Tab */}
        {activeTab === 'ai-assistant' && (
          <div className="tab-panel">
            <div className="ai-assistant-layout">
              <div className="chat-section">
                <div className="ai-header">
                  <div className="ai-avatar">
                    <i className="fa-solid fa-robot"></i>
                  </div>
                  <div className="ai-info">
                    <h3>FreightPower AI Assistant</h3>
                    <div className="ai-status">
                      <div className="status-indicator online"></div>
                      <span>Online • Ready to help</span>
                    </div>
                  </div>
                  <div className="ai-header-actions">
                    <button
                      type="button"
                      className="quick-command-btn compact"
                      onClick={handleExportConversation}
                      disabled={!conversationId || exportBusy}
                    >
                      {exportBusy ? 'Exporting...' : 'Export'}
                    </button>
                    <button
                      type="button"
                      className="quick-command-btn compact danger"
                      onClick={handleDeleteConversation}
                      disabled={!conversationId || deleteBusy || chatLoading}
                    >
                      {deleteBusy ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>

                <div className="chat-messages" ref={chatMessagesRef}>
                  {messages.map((m) => (
                    <div key={m.id} className={`message ${m.role === 'user' ? 'user-message' : 'ai-message'}`}>
                      <div className="message-avatar">
                        <i className={`fa-solid ${m.role === 'user' ? 'fa-user' : 'fa-robot'}`}></i>
                      </div>
                      <div className="message-content">
                        <p>{m.content}</p>
                      </div>
                    </div>
                  ))}
                  {historyLoading && (
                    <div className="message ai-message">
                      <div className="message-avatar">
                        <i className="fa-solid fa-robot"></i>
                      </div>
                      <div className="message-content">
                        <p>Loading conversation...</p>
                      </div>
                    </div>
                  )}
                  {chatLoading && (
                    <div className="message ai-message">
                      <div className="message-avatar">
                        <i className="fa-solid fa-robot"></i>
                      </div>
                      <div className="message-content">
                        <p>Thinking...</p>
                      </div>
                    </div>
                  )}
                  {chatError && (
                    <div className="message ai-message">
                      <div className="message-avatar">
                        <i className="fa-solid fa-triangle-exclamation"></i>
                      </div>
                      <div className="message-content">
                        <p>{chatError}</p>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                <div className="chat-input-container">
                  <div className="chat-input">
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyPress={handleKeyPress}
                      placeholder="Type your message..."
                      rows="1"
                      disabled={chatLoading}
                    />
                    <div className="input-actions">
                      <button className="attach-btn">
                        <i className="fa-solid fa-microphone"></i>
                      </button>
                      <button 
                        className="send-btn"
                        onClick={() => handleSendMessage()}
                        disabled={!message.trim() || chatLoading}
                      >
                        <i className="fa-solid fa-paper-plane"></i>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="quick-commands-section">
                <h3>Quick Commands</h3>
                <div className="quick-commands">
                  {quickCommands.map((command, index) => (
                    <button
                      key={index}
                      className="quick-command-btn"
                      onClick={() => handleQuickCommand(command)}
                    >
                      "{command}"
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* My Tickets Tab */}
        {activeTab === 'my-tickets' && (
          <div className="tab-panel">
            <div className="tickets-section">
              <div className="tickets-filters">
                <div className="hh-search-box">
                  <input
                    type="text"
                    placeholder="Search tickets..."
                    value={searchTickets}
                    onChange={(e) => setSearchTickets(e.target.value)}
                  />
                </div>
                <select 
                  value={selectedStatus} 
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="hh-filter-select"
                >
                  <option>All Status</option>
                  <option>Open</option>
                  <option>In Progress</option>
                  <option>Resolved</option>
                  <option>Closed</option>
                </select>
                <select 
                  value={selectedCategory} 
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="hh-filter-select"
                >
                  <option>All Categories</option>
                  <option>Finance</option>
                  <option>Loads</option>
                  <option>Integrations</option>
                  <option>Compliance</option>
                </select>
                <select 
                  value={selectedPriority} 
                  onChange={(e) => setSelectedPriority(e.target.value)}
                  className="hh-filter-select"
                >
                  <option>All Priority</option>
                  <option>Critical</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                </select>
                <input type="date" className="date-filter" />
              </div>

              <div className="tickets-table-container">
                <table className="tickets-table">
                  <thead>
                    <tr>
                      <th>TICKET ID</th>
                      <th>SUBJECT</th>
                      <th>CATEGORY</th>
                      <th>PRIORITY</th>
                      <th>STATUS</th>
                      <th>LAST UPDATED</th>
                      <th>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map(ticket => (
                      <tr key={ticket.id}>
                        <td><code>{ticket.id}</code></td>
                        <td>{ticket.subject}</td>
                        <td><span className="category-badge">{ticket.category}</span></td>
                        <td>
                          <span className={`priority-badge ${ticket.priority.toLowerCase()}`}>
                            {ticket.priority}
                          </span>
                        </td>
                        <td>
                          <span className={`int-status-badge ${ticket.status.toLowerCase().replace(' ', '-')}`}>
                            {ticket.status}
                          </span>
                        </td>
                        <td>{ticket.lastUpdated}</td>
                        <td>
                          <div className="ticket-actions">
                            <button className="action-btn view">View</button>
                            <button className="action-btn reply">Reply</button>
                            <button className="action-btn close">Close</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <div className="pagination-info">Showing 1 to 3 of 12 tickets</div>
                <div className="pagination-controls">
                  <button className="pagination-btn">Pre</button>
                  <button className="pagination-btn active">1</button>
                  <button className="pagination-btn">2</button>
                  <button className="pagination-btn">Next</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Resources Tab */}
        {activeTab === 'resources' && (
          <div className="tab-panel">
            <div className="resources-section">
              <div className="resources-search">
                <div className="hh-search-box">
                  <input
                    type="text"
                    placeholder="Search FAQs, Guides, or Videos"
                    value={searchResources}
                    onChange={(e) => setSearchResources(e.target.value)}
                  />
                </div>
                <select className="category-filter">
                  <option>All Categories</option>
                  <option>Getting Started</option>
                  <option>Load Management</option>
                  <option>Compliance</option>
                  <option>Integrations</option>
                </select>
              </div>

              <div className="featured-resources">
                <h3>Featured Resources</h3>
                <div className="resources-grid">
                  {featuredResources.map((resource, index) => (
                    <div key={index} className="resource-card">
                      <div className="resource-icon">
                        <i className={resource.icon}></i>
                      </div>
                      <div className="resource-content">
                        <div className="resource-type">{resource.type}</div>
                        <h4>{resource.title}</h4>
                        <p>{resource.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="faq-section">
                <div className="section-header">
                  <h3>
                    Frequently Asked Questions
                  </h3>
                  <button className="expand-btn">
                    <i className="fa-solid fa-chevron-down"></i>
                  </button>
                </div>
                <div className="faq-list">
                  {faqItems.map((question, index) => (
                    <div key={index} className="faq-item">
                      <span>{question}</span>
                      <button className="expand-faq">
                        <i className="fa-solid fa-plus"></i>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="guides-section">
                <div className="section-header">
                  <h3>
                    Step-by-Step Guides
                  </h3>
                  <button className="expand-btn">
                    <i className="fa-solid fa-chevron-down"></i>
                  </button>
                </div>
                <div className="guides-list">
                  {guides.map((guide, index) => (
                    <div key={index} className="guide-item">
                      <div className="guide-content">
                        <h4>{guide.title}</h4>
                        <p>{guide.description}</p>
                      </div>
                      <button className="btn small-cd">{guide.action}</button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="videos-section">
                <div className="section-header">
                  <h3>
                    Video Tutorials
                  </h3>
                  <button className="expand-btn">
                    <i className="fa-solid fa-chevron-down"></i>
                  </button>
                </div>
                <div className="videos-grid">
                  {videoTutorials.map((video, index) => (
                    <div key={index} className="video-card">
                      <div className="video-thumbnail">
                        <div className="play-button">
                          <i className="fa-solid fa-play"></i>
                        </div>
                        <div className="video-duration">{video.duration}</div>
                      </div>
                      <div className="video-info">
                        <h4>{video.title}</h4>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Schedule Support Tab */}
        {activeTab === 'schedule-support' && (
          <div className="tab-panel">
            <div className="schedule-support-section">
              <div className="schedule-header">
                <div className="schedule-actions">
                  <button className="btn small ghost-cd">
                    <i className="fa-solid fa-download"></i>
                    Export
                  </button>
                  <button className="btn small ghost-cd">View Upcoming</button>
                  <button className="btn small-cd">Book New Session</button>
                </div>
              </div>

              <div className="schedule-layout">
                <div className="calendar-section">
                  <div className="calendar-header">
                    <h3>Calendar View</h3>
                  </div>

                  <div className="calendar-grid">
                    <div className="calendar-weekdays">
                      <div className="weekday">Sun</div>
                      <div className="weekday">Mon</div>
                      <div className="weekday">Tue</div>
                      <div className="weekday">Wed</div>
                      <div className="weekday">Thu</div>
                      <div className="weekday">Fri</div>
                      <div className="weekday">Sat</div>
                    </div>
                    <div className="calendar-days">
                      {/* Previous month days */}
                      <div className="day prev-month">30</div>
                      <div className="day prev-month">31</div>
                      
                      {/* Current month days */}
                      {Array.from({ length: 31 }, (_, i) => (
                        <div key={i + 1} className={`day ${i + 1 === 3 ? 'has-event' : ''} ${i + 1 === 15 ? 'has-video' : ''}`}>
                          <span className="day-number">{i + 1}</span>
                          {i + 1 === 3 && <div className="event-indicator training">Training</div>}
                          {i + 1 === 15 && <div className="event-indicator video">Video</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="sessions-sidebar">
                  <h3>Upcoming Sessions</h3>
                  <div className="sessions-list">
                    {supportSessions.map((session, index) => (
                      <div key={index} className="session-item">
                        <div className="session-icon">
                          <i className={
                            session.type === 'Platform Training' ? 'fa-solid fa-chalkboard-teacher' :
                            session.type === 'Technical Support' ? 'fa-solid fa-wrench' :
                            'fa-solid fa-clipboard-check'
                          }></i>
                        </div>
                        <div className="session-content">
                          <div className="session-type">{session.type}</div>
                          <div className="session-date">{session.date}</div>
                          <div className="session-agent">Agent: {session.agent}</div>
                          <div className={`int-status-badge ${session.status.toLowerCase()}`}>
                            {session.status}
                          </div>
                        </div>
                        <div className="session-actions">
                          <button className="action-icon edit">
                            <i className="fa-solid fa-edit"></i>
                          </button>
                          <button className="action-icon cancel">
                            <i className="fa-solid fa-times"></i>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="quick-actions">
                    <h4>Quick Actions</h4>
                    <button className="btn small ghost-cd" style={{width: '100%', marginBottom: '12px'}}>View All Sessions</button>
                    <button className="btn small ghost-cd" style={{width: '100%', marginBottom: '12px'}}>
                      <i className="fa-solid fa-phone"></i>
                      Schedule Call
                    </button>
                    <button className="btn small ghost-cd" style={{width: '100%', marginBottom: '12px'}}>
                      <i className="fa-solid fa-video"></i>
                      Video Session
                    </button>
                    <button className="btn small ghost-cd " style={{width: '100%', marginBottom: '12px'}}>
                      <i className="fa-solid fa-chalkboard-teacher"></i>
                      Training Session
                    </button>
                    <button className="btn small ghost-cd" style={{width: '100%'}}>
                      <i className="fa-solid fa-desktop"></i>
                      Screen Share
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default HelpHub;
