import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase'
import Toast from './common/Toast'
import { API_URL } from '../config'
import '../styles/carrier/CarrierSignup.css'
import pattern_bg_signup from '../assets/pattern_bg_signup.svg'
import carrier_ob_1 from '../assets/carrier_ob_1.png'
import carrier_ob_2 from '../assets/carrier_ob_2.jpg'
import carrier_ob_3 from '../assets/carrier_ob_3.jpg'

export default function AdminSignup(){
  const [showPassword, setShowPassword] = useState(false)
  const [acceptedAdmin, setAcceptedAdmin] = useState(false)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [department, setDepartment] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const navigate = useNavigate()
  const images = [carrier_ob_1, carrier_ob_2, carrier_ob_3]
  const [currentImg, setCurrentImg] = useState(0)

  useEffect(()=>{
    const t = setInterval(()=> setCurrentImg((p)=> (p+1)%images.length), 2500)
    return ()=> clearInterval(t)
  }, [])

  const handleSubmit = async (e)=>{
    e.preventDefault()
    setToast(null)

    if (!acceptedAdmin) {
      setToast({ type: 'error', message: 'You must acknowledge admin access terms.' })
      return
    }
    if (!fullName.trim() || !email.trim() || !password) {
      setToast({ type: 'error', message: 'Please fill all required fields.' })
      return
    }
    if (password !== confirmPassword) {
      setToast({ type: 'error', message: 'Passwords do not match.' })
      return
    }

    setLoading(true)
    try {
      const resp = await fetch(`${API_URL}/auth/admin/request-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          name: fullName.trim(),
          phone: phone.trim() || null,
          department: department.trim() || null,
        }),
      })

      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        throw new Error(data?.detail || 'Admin signup failed')
      }

      // Ensure no active session for pending admins
      try { await signOut(auth) } catch { /* ignore sign-out errors during signup */ }

      navigate('/admin/login', { state: { pendingApproval: true } })
    } catch (err) {
      console.error(err)
      setToast({ type: 'error', message: err?.message || 'Admin signup failed.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="carrier-signup-container carrier-login-page">
      <Toast message={toast?.message} type={toast?.type} onClose={() => setToast(null)} />
      <div className="carrier-signup-left">
        <img src={pattern_bg_signup} alt="Pattern" className="carrier-signup-pattern-bg"/>
        <div className="carrier-signup-form-bg">
          <h1 className="carrier-signup-title">Create Admin Account</h1>
          <p className="carrier-signup-subtitle">Enter admin details to create an administrative user</p>

          <form className="carrier-signup-form" onSubmit={handleSubmit}>
            <div className="carrier-signup-field input-with-icon">
              <label>Full Name</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-user" aria-hidden="true" />
                <input type="text" value={fullName} onChange={(e)=>setFullName(e.target.value)} placeholder="Enter your full name" required />
              </div>
            </div>

            <div className="carrier-signup-field input-with-icon">
              <label>Official Email Address</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-envelope" aria-hidden="true" />
                <input type="email" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="admin@company.com" required />
              </div>
            </div>

            <div className="carrier-signup-field input-with-icon">
              <label>Phone Number (optional)</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-phone" aria-hidden="true" />
                <input type="tel" value={phone} onChange={(e)=>setPhone(e.target.value)} placeholder="+1 (555) 123-4567" />
              </div>
            </div>

            <div className="carrier-signup-field">
              <label>Department / Team</label>
              <select className="ss-select" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">Select department</option>
                <option value="Compliance & Operations">Compliance & Operations</option>
                <option value="Billing">Billing</option>
                <option value="Support">Support</option>
              </select>
            </div>

            <div className="carrier-signup-field input-with-icon">
              <label>Password</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-lock" aria-hidden="true" />
                <input id="admin-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="Create a secure password" required />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <i className={showPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="carrier-signup-field input-with-icon">
              <label>Confirm Password</label>
              <div className="input-icon-wrap">
                <i className="fa-solid fa-lock" aria-hidden="true" />
                <input id="admin-password-confirm" type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e)=>setConfirmPassword(e.target.value)} placeholder="Confirm your password" required />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <i className={showPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="carrier-signup-field">
              <label className="terms-ctrl">
                <input type="checkbox" checked={acceptedAdmin} onChange={(e) => setAcceptedAdmin(e.target.checked)} />
                <span> I acknowledge that this account grants administrative control over the FreightPower AI system.</span>
              </label>
            </div>

            <div className="carrier-signup-bottom-actions">
              <div className="carrier-signup-login-actions">
                <button type="submit" className="carrier-signup-btn" disabled={loading}>{loading ? 'Submitting…' : 'Create Admin Account'}</button>
              </div>

              <div className="divider"></div>

              <button type="button" className="google-signin">
                <i className="fa-brands fa-google google-icon" aria-hidden="true" />
                Sign Up with Google
              </button>

              <div className="carrier-signup-login-text">
                Already have an account? <a href="/admin/login">Sign In</a>
              </div>
            </div>
          </form>
        </div>
      </div>

      <div className="carrier-signup-right-bg-simple">
        <img src={'/src/assets/blue_bg_signup.svg'} alt="Blue Background" className="carrier-signup-bg-svg" />
        <div className="carrier-signup-img-block">
          <img src={images[currentImg]} alt="Onboarding" className="carrier-signup-img-top-simple"/>
        </div>
        <div className="carrier-signup-info-bottom">
          <div className="carrier-signup-img-indicators" style={{ background: 'transparent', minHeight: '24px', marginBottom: '0', marginTop: '0' }}>
            {images.map((_, idx)=> (
              <span key={idx} onClick={()=> setCurrentImg(idx)} className={ idx === currentImg ? "carrier-signup-dot-active" : "carrier-signup-dot"} style={{ display: 'inline-block', verticalAlign: 'middle', cursor: 'pointer'}} />
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
