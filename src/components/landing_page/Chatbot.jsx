import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import chatbotIcon from '../../assets/chatbot.svg';
import cameraIcon from '../../assets/Camera.svg';
import uploadIcon from '../../assets/Upload.svg';
import smileIcon from '../../assets/face-smile.svg';
import '../../styles/landing_page/chatbot.css';

// Simple Session ID Generator
const generateSessionId = () => 'sess_' + Math.random().toString(36).substr(2, 9);

export default function Chatbot({ isOpen, onClose, onMinimizeChange }) {
  const navigate = useNavigate();
  const { currentUser } = useAuth() || {};
  
  // State for Logic
  const [sessionId] = useState(generateSessionId());
  const [messages, setMessages] = useState([]); 
  const [inputValue, setInputValue] = useState('');
  const [showUpload, setShowUpload] = useState(false); 
  const [isUploading, setIsUploading] = useState(false);
  const [authToken, setAuthToken] = useState(null);
  const [requiredDocs, setRequiredDocs] = useState([]);
  const [completedDocs, setCompletedDocs] = useState([]);
  const [complianceScore, setComplianceScore] = useState(null);

  // State for UI
  const [_currentTime, setCurrentTime] = useState('');
  const [isMinimized, setIsMinimized] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const timeString = now.toLocaleTimeString([], { 
        hour: 'numeric', minute: '2-digit', hour12: true 
      });
      setCurrentTime(`Today ${timeString}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      sendMessageToBackend("hello", null, true); 
    }
  }, [isOpen]);

  useEffect(() => {
    let active = true;
    const loadToken = async () => {
      try {
        if (currentUser) {
          const t = await currentUser.getIdToken();
          if (active) setAuthToken(t);
        }
      } catch (e) {
        console.warn("Token fetch failed", e);
      }
    };
    loadToken();
    return () => { active = false; };
  }, [currentUser]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, showUpload]);

  const sendMessageToBackend = async (text, attachedDocId = null, hidden = false) => {
    if (!hidden) {
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      setMessages(prev => [...prev, { type: 'user', text, time }]);
    }

    try {
      const response = await fetch(`${API_URL}/chat/onboarding`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({
          session_id: sessionId,
          message: text,
          attached_document_id: attachedDocId
        })
      });

      const data = await response.json();
      const botTime = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

      setMessages(prev => [...prev, { type: 'bot', text: data.message, time: `Today ${botTime}` }]);

      // capture checklist/compliance info
      if (data?.data_payload) {
        if (data.data_payload.required_docs) setRequiredDocs(data.data_payload.required_docs);
        if (data.data_payload.completed_docs) setCompletedDocs(data.data_payload.completed_docs);
        if (data.data_payload.compliance_score !== undefined) setComplianceScore(data.data_payload.compliance_score);
      }

      if (data.ui_action === 'show_upload') {
        setShowUpload(true);
      } else if (data.ui_action === 'redirect_signup') {
        setShowUpload(false);
        setTimeout(() => {
          navigate('/signup', { state: { prefill: data.data_payload } });
        }, 1500);
      } else if (data.ui_action === 'redirect_dashboard') {
        setShowUpload(false);
        // Save chatbot data before redirecting
        if (data.data_payload) {
          await createAccountFromChatbot(data.data_payload);
        } else {
          const dashboardUrl = data.redirect_url || '/dashboard';
          navigate(dashboardUrl, { state: { prefill: data.data_payload } });
        }
      } else if (data.ui_action === 'save_onboarding') {
        setShowUpload(false);
        await finalizeOnboarding(data.data_payload);
      } else if (data.ui_action === 'create_account_chatbot') {
        setShowUpload(false);
        await createAccountFromChatbot(data.data_payload);
      } else {
        setShowUpload(false);
      }

    } catch (error) {
      console.error("Chat Error", error);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploading(true);
    
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    setMessages(prev => [...prev, { type: 'user', text: `Uploading ${file.name}...`, time }]);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const uploadRes = await fetch(`${API_URL}/documents`, {
        method: 'POST',
        headers: {
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: formData
      });
      const uploadData = await uploadRes.json();

      if (uploadRes.ok) {
        await sendMessageToBackend("uploaded_document", uploadData.document_id, true);
      } else {
        setMessages(prev => [...prev, { type: 'bot', text: "Upload failed. Please try a valid PDF.", time }]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsUploading(false);
      setShowUpload(false); 
    }
  };

  const handleSendClick = () => {
    if (inputValue.trim()) {
      sendMessageToBackend(inputValue);
      setInputValue('');
    }
  };

  const finalizeOnboarding = async (payload = {}) => {
    // Map collected data into expected onboarding fields
    const data = payload.collected_data || {};
    const role = payload.role || 'carrier';

    const onboardingData = {
      companyName: data.company_name,
      dotNumber: data.dot_number,
      mcNumber: data.mc_number,
      fullName: data.full_name,
      cdlNumber: data.cdl_number,
      businessName: data.company_name,
      complianceScore: payload.compliance_score
    };

    if (!authToken) {
      setMessages(prev => [...prev, { type: 'bot', text: "Please sign in to finalize onboarding so we can save your documents.", time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) }]);
      return;
    }

    try {
      const res = await fetch(`${API_URL}/onboarding/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          role,
          data: onboardingData
        })
      });
      const result = await res.json();
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      if (res.ok && result.success) {
        setMessages(prev => [...prev, { type: 'bot', text: "✅ Onboarding saved! You're all set. Redirecting to dashboard...", time: `Today ${time}` }]);
        setTimeout(() => navigate(`/${role}-dashboard`), 1500);
      } else {
        setMessages(prev => [...prev, { type: 'bot', text: `Unable to save onboarding: ${result.detail || 'Please try again.'}`, time: `Today ${time}` }]);
      }
    } catch (error) {
      console.error("Save onboarding error", error);
    }
  };

  const createAccountFromChatbot = async (payload = {}) => {
    // Create account directly from chatbot data (quick path)
    const role = payload.role || 'carrier';

    if (!authToken) {
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      setMessages(prev => [...prev, { type: 'bot', text: "Please sign in to create your account.", time: `Today ${time}` }]);
      return;
    }

    try {
      const res = await fetch(`${API_URL}/onboarding/create-from-chatbot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          role,
          collected_data: payload.collected_data,
          document_ids: payload.document_ids,
          documents: payload.documents || [],
          compliance_score: payload.compliance_score,
          missing_fields: payload.missing_fields || []
        })
      });
      const result = await res.json();
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      if (res.ok && result.success) {
        setMessages(prev => [...prev, { type: 'bot', text: "✅ Account created successfully! Redirecting to your dashboard...", time: `Today ${time}` }]);
        const dashboardUrl = result.redirect_url || `/${payload.role}-dashboard`;
        setTimeout(() => navigate(dashboardUrl), 1500);
      } else {
        setMessages(prev => [...prev, { type: 'bot', text: `Unable to create account: ${result.detail || 'Please try again.'}`, time: `Today ${time}` }]);
      }
    } catch (error) {
      console.error("Create account error", error);
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      setMessages(prev => [...prev, { type: 'bot', text: "An error occurred while creating your account. Please try again.", time: `Today ${time}` }]);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendClick();
    }
  };

  const handleMinimize = () => {
    const next = !isMinimized;
    setIsMinimized(next);
    if (typeof onMinimizeChange === 'function') onMinimizeChange(next);
  };

  if (!isOpen) return null;

  return (
    <div className="chatbot-overlay">
      <div className={`chatbot-container ${isMinimized ? 'minimized' : ''}`}>
        
        {/* Header */}
        <div className="chatbot-header">
          <div className="chatbot-avatar-header">
            <img src={chatbotIcon} alt="Chatbot" className="chatbot-header-icon" />
          </div>
          <div className="chatbot-header-controls">
            <button className="chatbot-minimize" onClick={handleMinimize} aria-label="Minimize Chat">
              {isMinimized ? '□' : '−'}
            </button>
            <button className="chatbot-close" onClick={() => { if (typeof onMinimizeChange === 'function') onMinimizeChange(false); onClose && onClose() }} aria-label="Close Chat">×</button>
          </div>
        </div>

        {/* Messages */}
        {!isMinimized && (
          <>
            <div className="chatbot-messages">
              {(requiredDocs.length > 0 || complianceScore !== null) && (
                <div className="chatbot-message" style={{ flexDirection:'row' }}>
                  <div className="chatbot-avatar">
                    <img src={chatbotIcon} alt="Chatbot" className="chatbot-avatar-icon" />
                  </div>
                  <div className="chatbot-message-content" style={{ background:'#EEF2FF', color:'#111827' }}>
                    <div className="chatbot-message-header">
                      <span className="chatbot-name">Checklist</span>
                      {complianceScore !== null && (
                        <span className="chatbot-time">Compliance score: {complianceScore}</span>
                      )}
                    </div>
                    <div className="chatbot-message-text">
                      {requiredDocs.length === 0 && "No documents required yet."}
                      {requiredDocs.length > 0 && (
                        <ul style={{ paddingLeft:16, margin:0 }}>
                          {requiredDocs.map(doc => (
                            <li key={doc} style={{ color: completedDocs.includes(doc) ? '#16A34A' : '#6B7280' }}>
                              {completedDocs.includes(doc) ? '✅ ' : '⬜️ '}{doc.replace('_',' ')}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {messages.map((msg, index) => {
                const isBot = msg.type === 'bot';
                const isLastMessage = index === messages.length - 1;
                const shouldRenderUpload = isBot && isLastMessage && showUpload;

                return (
                  <div key={index} className="chatbot-message" style={{ flexDirection: isBot ? 'row' : 'row-reverse' }}>
                    
                    {isBot ? (
                      <div className="chatbot-avatar">
                        <img src={chatbotIcon} alt="Chatbot" className="chatbot-avatar-icon" />
                      </div>
                    ) : (
                      <div style={{width: 32, marginLeft: 12}}></div> 
                    )}

                    <div className="chatbot-message-content" style={{ 
                        background: isBot ? '#F3F4F6' : '#2563EB', 
                        color: isBot ? '#1F2937' : '#FFFFFF',
                        marginLeft: isBot ? 0 : 'auto' 
                    }}>
                      <div className="chatbot-message-header">
                        <span className="chatbot-name" style={{ color: isBot ? '#111827' : '#E0E7FF' }}>
                          {isBot ? 'Onboarding Chatbot' : 'You'}
                        </span>
                        <span className="chatbot-time" style={{ color: isBot ? '#6B7280' : '#E0E7FF' }}>
                          {msg.time}
                        </span>
                      </div>
                      
                      <div className="chatbot-message-text">
                        {msg.text}
                      </div>
                      
                      {/* DYNAMIC UPLOAD AREA */}
                      {shouldRenderUpload && (
                        <div className="chatbot-upload-area" style={{marginTop: 12, background: 'white'}}>
                          <input
                            type="file"
                            id="file-upload" 
                            name="document-upload" /* Added name attribute */
                            accept=".pdf,.png,.jpg,.jpeg" 
                            onChange={handleFileUpload}
                            disabled={isUploading}
                            style={{ display: 'none' }}
                          />
                          <label htmlFor="file-upload" className="chatbot-upload-label">
                            <div className="chatbot-upload-icon">
                              <img src={uploadIcon} alt="Upload" className="upload-icon-svg" />
                            </div>
                            <div className="chatbot-upload-text">
                              <span className="upload-link">Click to upload</span> Required Document<br />
                              PDF, PNG, or JPG (max. 10MB)
                            </div>
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="chatbot-input-area">
              <button className="chatbot-action-btn" aria-label="Open Camera">
                <img src={cameraIcon} alt="Camera" className="action-icon" />
              </button>
              
              <button className="chatbot-action-btn" onClick={() => document.getElementById('file-upload')?.click()} aria-label="Upload File">
                <img src={uploadIcon} alt="Upload" className="action-icon" />
              </button>

              <button className="chatbot-action-btn" aria-label="Insert Emoji">
                <img src={smileIcon} alt="Emoji" className="action-icon" />
              </button>
              
              {/* FIXED TEXT INPUT */}
              <div style={{flex: 1, display: 'flex', alignItems:'center'}}>
                <input 
                    id="chat-message-input"        /* Fixed: Added ID */
                    name="message"                 /* Fixed: Added Name */
                    aria-label="Type your reply"   /* Fixed: Added Label */
                    style={{
                        width: '100%', 
                        border: 'none', 
                        outline: 'none', 
                        padding: '0 8px',
                        fontSize: '14px'
                    }}
                    placeholder="Type your reply..."
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                />
              </div>

              <button className="chatbot-send-button" onClick={handleSendClick}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}