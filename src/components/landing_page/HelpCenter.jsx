import { useEffect, useMemo, useState } from 'react';
import supportIcon from '../../assets/support.svg';
import searchIcon from '../../assets/search.svg';
import chatIcon from '../../assets/chat.svg';
import ticketIcon from '../../assets/ticket.svg';
import faqIcon from '../../assets/faq.svg';
import videoIcon from '../../assets/video.svg';
import docIcon from '../../assets/doc.svg';
import botIcon from '../../assets/bot.svg';
import '../../styles/landing_page/HelpCenter.css';

import { LANGUAGE_OPTIONS, t } from '../../i18n/translate';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  askHelpCenterAi,
  getHelpCenterContent,
  getPopularHelpCenter,
  listFaqItems,
  listHelpCenterHistory,
  listMySupportTickets,
  recordHelpCenterInteraction,
  searchHelpCenter,
} from '../../api/helpCenter';
import { postJson } from '../../api/http';

export default function HelpCenter() {
  const [searchQuery, setSearchQuery] = useState('');

  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  const [selected, setSelected] = useState(null); // {id,title,kind,content}
  const [contentBusy, setContentBusy] = useState(false);

  const [popularArticles, setPopularArticles] = useState([]);
  const [popularFaqs, setPopularFaqs] = useState([]);

  const [faqBusy, setFaqBusy] = useState(false);
  const [faqQuery, setFaqQuery] = useState('');
  const [faqIndex, setFaqIndex] = useState({}); // { [faqItemId]: {question, answer, doc_id, doc_title} }

  const [ticketsBusy, setTicketsBusy] = useState(false);
  const [tickets, setTickets] = useState([]);

  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyItems, setHistoryItems] = useState([]);

  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiMessages, setAiMessages] = useState([]); // [{role:'user'|'assistant', text}]

  const [ticketForm, setTicketForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketOk, setTicketOk] = useState('');
  const [ticketErr, setTicketErr] = useState('');

  const { settings, patchSettings } = useUserSettings();
  const { currentUser } = useAuth();

  const tr = useMemo(() => {
    const lang = settings?.language;
    return (key, fallback) => t(lang, key, fallback);
  }, [settings?.language]);

  const userInitial = useMemo(() => {
    const email = (currentUser?.email || '').trim();
    const name = (currentUser?.displayName || '').trim();
    const base = name || email || 'U';
    return String(base[0] || 'U').toUpperCase();
  }, [currentUser?.email, currentUser?.displayName]);

  // Scroll to top when component mounts
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setFaqBusy(true);
      try {
        const [a, f, faq] = await Promise.all([
          getPopularHelpCenter('article', 6),
          getPopularHelpCenter('faq', 6),
          listFaqItems(),
        ]);
        if (cancelled) return;
        setPopularArticles(a?.items || []);
        setPopularFaqs(f?.items || []);

        const map = {};
        for (const it of (faq?.items || [])) {
          if (it?.id) map[it.id] = it;
        }
        setFaqIndex(map);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setFaqBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const ensureFaqIndex = async () => {
    if (Object.keys(faqIndex || {}).length > 0) return faqIndex;
    try {
      const faq = await listFaqItems();
      const map = {};
      for (const it of (faq?.items || [])) {
        if (it?.id) map[it.id] = it;
      }
      setFaqIndex(map);
      return map;
    } catch {
      return faqIndex || {};
    }
  };

  const filteredFaqItems = useMemo(() => {
    const q = (faqQuery || '').trim().toLowerCase();
    const items = Object.values(faqIndex || {}).filter((it) => it && it.id && it.question);
    if (!q) return items.slice(0, 12);
    return items
      .filter((it) => {
        const hay = `${it.question || ''} ${it.answer || ''}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 12);
  }, [faqIndex, faqQuery]);

  const runSearch = async (e) => {
    e?.preventDefault?.();
    setSearchError('');
    setSelected(null);

    const q = (searchQuery || '').trim();
    if (!q) {
      setSearchResults([]);
      return;
    }

    setSearchBusy(true);
    try {
      const res = await searchHelpCenter({ q, k: 12, kind: 'all' });
      setSearchResults(res?.results || []);
    } catch (err) {
      setSearchError(err?.message || tr('helpCenter.errors.searchFailed', 'Search failed. Please try again.'));
    } finally {
      setSearchBusy(false);
    }
  };

  const openContent = async ({ id, title, kind, fromQuery } = {}) => {
    if (!id) return;
    setSearchError('');
    setContentBusy(true);
    try {
      if (fromQuery) {
        await recordHelpCenterInteraction({
          type: 'search_click',
          query: fromQuery,
          content_id: id,
          content_title: title || '',
          content_kind: kind || '',
        }).catch(() => {});
      }
      const doc = await getHelpCenterContent(id);
      setSelected(doc);
      await recordHelpCenterInteraction({
        type: 'view_content',
        content_id: doc?.id || id,
        content_title: doc?.title || title || '',
        content_kind: doc?.kind || kind || '',
      }).catch(() => {});
    } catch (err) {
      setSearchError(err?.message || tr('helpCenter.errors.loadFailed', 'Failed to load content.'));
    } finally {
      setContentBusy(false);
    }
  };

  const openFaqItemById = async ({ id, fromQuery } = {}) => {
    if (!id) return;
    setSearchError('');
    setSelected(null);
    const map = await ensureFaqIndex();
    const it = map?.[id];
    if (!it) {
      setSearchError(tr('helpCenter.errors.loadFailed', 'Failed to load content.'));
      return;
    }

    const question = String(it.question || '').trim() || String(it.doc_title || '').trim() || id;
    const answer = String(it.answer || '').trim();

    await recordHelpCenterInteraction({
      type: fromQuery ? 'search_click' : 'click',
      query: fromQuery || undefined,
      content_id: id,
      content_title: question,
      content_kind: 'faq',
      metadata: { doc_id: it.doc_id || '' },
    }).catch(() => {});

    setSelected({ id, title: question, kind: 'faq', content: answer });

    await recordHelpCenterInteraction({
      type: 'view_content',
      content_id: id,
      content_title: question,
      content_kind: 'faq',
      metadata: { doc_id: it.doc_id || '' },
    }).catch(() => {});
  };

  const loadTickets = async () => {
    setTicketsBusy(true);
    try {
      const items = await listMySupportTickets(50);
      setTickets(items || []);
    } catch {
      setTickets([]);
    } finally {
      setTicketsBusy(false);
    }
  };

  const loadHistory = async () => {
    setHistoryBusy(true);
    try {
      const res = await listHelpCenterHistory({ q: historyQuery, limit: 50 });
      setHistoryItems(res?.items || []);
    } catch {
      setHistoryItems([]);
    } finally {
      setHistoryBusy(false);
    }
  };

  const submitTicket = async () => {
    setTicketOk('');
    setTicketErr('');
    const name = (ticketForm.name || '').trim();
    const email = (ticketForm.email || '').trim();
    const subject = (ticketForm.subject || '').trim();
    const message = (ticketForm.message || '').trim();
    if (!name || !email || !subject || !message) {
      setTicketErr(tr('helpCenter.ticket.missing', 'Please fill out all fields.'));
      return;
    }

    setTicketBusy(true);
    try {
      await postJson('/support/submit', { name, email, subject, message }, { requestLabel: 'POST /support/submit', timeoutMs: 25000 });
      await recordHelpCenterInteraction({
        type: 'ticket_submit',
        content_kind: 'ticket',
        content_title: subject,
        metadata: { email },
      }).catch(() => {});
      setTicketOk(tr('helpCenter.ticket.sent', 'Ticket submitted. Our support team will review it.'));
      setTicketForm({ name, email, subject: '', message: '' });
      await loadTickets();
    } catch (err) {
      setTicketErr(err?.message || tr('helpCenter.ticket.failed', 'Failed to submit ticket. Please try again.'));
    } finally {
      setTicketBusy(false);
    }
  };

  const sendAi = async () => {
    const msg = (aiInput || '').trim();
    if (!msg || aiBusy) return;
    setAiBusy(true);
    setAiMessages((m) => [...m, { role: 'user', text: msg }]);
    setAiInput('');
    try {
      const res = await askHelpCenterAi(msg);
      setAiMessages((m) => [...m, { role: 'assistant', text: res?.answer || '' }]);
    } catch (err) {
      setAiMessages((m) => [...m, { role: 'assistant', text: err?.message || tr('helpCenter.ai.failed', 'AI assistant is unavailable right now. Try searching for an article.') }]);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="help-center-page">
      
      {/* Top Header Bar */}
      <div className="help-center-top-bar">
        <div className="help-center-top-container">
          <div className="support-center-brand">
            <button 
              className="support-center-icon-button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              aria-label="Scroll to top"
            >
              <div className="support-center-icon">
                <img src={supportIcon} alt="Support" width="15" height="15" />
              </div>
              <span className="support-center-title">{tr('helpCenter.brand', 'Support Center')}</span>
            </button>
          </div>
          
          <div className="help-center-user-section">
            <div className="help-center-language">
              <label className="help-center-language-label">{tr('settings.language', 'Language')}</label>
              <select
                className="help-center-language-select"
                value={settings?.language || 'English'}
                onChange={(e) => patchSettings({ language: e.target.value }, { requestLabel: 'PATCH /auth/settings (help center language)' })}
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="help-center-notifications" onClick={loadHistory} title={tr('helpCenter.recentActivity', 'Recent activity')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" fill="#6b7280"/>
              </svg>
            </div>
            
            <div className="help-center-user-avatar">
              <div className="user-avatar-circle">
                <span>{userInitial}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div className="help-center-container">
        {/* Header Section */}
        <div className="help-center-header">
          <h1 className="help-center-title">{tr('helpCenter.title', 'How can we help you?')}</h1>
          <p className="help-center-subtitle">
            {tr('helpCenter.subtitle', 'Search help articles and FAQs, submit tickets, and track your support history.')}
          </p>
          
          {/* Search Bar */}
          <form onSubmit={runSearch} className="help-search-form">
            <div className="help-search-container">
              <div className="search-icon">
                <img src={searchIcon} alt="Search" width="20" height="20" />
              </div>
              <input
                type="text"
                placeholder={tr('helpCenter.searchPlaceholder', 'Search for help articles, guides, or FAQs...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="help-search-input"
              />
            </div>

            <div className="help-search-actions">
              <button type="submit" className="support-option-button primary" disabled={searchBusy}>
                {searchBusy ? tr('accountSettings.common.working', 'Working...') : tr('helpCenter.search', 'Search')}
              </button>
              {(searchResults || []).length > 0 && (
                <button
                  type="button"
                  className="support-option-button secondary"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchResults([]);
                    setSelected(null);
                    setSearchError('');
                  }}
                >
                  {tr('helpCenter.clear', 'Clear')}
                </button>
              )}
            </div>
          </form>

          {searchError && <div className="help-center-inline-error">{searchError}</div>}
        </div>

        {/* Support Options */}
        <div className="support-options">
          <div className="support-option fp-disabled-card" aria-disabled="true">
            <div className="fp-coming-soon-pill">{tr('accountSettings.common.comingSoon', 'Coming Soon')}</div>
            <div className="support-option-icon chat">
              <img src={chatIcon} alt="Chat" width="24" height="24" />
            </div>
            <h3 className="support-option-title">{tr('helpCenter.liveChat.title', 'Live Chat')}</h3>
            <p className="support-option-description">
              {tr('helpCenter.liveChat.desc', 'Chat with support is not yet available in the app.')}
            </p>
            <button className="support-option-button primary" disabled>{tr('helpCenter.liveChat.button', 'Start Chat')}</button>
          </div>

          <div className="support-option">
            <div className="support-option-icon ticket">
              <img src={ticketIcon} alt="Ticket" width="24" height="24" />
            </div>
            <h3 className="support-option-title">{tr('helpCenter.ticket.title', 'Submit a Ticket')}</h3>
            <p className="support-option-description">
              {tr('helpCenter.ticket.desc', 'Create a support ticket for detailed assistance')}
            </p>
            <button
              className="support-option-button secondary"
              onClick={() => document.getElementById('fp-ticket-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              {tr('helpCenter.ticket.button', 'Create Ticket')}
            </button>
          </div>

          <div className="support-option">
            <div className="support-option-icon phone">
              <img src={docIcon} alt="Tickets" width="24" height="24" />
            </div>
            <h3 className="support-option-title">{tr('helpCenter.myTickets.title', 'My Tickets')}</h3>
            <p className="support-option-description">
              {tr('helpCenter.myTickets.desc', 'View ticket status and your recent support requests')}
            </p>
            <button className="support-option-button tertiary" onClick={loadTickets}>
              {tr('helpCenter.myTickets.button', 'View Tickets')}
            </button>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="help-content-grid">
          {/* Left Column */}
          <div className="help-left-column">
            {/* Help Center and Popular Articles Combined Section */}
            <div className="help-center-combined-section">
              {/* Help Center */}
              <div className="help-center-content">
                <h2 className="help-center-section-title">{tr('helpCenter.sections.helpCenter', 'Help Center')}</h2>
                
                <div className="help-center-cards">
                  <div className="help-center-card">
                    <div className="help-center-card-icon faq-icon">
                      <img src={faqIcon} alt="FAQ" width="24" height="24" />
                    </div>
                    <div className="help-center-card-content">
                      <h3 className="help-center-card-title">{tr('helpCenter.faq.title', 'Frequently Asked Questions')}</h3>
                      <p className="help-center-card-description">{tr('helpCenter.faq.desc', 'Find quick answers to common questions')}</p>
                    </div>
                  </div>

                  <div className="help-center-card">
                    <div className="help-center-card-icon video-icon">
                      <img src={videoIcon} alt="Video" width="24" height="24" />
                    </div>
                    <div className="help-center-card-content">
                      <h3 className="help-center-card-title">{tr('helpCenter.tutorials.title', 'Video Tutorials')}</h3>
                      <p className="help-center-card-description">{tr('accountSettings.common.comingSoon', 'Coming Soon')}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Popular Articles */}
              <div className="popular-articles-content">
                <h2 className="popular-articles-title">{tr('helpCenter.sections.popularArticles', 'Popular Articles')}</h2>
                
                <div className="popular-articles-list">
                  {(popularArticles || []).slice(0, 6).map((a) => (
                    <div
                      key={a.id}
                      className="popular-article-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => openContent({ id: a.id, title: a.title, kind: 'article' })}
                      onKeyDown={(e) => { if (e.key === 'Enter') openContent({ id: a.id, title: a.title, kind: 'article' }); }}
                    >
                      <div className="article-icon">
                        <img src={docIcon} alt="Document" width="16" height="16" />
                      </div>
                      <span className="article-title">{a.title || a.id}</span>
                      <div className="article-arrow">›</div>
                    </div>
                  ))}
                </div>

                {(searchResults || []).length > 0 && (
                  <div className="fp-search-results">
                    <div className="fp-search-results-title">{tr('helpCenter.searchResults', 'Search results')}</div>
                    {(searchResults || []).map((r) => (
                      <div
                        key={r.id}
                        className="fp-search-result"
                        role="button"
                        tabIndex={0}
                        onClick={() => openContent({ id: r.id, title: r.title, kind: r.kind, fromQuery: (searchQuery || '').trim() })}
                        onKeyDown={(e) => { if (e.key === 'Enter') openContent({ id: r.id, title: r.title, kind: r.kind, fromQuery: (searchQuery || '').trim() }); }}
                      >
                        <div className="fp-search-result-top">
                          <div className="fp-search-result-title">{r.title}</div>
                          <div className="fp-search-result-kind">{r.kind === 'faq' ? 'FAQ' : tr('helpCenter.article', 'Article')}</div>
                        </div>
                        <div className="fp-search-result-excerpt">{r.excerpt}</div>
                      </div>
                    ))}
                  </div>
                )}

                {selected && (
                  <div className="fp-content-panel">
                    <div className="fp-content-panel-header">
                      <button className="support-option-button secondary" onClick={() => setSelected(null)}>
                        {tr('helpCenter.back', 'Back')}
                      </button>
                      <div className="fp-content-panel-title">{selected?.title || ''}</div>
                    </div>
                    <div className="fp-content-panel-body">
                      {contentBusy ? tr('accountSettings.common.working', 'Working...') : (selected?.content || '')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="help-right-column">
            <div className="immediate-help-card">
              <h3 className="immediate-help-card-title">{tr('helpCenter.ai.title', 'AI Assistant')}</h3>
              <p className="immediate-help-card-description">
                {tr('helpCenter.ai.desc', 'Ask questions and get answers based on Help Center articles.')}
              </p>
              <button className="immediate-help-card-button" onClick={() => setAiOpen((v) => !v)}>
                <img src={botIcon} alt="AI Bot" width="16" height="16" />
                {aiOpen ? tr('helpCenter.ai.hide', 'Hide') : tr('helpCenter.ai.ask', 'Ask AI Assistant')}
              </button>

              {aiOpen && (
                <div className="fp-ai-panel">
                  <div className="fp-ai-messages">
                    {(aiMessages || []).length === 0 ? (
                      <div className="help-center-inline-muted">{tr('helpCenter.ai.hint', 'Try: “Why is marketplace blocked?” or “How do I upload a document?”')}</div>
                    ) : (
                      (aiMessages || []).map((m, idx) => (
                        <div key={idx} className={m.role === 'user' ? 'fp-ai-msg user' : 'fp-ai-msg assistant'}>
                          {m.text}
                        </div>
                      ))
                    )}
                  </div>
                  <div className="fp-ai-input-row">
                    <input
                      className="fp-ai-input"
                      value={aiInput}
                      onChange={(e) => setAiInput(e.target.value)}
                      placeholder={tr('helpCenter.ai.placeholder', 'Ask a question...')}
                      onKeyDown={(e) => { if (e.key === 'Enter') sendAi(); }}
                      disabled={aiBusy}
                    />
                    <button className="support-option-button primary" onClick={sendAi} disabled={aiBusy}>
                      {aiBusy ? tr('accountSettings.common.working', 'Working...') : tr('helpCenter.ai.send', 'Send')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="contact-info-card">
              <h3 className="contact-info-title">{tr('helpCenter.sections.popularFaqs', 'Popular FAQs')}</h3>
              <div className="popular-articles-list">
                {(popularFaqs || []).slice(0, 6).map((f) => (
                  <div
                    key={f.id}
                    className="popular-article-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (String(f.id || '').includes('::q')) return openFaqItemById({ id: f.id });
                      return openContent({ id: f.id, title: f.title, kind: 'faq' });
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      if (String(f.id || '').includes('::q')) return openFaqItemById({ id: f.id });
                      return openContent({ id: f.id, title: f.title, kind: 'faq' });
                    }}
                  >
                    <div className="article-icon">
                      <img src={docIcon} alt="Document" width="16" height="16" />
                    </div>
                    <span className="article-title">{f.title || faqIndex?.[f.id]?.question || f.id}</span>
                    <div className="article-arrow">›</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="contact-info-card">
              <h3 className="contact-info-title">{tr('helpCenter.faq.title', 'Frequently Asked Questions')}</h3>

              <div className="fp-faq-search-row">
                <input
                  className="fp-ai-input"
                  value={faqQuery}
                  onChange={(e) => setFaqQuery(e.target.value)}
                  placeholder={tr('helpCenter.faq.searchPlaceholder', 'Search FAQs...')}
                />
                <button type="button" className="support-option-button primary" disabled={faqBusy}>
                  {faqBusy ? tr('accountSettings.common.working', 'Working...') : tr('helpCenter.search', 'Search')}
                </button>
              </div>

              {faqBusy ? (
                <div className="help-center-inline-muted">{tr('accountSettings.common.working', 'Working...')}</div>
              ) : filteredFaqItems.length === 0 ? (
                <div className="help-center-inline-muted">{tr('helpCenter.faq.empty', 'No FAQs found.')}</div>
              ) : (
                <div className="fp-faq-list">
                  {filteredFaqItems.map((it) => (
                    <div
                      key={it.id}
                      className="fp-faq-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => openFaqItemById({ id: it.id })}
                      onKeyDown={(e) => { if (e.key === 'Enter') openFaqItemById({ id: it.id }); }}
                      title={it.doc_title || ''}
                    >
                      <div className="fp-faq-q">{it.question}</div>
                      {it.doc_title && <div className="fp-faq-meta">{it.doc_title}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="support-hours-card" id="fp-ticket-form">
              <h3 className="support-hours-title">{tr('helpCenter.ticket.formTitle', 'Submit a Ticket')}</h3>

              <div className="fp-form-grid">
                <div className="fp-field">
                  <label className="fp-label">{tr('common.name', 'Name')}</label>
                  <input value={ticketForm.name} onChange={(e) => setTicketForm((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div className="fp-field">
                  <label className="fp-label">{tr('common.email', 'Email')}</label>
                  <input value={ticketForm.email} onChange={(e) => setTicketForm((p) => ({ ...p, email: e.target.value }))} />
                </div>
                <div className="fp-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="fp-label">{tr('common.subject', 'Subject')}</label>
                  <input value={ticketForm.subject} onChange={(e) => setTicketForm((p) => ({ ...p, subject: e.target.value }))} />
                </div>
                <div className="fp-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="fp-label">{tr('common.message', 'Message')}</label>
                  <textarea rows={4} value={ticketForm.message} onChange={(e) => setTicketForm((p) => ({ ...p, message: e.target.value }))} />
                </div>
              </div>

              {ticketErr && <div className="help-center-inline-error">{ticketErr}</div>}
              {ticketOk && <div className="help-center-inline-ok">{ticketOk}</div>}

              <button className="support-option-button secondary" onClick={submitTicket} disabled={ticketBusy}>
                {ticketBusy ? tr('common.sending', 'Sending…') : tr('common.sendRequest', 'Send Request')}
              </button>

              <div className="fp-divider" />

              <div className="fp-tickets-header">
                <div className="fp-tickets-title">{tr('helpCenter.myTickets.title', 'My Tickets')}</div>
                <button className="support-option-button primary" onClick={loadTickets} disabled={ticketsBusy}>
                  {ticketsBusy ? tr('accountSettings.common.working', 'Working...') : tr('common.refresh', 'Refresh')}
                </button>
              </div>

              {(tickets || []).length === 0 ? (
                <div className="help-center-inline-muted">{tr('helpCenter.myTickets.empty', 'No tickets yet.')}</div>
              ) : (
                <div className="fp-ticket-list">
                  {(tickets || []).slice(0, 8).map((t) => (
                    <div key={t.id} className="fp-ticket-item">
                      <div className="fp-ticket-subject">{t.subject}</div>
                      <div className="fp-ticket-meta">{tr('common.status', 'Status')}: {t.status}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="contact-info-card">
              <h3 className="contact-info-title">{tr('helpCenter.recentActivity', 'Recent activity')}</h3>
              <div className="fp-history-row">
                <input
                  className="fp-ai-input"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder={tr('helpCenter.history.placeholder', 'Search your help-center activity...')}
                />
                <button className="support-option-button primary" onClick={loadHistory} disabled={historyBusy}>
                  {historyBusy ? tr('accountSettings.common.working', 'Working...') : tr('helpCenter.search', 'Search')}
                </button>
              </div>
              {(historyItems || []).length === 0 ? (
                <div className="help-center-inline-muted">{tr('helpCenter.history.empty', 'No recent activity.')}</div>
              ) : (
                <div className="fp-history-list">
                  {(historyItems || []).slice(0, 8).map((h) => (
                    <div key={h.id} className="fp-history-item">
                      <div className="fp-history-type">{String(h.type || '').replace(/_/g, ' ')}</div>
                      <div className="fp-history-text">{h.query || h.content_title || h.content_id || ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}