import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../styles/driver/HiringOnboarding.css';
import { useAuth } from '../../contexts/AuthContext';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { API_URL } from '../../config';
import { t } from '../../i18n/translate';

export default function HiringOnboarding({ onNavigate }) {
  const { currentUser } = useAuth();
  const { settings: userSettings } = useUserSettings();
  const language = userSettings?.language || 'English';
  const locale = language === 'Spanish' ? 'es-ES' : language === 'Arabic' ? 'ar' : 'en-US';
  const tr = (key, fallback) => t(language, key, fallback);
  const aiTipsEnabled = Boolean(userSettings?.notification_preferences?.ai_tips);
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const fetchRequired = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    setError('');
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_URL}/onboarding/driver/required-docs`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.detail || tr('hiringOnboarding.errors.loadRequiredFailed', 'Failed to load required documents'));
      setData(json);
    } catch (e) {
      setError(String(e?.message || e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    fetchRequired();
  }, [currentUser, fetchRequired]);

  // Keep statuses in sync when user signs consents (or returns to this tab).
  useEffect(() => {
    if (!currentUser) return;

    const refresh = () => {
      fetchRequired();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    window.addEventListener('fp:consent-updated', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('fp:consent-updated', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [currentUser, fetchRequired]);

  const summary = data?.summary || {};
  const required = Array.isArray(data?.required) ? data.required : [];
  const percent = Number(summary?.percent || 0);
  const completedRequired = Number(summary?.completed_required || 0);
  const totalRequired = Number(summary?.total_required || required.length || 6);
  const consentEligible = Boolean(data?.consent?.eligible);

  const aiSuggestions = useMemo(() => {
    const missing = Array.isArray(summary?.missing_keys) ? summary.missing_keys : [];
    const map = {
      application: { key: 'hiringOnboarding.aiSuggestions.application', fallback: 'Complete your application details to move forward' },
      cdl: { key: 'hiringOnboarding.aiSuggestions.cdl', fallback: 'Upload your CDL to verify license status' },
      medical_card: { key: 'hiringOnboarding.aiSuggestions.medicalCard', fallback: 'Upload your DOT Medical Certificate to maintain compliance status' },
      drug_test: { key: 'hiringOnboarding.aiSuggestions.drugTest', fallback: 'Upload drug test results to complete pre-employment screening' },
      background_check: { key: 'hiringOnboarding.aiSuggestions.backgroundCheck', fallback: 'Upload background check documents to unlock Marketplace access faster' },
      consent: { key: 'hiringOnboarding.aiSuggestions.consent', fallback: 'Sign the Digital Consent Form to unlock remaining actions' },
    };
    const list = missing
      .map((k) => map[String(k || '').toLowerCase()])
      .filter(Boolean)
      .slice(0, 2)
      .map((cfg) => tr(cfg.key, cfg.fallback));
    if (list.length) return list;
    return [tr('hiringOnboarding.aiSuggestions.default', 'Keep your documents up to date to stay eligible')];
  }, [summary?.missing_keys]);

  const formatDate = (value) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const statusBadgeClass = (statusText) => {
    const s = String(statusText || '').toLowerCase();
    if (s.includes('missing') || s.includes('expired')) return 'revoked';
    return 'active';
  };

  const cardClass = (statusText) => {
    const s = String(statusText || '').toLowerCase();
    if (s.includes('missing') || s.includes('expired')) return 'missing';
    return 'complete';
  };

  const handleAction = (item) => {
    if (!item?.actions_enabled) return;
    const action = item?.action || {};
    if (action.type === 'upload') {
      if (typeof onNavigate === 'function') onNavigate('docs');
      else navigate('/driver-dashboard');
      return;
    }
    if (action.type === 'view') {
      const url = item?.doc?.download_url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Navigate to E-Sign without URL query params.
    if (item?.key === 'consent') {
      if (typeof onNavigate === 'function') onNavigate('esign');
      return;
    }
    // Default to driver onboarding for application/info actions
    if (item?.key === 'application') {
      navigate('/driver-onboarding');
    }
  };

  return (
    <div className="ho-container">
      <header className="ho-header">
        <div>
          <h2>{tr('hiringOnboarding.header.title', 'Hiring & Onboarding')}</h2>
          <div className="ho-progress-label">
            {tr('hiringOnboarding.header.eligibilityProgress', 'Marketplace Eligibility Progress')}
          </div>
        </div>
      </header>

      <div className='progress-section'>
        <div className='ho-details'>
          <span className="ho-ai-available">{tr('hiringOnboarding.aiAssistantAvailable', 'AI Assistant Available')}</span>
        <span className="ho-progress-status">{completedRequired}/{totalRequired} {tr('hiringOnboarding.progress.completeLabel', 'Complete')} ({percent}%)</span>
        </div>
        <div className="ho-progress-bar">
            <div className="ho-progress-bar-fill" style={{width: `${Math.max(0, Math.min(100, percent))}%`}}></div>
        </div>  
        <div className="ho-info-card ho-info-complete">
        <i className="fa-solid fa-circle-info"></i>
        <div className='ho-info-text'>
            <h5>{percent >= 100 ? tr('hiringOnboarding.info.onboardingCompleteTitle', 'Onboarding complete') : tr('hiringOnboarding.info.unlockVisibilityTitle', 'Complete all required items to unlock Marketplace visibility')}</h5>
        <p>{percent >= 100 ? tr('hiringOnboarding.info.onboardingCompleteBody', 'You are eligible for Marketplace visibility.') : tr('hiringOnboarding.info.unlockVisibilityBody', 'Carriers will be able to find and hire you once onboarding is complete.')}</p>
        </div>
      </div>
      </div>

      <section className="ho-section">
        <h3>{tr('hiringOnboarding.requiredSection.title', 'Required Documents & Information')}</h3>
        {error ? (
          <div className="ho-info-card" style={{ marginTop: '10px' }}>
            <i className="fa-solid fa-triangle-exclamation"></i>
            <div className='ho-info-text'>
              <h5>{tr('hiringOnboarding.errors.unableToLoadStatus', 'Unable to load onboarding status')}</h5>
              <p>{error}</p>
              <button className="btn small ghost-cd" onClick={fetchRequired}>{tr('hiringOnboarding.actions.retry', 'Retry')}</button>
            </div>
          </div>
        ) : null}
        <div className="ho-required-grid">
          {(loading && !data) ? (
            <div className="ho-card complete">
              <div className="ho-card-header">
                <span className="ho-card-title">{tr('hiringOnboarding.loading.title', 'Loading…')}</span>
                <span className="int-status-badge active">{tr('hiringOnboarding.loading.pleaseWait', 'Please wait')}</span>
              </div>
              <p className="ho-card-desc">{tr('hiringOnboarding.loading.fetchingRequirements', 'Fetching your onboarding requirements')}</p>
              <button className="btn small ghost-cd" disabled>{tr('hiringOnboarding.loading.button', 'Loading')}</button>
            </div>
          ) : required.map((item) => {
            const desc = item?.expiry_date
              ? `${tr('hiringOnboarding.expiresPrefix', 'Expires: ')}${formatDate(item.expiry_date)}`
              : (item?.description || '');
            const blocked = Boolean(item?.blocked_by_consent);
            const disabled = blocked || !item?.actions_enabled;
            const buttonLabel = blocked
              ? tr('hiringOnboarding.actions.completeConsentToUnlock', 'Complete Consent to Unlock')
              : String(item?.action?.label || tr('hiringOnboarding.actions.open', 'Open'));
            return (
              <div key={item.key} className={`ho-card ${cardClass(item.status)}`}>
                <div className="ho-card-header">
                  <span className="ho-card-title">{item.title}</span>
                  <span className={`int-status-badge ${statusBadgeClass(item.status)}`}>{item.status}</span>
                </div>
                <p className={`ho-card-desc${(String(item.status || '').toLowerCase().includes('missing') || String(item.status || '').toLowerCase().includes('expired')) ? ' warning' : ''}`}>{desc}</p>
                <button
                  className={item?.action?.type === 'view' ? 'btn small ghost-cd' : 'btn btn small-cd'}
                  disabled={disabled}
                  onClick={() => handleAction(item)}
                  title={!consentEligible && blocked ? tr('hiringOnboarding.tooltips.signConsentToEnable', 'Sign consent to enable this action') : ''}
                >
                  {buttonLabel}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="ho-section">
        <h3>{tr('hiringOnboarding.training.sectionTitle', 'Optional Training & Knowledge Base')} <span className="int-status-badge active">{tr('hiringOnboarding.training.recommended', 'Recommended')}</span></h3>
        <div className="ho-training-card coming-soon">
          <div className="ho-training-disabled-content">
            <div className="ho-training-header">
              <i className="fa-solid fa-graduation-cap"></i>
              <div>
                <span className="ho-training-title">{tr('hiringOnboarding.training.badgeTitle', 'Earn "Trained & Ready" Badge')}</span>
                <p>{tr('hiringOnboarding.training.badgeBody', 'Complete training modules to boost your profile visibility to carriers')}</p>
              </div>
            </div>
            <div className="ho-training-grid">
              <div className="ho-training-item">
                <span className="ho-training-label">{tr('hiringOnboarding.training.course.freightPowerBasics', 'FreightPower Basics')}</span>
                <button className="btn btn small-cd" disabled>{tr('hiringOnboarding.training.startCourse', 'Start Course')}</button>
              </div>
              <div className="ho-training-item">
                <span className="ho-training-label">{tr('hiringOnboarding.training.course.hoursOfService', 'Hours of Service')}</span>
                <button className="btn btn small-cd" disabled>{tr('hiringOnboarding.training.startCourse', 'Start Course')}</button>
              </div>
              <div className="ho-training-item">
                <span className="ho-training-label">{tr('hiringOnboarding.training.course.safetyCompliance', 'Safety & Compliance')}</span>
                <button className="btn btn small-cd" disabled>{tr('hiringOnboarding.training.startCourse', 'Start Course')}</button>
              </div>
            </div>
          </div>
          <div className="ho-coming-soon-overlay">{tr('hiringOnboarding.common.comingSoon', 'Coming soon')}</div>
        </div>
      </section>

      {aiTipsEnabled && (
        <div className="ho-info-card ho-ai-recommend">
          <div className="ai-content">
            <h4>{tr('hiringOnboarding.aiRecommendations.title', 'AI Assistant Recommendations')}</h4>
            <ul className="ai-list">
              {aiSuggestions.map((txt, idx) => (
                <li key={idx}><span className="ai-list-icon"><i className="fa-solid fa-lightbulb"></i></span>{txt}</li>
              ))}
            </ul>
            <button 
              className="btn small ghost-cd dd-btn"
              onClick={() => {
                if (typeof onNavigate === 'function') onNavigate('help');
                else navigate('/driver-dashboard?nav=help');
              }}
            >
              {tr('hiringOnboarding.aiRecommendations.chat', 'Chat with AI Assistant')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
