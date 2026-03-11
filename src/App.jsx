import { BrowserRouter as Router, Routes, Route, useLocation, Navigate } from 'react-router-dom'
import LandingPage from './components/landing_page/LandingPage'
import HelpCenter from './components/landing_page/HelpCenter'
import RoleSelection from './components/landing_page/RoleSelection'
import Signup from './components/Signup'
import Login from './components/Login'
import AdminSignup from './components/AdminSignup'
import AdminLogin from './components/AdminLogin'
import Verification from './components/verification/Verification'
import AdminVerification from './components/verification/AdminVerification'
import CarrierDashboard from './components/carrier/CarrierDashboard'
import DriverDashboard from './components/driver/DriverDashboard'
import ShipperDashboard from './components/shipper/ShipperDashboard'
import AdminDashboard from './components/admin/AdminDashboard'
import SuperAdminDashboard from './components/super_admin/SuperAdminDashboard'
import SuperAdminLogin from './components/super_admin/SuperAdminLogin'
import SuperAdminProfile from './components/super_admin/SuperAdminProfile'
import CarrierOnboarding from './components/onboarding/CarrierOnboarding'
import DriverOnboarding from './components/onboarding/DriverOnboarding'
import ShipperOnboarding from './components/onboarding/ShipperOnboarding'
import ProtectedRoute from './components/ProtectedRoute'
import './App.css'

import Chatbot from './components/landing_page/Chatbot'
import { useState } from 'react'

// 🛑 ADDED: Import for the Password Reset component 🛑
// BEFORE (Fails, because it looks for the file in the root of 'components'):
// import ForgotPassword from "./components/ForgotPassword"; 

// AFTER (Correct, navigates into the sub-folder):
import ForgotPassword from "./components/forgot-password";

import AI from '/src/assets/chatbot.svg'

function App() {
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMinimized, setChatMinimized] = useState(false)
  return (
    <Router>
      <InnerRoutes chatOpen={chatOpen} chatMinimized={chatMinimized} setChatOpen={setChatOpen} setChatMinimized={setChatMinimized} />
    </Router>
  )
}

function InnerRoutes({ chatOpen, chatMinimized, setChatOpen, setChatMinimized }){
  const location = useLocation()
  const showChat = location.pathname === '/'

  return (
    <>
      {/* persistent chatbot bubble - only show on landing page */}
      {showChat && !chatOpen && !chatMinimized && (
        <div style={{position:'fixed', right:18, bottom:18, zIndex:1200}}>
          <div onClick={() => setChatOpen(s => !s)} style={{width:56,height:56,borderRadius:12,background:'#fff',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 8px 20px rgba(16,24,40,0.12)',cursor:'pointer'}}>
            <img src={AI} alt="AI" style={{width:36,height:36}} />
          </div>
        </div>
      )}
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/help-center" element={<HelpCenter />} />
        <Route path="/faq" element={<HelpCenter />} />
        <Route path="/select-role" element={<RoleSelection />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/login" element={<Login />} />
        {/* Admin auth (canonical paths) */}
        <Route path="/admin/signup" element={<AdminSignup />} />
        <Route path="/admin/login" element={<AdminLogin />} />

        {/* Super admin auth (canonical paths) */}
        <Route path="/super-admin/login" element={<SuperAdminLogin />} />

        <Route path="/super-admin/profile" element={
          <ProtectedRoute allowedRoles={['super_admin']}>
            <SuperAdminProfile />
          </ProtectedRoute>
        } />

        {/* Back-compat admin auth paths */}
        <Route path="/admin-signup" element={<Navigate to="/admin/signup" replace />} />
        <Route path="/admin-login" element={<Navigate to="/admin/login" replace />} />
        
        {/* 🛑 NEW ROUTE ADDED HERE 🛑 */}
        <Route path="/forgot-password" element={<ForgotPassword />} />

        {/* Onboarding Routes - Accessible right after signup */}
        <Route path="/carrier-onboarding" element={<CarrierOnboarding />} />
        <Route path="/driver-onboarding" element={<DriverOnboarding />} />
        <Route path="/shipper-onboarding" element={<ShipperOnboarding />} />

        {/* Protected Onboarding Routes (legacy) */}
        <Route path="/onboarding/carrier" element={
          <ProtectedRoute allowedRoles={['carrier']}>
            <CarrierOnboarding />
          </ProtectedRoute>
        } />
        <Route path="/onboarding/driver" element={
          <ProtectedRoute allowedRoles={['driver']}>
            <DriverOnboarding />
          </ProtectedRoute>
        } />
        <Route path="/onboarding/shipper" element={
          <ProtectedRoute allowedRoles={['shipper']}>
            <ShipperOnboarding />
          </ProtectedRoute>
        } />
        <Route path="/verify" element={<Verification />} />
        {/* Admin verification (canonical + back-compat) */}
        <Route path="/admin/verify" element={<AdminVerification />} />
        <Route path="/admin-verify" element={<Navigate to="/admin/verify" replace />} />

        {/* Protected Dashboard Routes - Require authentication */}
        <Route path="/carrier-dashboard" element={
          <ProtectedRoute allowedRoles={['carrier']}>
            <CarrierDashboard />
          </ProtectedRoute>
        } />
        <Route path="/driver-dashboard" element={
          <ProtectedRoute allowedRoles={['driver']}>
            <DriverDashboard />
          </ProtectedRoute>
        } />
        {/* Admin dashboard routing */}
        <Route path="/admin" element={
          <ProtectedRoute allowedRoles={['admin']}>
            <AdminDashboard />
          </ProtectedRoute>
        } />
        <Route path="/admin/:section" element={
          <ProtectedRoute allowedRoles={['admin']}>
            <AdminDashboard />
          </ProtectedRoute>
        } />

        {/* Super admin dashboard routing (strict: super_admin only) */}
        <Route path="/super-admin" element={<Navigate to="/super-admin/dashboard" replace />} />
        <Route path="/super-admin/:section" element={
          <ProtectedRoute allowedRoles={['super_admin']}>
            <SuperAdminDashboard />
          </ProtectedRoute>
        } />

        {/* Back-compat dashboard paths */}
        <Route path="/admin-dashboard" element={<Navigate to="/admin" replace />} />
        <Route path="/super-admin-dashboard" element={<Navigate to="/super-admin/dashboard" replace />} />
        <Route path="/shipper-dashboard" element={
          <ProtectedRoute allowedRoles={['shipper', 'broker']}>
            <ShipperDashboard />
          </ProtectedRoute>
        } />
      </Routes>
      {showChat && <Chatbot isOpen={chatOpen} onClose={() => setChatOpen(false)} onMinimizeChange={(min)=>{ setChatMinimized(min) }} />}
    </>
  )
}

export default App
