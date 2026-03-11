import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import '../../styles/verification/Verification.css';

const Verification = () => {
  // FIX 1: Use the new backend-connected function 'confirmOtpVerification'
  const { sendOtp, confirmOtpVerification } = useAuth();
  
  const navigate = useNavigate();
  const location = useLocation();
  
  const [otp, setOtp] = useState(new Array(6).fill(""));
  const [confirmObj, setConfirmObj] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [timer, setTimer] = useState(59);
  const inputRefs = useRef([]);
  
  const hasSentOtp = useRef(false);

  const phone = location.state?.phone;
  const role = location.state?.role || 'carrier';
  const from = location.state?.from;

  useEffect(() => {
    const initOtp = async () => {
      if (phone && !hasSentOtp.current) {
        hasSentOtp.current = true;
        try {
          console.log("Sending OTP to:", phone);
          const confirmation = await sendOtp(phone);
          setConfirmObj(confirmation);
        } catch (err) {
          console.error("OTP Init Error:", err);
          setError("Failed to send SMS: " + err.message);
          hasSentOtp.current = false;
        }
      }
    };
    initOtp();

    const interval = setInterval(() => {
      setTimer((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [phone]);

  const handleChange = (element, index) => {
    if (isNaN(element.value)) return;
    const newOtp = [...otp];
    newOtp[index] = element.value;
    setOtp(newOtp);
    if (element.value && index < 5) {
      inputRefs.current[index + 1].focus();
    }
  };

  const handleKeyDown = (e, index) => {
    if (e.key === "Backspace") {
      if (!otp[index] && index > 0) {
        inputRefs.current[index - 1].focus();
      }
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    
    const otpCode = otp.join("");
    if (otpCode.length !== 6) {
      setError("Please enter a valid 6-digit code.");
      setLoading(false);
      return;
    }

    try {
      if (!confirmObj) throw new Error("OTP session expired. Please resend.");
      
      // 1. Verify code with Firebase (Client Side)
      await confirmObj.confirm(otpCode);
      
      // 2. Call Python Backend to update status & log audit
      // This calls http://localhost:8000/auth/verify-otp
      await confirmOtpVerification();

      // 3. Route to Dashboard
      console.log("Verification Success! Routing to dashboard...");

      const fromPath = from?.pathname ? `${from.pathname}${from.search || ''}` : '';
      if (fromPath && !String(fromPath).startsWith('/login')) {
        navigate(fromPath, { replace: true });
        return;
      }

      switch (role) {
        case 'super_admin': navigate('/super-admin/dashboard'); break;
        case 'admin': navigate('/admin'); break;
        case 'driver': navigate('/driver-dashboard'); break;
        case 'shipper': navigate('/shipper-dashboard'); break;
        default: navigate('/carrier-dashboard');
      }
    } catch (err) {
      console.error(err);
      setError("Invalid Code or Verification Failed.");
    }
    setLoading(false);
  };

  return (
    <div className="verification-page">
      <div id="recaptcha-container"></div>
      
      <div className="verification-container">
        <button className="verification-close" onClick={() => navigate(-1)}>✕</button>
        
        <div className="verification-card">
          <div className="verification-icon">📱</div>
          <h2>Verify Your Phone</h2>
          <p className="verification-sub">We have sent a 6-digit code to {phone}</p>

          {error && <div style={{color:'red', marginBottom: 16, fontSize: '14px'}}>{error}</div>}

          <form className="verification-form" onSubmit={handleVerify}>
            <div className="verification-otp">
              {otp.map((data, index) => (
                <input
                  key={index}
                  type="text"
                  maxLength="1"
                  value={data}
                  onChange={(e) => handleChange(e.target, index)}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                  ref={(el) => (inputRefs.current[index] = el)}
                />
              ))}
            </div>
            
            <button 
              type="submit" 
              className="verification-btn"
              disabled={loading || otp.join("").length !== 6}
              style={{ opacity: loading ? 0.7 : 1 }}
            >
              {loading ? "Verifying..." : "Verify Account"}
            </button>
          </form>

          <div className="verification-resend">
             {timer > 0 ? (
              <>Resend code in <span>00:{timer.toString().padStart(2, '0')}</span></>
            ) : (
              <button 
                onClick={() => window.location.reload()} 
                style={{background:'none', border:'none', color:'#2563eb', cursor:'pointer', fontWeight:600}}
              >
                Resend Code
              </button>
            )}
          </div>
        </div>
      </div>
      
      <footer className="verification-footer">
        <div className="verification-footer-left">Privacy Policy</div>
        <div className="verification-footer-right">Copyright 2025</div>
      </footer>
    </div>
  );
};

export default Verification;