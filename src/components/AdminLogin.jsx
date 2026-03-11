import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '../firebase'
import Toast from './common/Toast'
import { API_URL } from '../config'
import '../styles/carrier/CarrierSignup.css'
import '../styles/carrier/CarrierLogin.css'
import carrier_ob_1 from '../assets/carrier_ob_1.png'
import carrier_ob_2 from '../assets/carrier_ob_2.jpg'
import carrier_ob_3 from '../assets/carrier_ob_3.jpg'
import pattern_bg_signup from '../assets/pattern_bg_signup.svg'
import { getOrCreateTrustedDeviceId, getTrustedDeviceToken } from '../utils/trustedDevice'
import { setSessionId } from '../utils/session'

export default function AdminLogin(){
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const images = [carrier_ob_1, carrier_ob_2, carrier_ob_3]
  const [currentImg, setCurrentImg] = useState(0)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (location?.state?.pendingApproval || location?.state?.pending) {
      setToast({ type: 'error', message: 'Pending approval' })
    }
  }, [location])

  useEffect(()=>{
    const t = setInterval(()=> setCurrentImg((p)=> (p+1)%images.length), 2500)
    return ()=> clearInterval(t)
  },[])

  const handleSubmit = async (e)=>{
    e.preventDefault()
    setToast(null)
    setLoading(true)
    try {
      const hasTrustedDeviceToken = !!getTrustedDeviceToken()
      const resp = await fetch(`${API_URL}/auth/admin/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(hasTrustedDeviceToken
            ? {
                'X-Trusted-Device-Id': getOrCreateTrustedDeviceId(),
                'X-Trusted-Device-Token': getTrustedDeviceToken(),
              }
            : {}),
        },
        body: JSON.stringify({ email: email.trim(), password }),
      })

      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        const detail = data?.detail || 'Login failed'
        if (String(detail).toLowerCase().includes('pending')) {
          setToast({ type: 'error', message: 'Pending approval' })
          return
        }
        throw new Error(detail)
      }

      if (data?.mfa_required && data?.mfa_session) {
        const from = hasTrustedDeviceToken ? null : location?.state?.from
        navigate('/admin/verify', {
          replace: true,
          state: {
            mfaSession: data.mfa_session,
            email: email.trim(),
            from,
          },
        })
        return
      }

      await signInWithCustomToken(auth, data.custom_token)
      if (data?.session_id) setSessionId(data.session_id)
      if (hasTrustedDeviceToken) {
        navigate('/admin', { replace: true })
        return
      }

      const from = location?.state?.from
      const fromPath = from?.pathname ? `${from.pathname}${from.search || ''}` : ''
      navigate(fromPath || '/admin', { replace: true })
    } catch (err) {
      console.error(err)
      setToast({ type: 'error', message: err?.message || 'Login failed. Check email/password.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="carrier-signup-container carrier-login-page">
      <Toast message={toast?.message} type={toast?.type} onClose={() => setToast(null)} />
      <div className="carrier-signup-left">
        <img src={pattern_bg_signup} alt="Pattern" className="carrier-signup-pattern-bg" />
        <div className="carrier-signup-form-bg">
          <h1 className="carrier-signup-title">Admin Login</h1>
          <p className="carrier-signup-subtitle">Access the command center and keep the network running smoothly.</p>

          <form className="carrier-signup-form" onSubmit={handleSubmit}>
            <div className="carrier-signup-field input-with-icon">
              <label>Email</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-envelope" aria-hidden="true" />
                <input type="email" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="admin@freightpower.ai" />
              </div>
            </div>

            <div className="carrier-signup-field input-with-icon">
              <label>Password</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-lock" aria-hidden="true" />
                <input id="password-field" type={showPassword ? 'text' : 'password'} value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="Enter your password" />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={()=> setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <i className={showPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="carrier-signup-bottom-actions">
              <div className="remember-row">
                <label className="remember-ctrl"><input type="checkbox" checked={remember} onChange={(e)=>setRemember(e.target.checked)} /> Remember me</label>
                <a href="#" className="forgot-link">Forgot Password?</a>
              </div>

              <div className="carrier-signup-login-actions">
                <button type="submit" className="carrier-signup-btn" disabled={loading}>{loading ? 'Signing in…' : 'Sign In to Admin Panel'}</button>
              </div>

              <div className="divider"><span>or</span></div>

              <button type="button" className="google-signin">
                <i className="fa-brands fa-google google-icon" aria-hidden="true" />
                Sign in with Google
              </button>

              <div className="carrier-signup-login-text small muted" style={{marginTop:8}}>Authorized personnel only.</div>

              <div className="carrier-signup-login-text">
                Don't have an account? <a href="/admin/signup">Sign Up</a>
              </div>
            </div>
          </form>

        </div>
      </div>

      <div className="carrier-signup-right-bg-simple">
        <img src={'/src/assets/blue_bg_signup.svg'} alt="Blue Background" className="carrier-signup-bg-svg" />
        <div className="carrier-signup-img-block">
          <img src={images[currentImg]} alt="Onboarding" className="carrier-signup-img-top-simple" />
        </div>
        <div className="carrier-signup-info-bottom">
          <div className="carrier-signup-img-indicators" style={{ background: 'transparent', minHeight: '24px', marginBottom: '0', marginTop: '0' }}>
            {images.map((_, idx) => (
              <span
                key={idx}
                onClick={() => setCurrentImg(idx)}
                className={ idx === currentImg ? "carrier-signup-dot-active" : "carrier-signup-dot" }
                style={{ display: 'inline-block', verticalAlign: 'middle', cursor: 'pointer' }}
              />
            ))}
          </div>
          <div className="carrier-signup-info-simple">
            <h2>Onboard Faster,<br/>Manage Smarter with AI</h2>
            <ul>
              <li>Connect instantly, automate your documents, and move freight smarter in one intelligent digital marketplace.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
