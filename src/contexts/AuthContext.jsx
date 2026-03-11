// src/contexts/AuthContext.jsx
import React, { useContext, useState, useEffect } from "react";
import { auth, db } from "../firebase";
import { API_URL } from "../config";
import { 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  sendEmailVerification,
  sendPasswordResetEmail // NEW IMPORT
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { clearSessionId } from "../utils/session";

const AuthContext = React.createContext();

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [isVerified, setIsVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  // Background GPS heartbeat (best-effort) to populate users.gps_lat/gps_lng.
  // This powers admin Tracking & Visibility map markers.
  useEffect(() => {
    if (!currentUser) return;
    const role = String(userRole || '').toLowerCase();
    if (!role || role === 'admin' || role === 'super_admin') return;

    const isEligibleRole = ['driver', 'carrier', 'shipper', 'broker'].includes(role);
    if (!isEligibleRole) return;

    if (!('geolocation' in navigator)) return;

    const STORAGE_KEY = 'fp_gps_last_sent_v1';
    const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const MIN_MOVE_MILES = 0.5;

    function haversineMiles(lat1, lon1, lat2, lon2) {
      const R = 3958.8;
      const toRad = (deg) => (deg * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    function readLast() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_e) {
        return null;
      }
    }

    function writeLast(obj) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
      } catch (_e) { /* ignore localStorage errors in private browsing */ }
    }

    async function sendGps(lat, lng) {
      try {
        const token = await currentUser.getIdToken();
        await fetch(`${API_URL}/auth/profile/update`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            gps_lat: lat,
            gps_lng: lng,
          })
        });
      } catch (_e) {
        // best-effort: ignore
      }
    }

    let stopped = false;

    const tick = () => {
      if (stopped) return;
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          if (stopped) return;
          const lat = Number(pos?.coords?.latitude);
          const lng = Number(pos?.coords?.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

          const now = Date.now();
          const last = readLast();

          const tooSoon = last?.ts && (now - Number(last.ts) < MIN_INTERVAL_MS);
          const movedEnough = last?.lat != null && last?.lng != null
            ? (haversineMiles(Number(last.lat), Number(last.lng), lat, lng) >= MIN_MOVE_MILES)
            : true;

          if (!tooSoon && movedEnough) {
            await sendGps(lat, lng);
            writeLast({ ts: now, lat, lng });
          }
        },
        () => {
          // Permission denied / unavailable: do nothing.
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
      );
    };

    // Kick once soon after login, then keep updating.
    const startTimer = setTimeout(tick, 1500);
    const intervalId = setInterval(tick, MIN_INTERVAL_MS);

    return () => {
      stopped = true;
      clearTimeout(startTimer);
      clearInterval(intervalId);
    };
  }, [currentUser, userRole]);

  const smsOtpDisabled = String(import.meta.env.VITE_DISABLE_SMS_OTP || '').toLowerCase() === '1'
    || String(import.meta.env.VITE_DISABLE_SMS_OTP || '').toLowerCase() === 'true';
  const mockSmsCode = String(import.meta.env.VITE_MOCK_SMS_CODE || '123456');
  const mockSmsDelayMs = Number(import.meta.env.VITE_MOCK_SMS_DELAY_MS || 700);

  // --- 1. SIGNUP ---
  async function signup(email, password, name, phone, role) {
    const response = await fetch(`${API_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name, phone, role })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Signup failed");
    return data;
  }

  // --- 2. LOGIN WITH MFA CHECK (UPDATED) ---
  async function login(email, password) {
    // A. Standard Firebase Login
    const result = await signInWithEmailAndPassword(auth, email, password);
    const uid = result.user.uid;

    // B. Check Firestore for MFA Setting
    const docRef = doc(db, "users", uid);
    const docSnap = await getDoc(docRef);
    
    let mfaRequired = false;
    let phone = "";
    let role = "carrier";

    if (docSnap.exists()) {
      const data = docSnap.data();
      phone = data.phone; // Get phone from DB for SMS
      role = data.role || role;
      if (data.mfa_enabled === true) {
        mfaRequired = true;
      }
    }

    // Admins should not use the public /login + SMS OTP flow.
    // Admins/super admins authenticate via /admin/login or /super-admin/login (email MFA + custom token).
    if (role === 'admin' || role === 'super_admin') {
      try { await signOut(auth); } catch (_e) { /* ignore sign-out errors */ }
      return {
        user: null,
        mfaRequired: false,
        redirectTo: role === 'super_admin' ? '/super-admin/login' : '/admin/login',
        reason: 'Use the dedicated admin login',
      };
    }

    // C. Handle MFA or Log Success
    // SMS OTP is disabled in dev (see .env.local). Ignore phone-based MFA.
    if (smsOtpDisabled) {
      await logLoginToBackend(result.user);
      return { user: result.user, mfaRequired: false, smsOtpDisabled: true };
    }

    if (mfaRequired && phone) {
      // Trigger SMS immediately
      // Note: We return specific status so Login.jsx knows to redirect to /verify
      await sendOtp(phone);
      return { user: result.user, mfaRequired: true, phone: phone };
    } else {
      // No MFA? Log the login immediately
      await logLoginToBackend(result.user);
      return { user: result.user, mfaRequired: false };
    }
  }

  // Helper to log login (moved out to be reusable)
  async function logLoginToBackend(user) {
    try {
      const token = await user.getIdToken();
      await fetch(`${API_URL}/auth/log-login`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      console.error("Audit Log Failed:", err);
    }
  }

  // --- 3. PASSWORD RESET (NEW) ---
  function resetPassword(email) {
    return sendPasswordResetEmail(auth, email);
  }

  // --- 4. VERIFICATION UTILS ---
  const sendVerificationLink = async (user) => {
    if (user) {
      await sendEmailVerification(user, {
        url: 'http://localhost:5173/login', 
        handleCodeInApp: true
      });
    }
  };

  function setupRecaptcha(elementId) {
    if (window.recaptchaVerifier) {
      try { window.recaptchaVerifier.clear(); } catch (_e) { /* ignore recaptcha clear errors */ }
      window.recaptchaVerifier = null;
    }
    // Ensure the element exists in DOM before attaching
    if(!document.getElementById(elementId)) return; 
    
    window.recaptchaVerifier = new RecaptchaVerifier(auth, elementId, {
      'size': 'invisible',
    });
  }

  async function sendOtp(phoneNumber) {
    if (smsOtpDisabled) {
      // Mock mode: do not call Firebase Phone Auth.
      // Return an object compatible with ConfirmationResult.
      await new Promise((r) => setTimeout(r, Number.isFinite(mockSmsDelayMs) ? mockSmsDelayMs : 700));
      return {
        confirm: async (code) => {
          const trimmed = String(code || '').trim();
          if (trimmed !== mockSmsCode) {
            throw new Error('Invalid code');
          }
          return { user: auth.currentUser };
        },
      };
    }
    setupRecaptcha("recaptcha-container");
    const appVerifier = window.recaptchaVerifier;
    return await signInWithPhoneNumber(auth, phoneNumber, appVerifier);
  }

  async function confirmOtpVerification() {
    if (!auth.currentUser) throw new Error("No user logged in");
    
    const token = await auth.currentUser.getIdToken();
    
    const response = await fetch(`${API_URL}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) throw new Error("Backend verification failed");
    
    setIsVerified(true);
    // If this was an MFA check, we should log the login now
    await logLoginToBackend(auth.currentUser);
    
    return true;
  }

  function logout() {
    clearSessionId();
    return signOut(auth);
  }

  // --- MONITOR SESSION ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          await user.reload(); 
          const docRef = doc(db, "users", user.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            const data = docSnap.data();
            setUserRole(data.role);
            const isEmailVerified = user.emailVerified;
            setIsVerified(data.is_verified || isEmailVerified); 
          }
        } catch (e) {
          console.error("Fetch Role Error:", e);
        }
      } else {
        setUserRole(null);
        setIsVerified(false);
      }
      setCurrentUser(user);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const value = {
    currentUser,
    userRole,
    isVerified,
    signup,
    login,
    logout,
    resetPassword, // EXPORTED
    sendOtp,
    confirmOtpVerification,
    sendVerificationLink
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}