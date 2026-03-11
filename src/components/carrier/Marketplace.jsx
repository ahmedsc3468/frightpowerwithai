import React, { useState, useEffect } from 'react'
import '../../styles/carrier/Marketplace.css'
import '../../styles/carrier/ServicesPage.css'
import { useAuth } from '../../contexts/AuthContext'
import { API_URL } from '../../config'
import { AUTO_REFRESH_MS } from '../../constants/refresh'
import MapSnapshot from '../common/MapSnapshot'
import RouteMap from '../common/RouteMap'

// Minimum onboarding score required to access marketplace
const MARKETPLACE_THRESHOLD = 60
const ACCESS_CACHE_PREFIX = 'fp_carrier_marketplace_access_v1:'

function readAccessCache(uid) {
  if (!uid) return null
  try {
    const raw = sessionStorage.getItem(`${ACCESS_CACHE_PREFIX}${uid}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const ts = Number(parsed.ts || 0)
    if (!ts || (Date.now() - ts) > AUTO_REFRESH_MS) return null
    return parsed
  } catch {
    return null
  }
}

function writeAccessCache(uid, data) {
  if (!uid) return
  try {
    sessionStorage.setItem(`${ACCESS_CACHE_PREFIX}${uid}`, JSON.stringify({ ts: Date.now(), ...(data || {}) }))
  } catch {
    // ignore
  }
}

export default function Marketplace({ activeSection, setActiveSection: _setActiveSection }) {
  const { currentUser } = useAuth()
  const cachedAccess = readAccessCache(currentUser?.uid)
  const [activeTab, setActiveTab] = useState(activeSection || 'loads') // loads | drivers | services
  const [searchQuery, setSearchQuery] = useState('')
  const [equipmentType, setEquipmentType] = useState('')
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [dateRange, setDateRange] = useState('')
  const [distance, setDistance] = useState('')
  const [serviceTab, setServiceTab] = useState('all')
  const [showSidebar, setShowSidebar] = useState(true)
  const [isMobile, setIsMobile] = useState(false)

  // Marketplace gating state
  const [isMarketplaceReady, setIsMarketplaceReady] = useState(() => cachedAccess?.isMarketplaceReady ?? true)
  const [onboardingScore, setOnboardingScore] = useState(() => cachedAccess?.onboardingScore ?? 100)
  const [nextActions, setNextActions] = useState(() => cachedAccess?.nextActions ?? [])
  const [checkingAccess, setCheckingAccess] = useState(() => (currentUser ? !cachedAccess : true))
  const [consentEligible, setConsentEligible] = useState(() => cachedAccess?.consentEligible ?? true)
  const [missingConsents, setMissingConsents] = useState(() => cachedAccess?.missingConsents ?? [])
  const [gatingReason, setGatingReason] = useState(() => cachedAccess?.gatingReason ?? '')

  // Real-time marketplace loads from shippers
  const [loads, setLoads] = useState([])
  const [_loadsLoading, setLoadsLoading] = useState(false)

  // Drivers state
  const [drivers, setDrivers] = useState([])
  const [driversLoading, setDriversLoading] = useState(false)
  const [hiringDriver, setHiringDriver] = useState(null)

  // Bidding state
  const [bidModalOpen, setBidModalOpen] = useState(false)
  const [detailsModalOpen, setDetailsModalOpen] = useState(false)
  const [selectedLoad, setSelectedLoad] = useState(null)
  const [bidRate, setBidRate] = useState('')
  const [bidNotes, setBidNotes] = useState('')
  const [bidEta, setBidEta] = useState('')
  const [submittingBid, setSubmittingBid] = useState(false)
  
  // Map popup state
  const [hoveredLoadId, setHoveredLoadId] = useState(null)
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 })
  const [hoverRouteByLoadId, setHoverRouteByLoadId] = useState({})

  const getTruckTypeFromEquipmentLabel = (label) => {
    const normalized = String(label || '').toLowerCase();
    if (normalized.includes('reefer')) return 'reefer';
    if (normalized.includes('flat')) return 'flatbed';
    if (normalized.includes('step')) return 'stepdeck';
    if (normalized.includes('power')) return 'powerOnly';
    return 'dryVan';
  }

  // Check onboarding status AND consent eligibility to gate marketplace
  useEffect(() => {
    const checkMarketplaceAccess = async () => {
      if (!currentUser) {
        setCheckingAccess(false)
        return
      }

      const fresh = readAccessCache(currentUser.uid)
      if (fresh) {
        setIsMarketplaceReady(Boolean(fresh.isMarketplaceReady))
        setOnboardingScore(Number(fresh.onboardingScore ?? 0))
        setNextActions(Array.isArray(fresh.nextActions) ? fresh.nextActions : [])
        setConsentEligible(Boolean(fresh.consentEligible))
        setMissingConsents(Array.isArray(fresh.missingConsents) ? fresh.missingConsents : [])
        setGatingReason(String(fresh.gatingReason || ''))
        setCheckingAccess(false)
        return
      }

      setCheckingAccess(true)

      try {
        const token = await currentUser.getIdToken()

        let scoreValue = 0
        let nextActionsValue = []
        let consentsEligibleValue = true
        let missingConsentsValue = []

        // Check onboarding score
        const onboardingResponse = await fetch(`${API_URL}/onboarding/coach-status`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        })

        let scoreOk = true
        if (onboardingResponse.ok) {
          const data = await onboardingResponse.json()
          const score = data.total_score || 0
          scoreValue = score
          nextActionsValue = data.next_best_actions || []
          setOnboardingScore(score)
          scoreOk = score >= MARKETPLACE_THRESHOLD
          setNextActions(nextActionsValue)
        }

        // Check consent eligibility
        const consentResponse = await fetch(`${API_URL}/consents/marketplace-eligibility`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        })

        let consentsOk = true
        if (consentResponse.ok) {
          const consentData = await consentResponse.json()
          consentsOk = consentData.eligible
          consentsEligibleValue = consentData.eligible
          missingConsentsValue = consentData.missing_consents || []
          setConsentEligible(consentsEligibleValue)
          setMissingConsents(missingConsentsValue)
        }

        // Determine gating reason
        const gating = (!scoreOk && !consentsOk) ? 'both' : (!scoreOk ? 'score' : (!consentsOk ? 'consent' : ''))
        if (gating) setGatingReason(gating)

        const ready = scoreOk && consentsOk
        setIsMarketplaceReady(ready)

        writeAccessCache(currentUser.uid, {
          isMarketplaceReady: ready,
          onboardingScore: Number(scoreValue || 0),
          nextActions: Array.isArray(nextActionsValue) ? nextActionsValue : [],
          consentEligible: Boolean(consentsEligibleValue),
          missingConsents: Array.isArray(missingConsentsValue) ? missingConsentsValue : [],
          gatingReason: gating,
        })
      } catch (error) {
        console.error('Error checking marketplace access:', error)
        // Allow access if check fails (graceful degradation)
        setIsMarketplaceReady(true)

        writeAccessCache(currentUser.uid, {
          isMarketplaceReady: true,
          onboardingScore: Number(onboardingScore || 0),
          nextActions: Array.isArray(nextActions) ? nextActions : [],
          consentEligible: true,
          missingConsents: [],
          gatingReason: '',
        })
      } finally {
        setCheckingAccess(false)
      }
    }

    checkMarketplaceAccess()
  }, [currentUser])

  // Sync activeTab when activeSection prop changes
  useEffect(() => {
    if (activeSection) {
      setActiveTab(activeSection)
    }
  }, [activeSection])

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth <= 1024) {
        setIsMobile(true)
        setShowSidebar(false)
      } else {
        setIsMobile(false)
        setShowSidebar(true)
      }
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Fetch marketplace loads (shipper-posted loads for carriers)
  const fetchMarketplaceLoads = async () => {
    if (!currentUser || !isMarketplaceReady) return

    setLoadsLoading(true)
    try {
      const token = await currentUser.getIdToken()
      const response = await fetch(`${API_URL}/marketplace/loads`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      if (response.ok) {
        const data = await response.json()
        // Convert backend loads to UI format
        const formattedLoads = (data.loads || []).map(load => {
          // Format load type
          let loadTypeDisplay = 'FTL'
          if (load.load_type) {
            if (load.load_type === 'Full Truckload' || load.load_type === 'FTL') {
              loadTypeDisplay = 'FTL'
            } else if (load.load_type === 'LTL') {
              loadTypeDisplay = 'LTL'
            } else if (load.load_type === 'Multi-Stop') {
              loadTypeDisplay = 'Multi-Stop'
            } else {
              loadTypeDisplay = load.load_type
            }
          }
          
          // Format weight
          const weightDisplay = load.weight ? `${load.weight.toLocaleString()} lbs` : 'N/A'
          
          // Format price - check multiple rate fields (total_rate, linehaul_rate, rate)
          let priceValue = null
          if (load.total_rate) {
            priceValue = typeof load.total_rate === 'number' ? load.total_rate : parseFloat(load.total_rate)
          } else if (load.linehaul_rate) {
            priceValue = typeof load.linehaul_rate === 'number' ? load.linehaul_rate : parseFloat(load.linehaul_rate)
          } else if (load.rate) {
            priceValue = typeof load.rate === 'number' ? load.rate : parseFloat(load.rate)
          }
          
          // Only show "Negotiable" if no rate is available at all
          const priceDisplay = priceValue !== null && !isNaN(priceValue) && priceValue > 0 
            ? `$${priceValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : null // Don't show "Negotiable", just don't display price
          
          return {
            id: load.load_id,
            origin: load.origin || 'N/A',
            destination: load.destination || 'N/A',
            pickupDate: load.pickup_date || 'TBD',
            deliveryDate: load.delivery_date ? `Delivery: ${load.delivery_date}` : 'TBD',
            rate: priceDisplay, // Will be null if no rate, so we can conditionally render
            hasPrice: priceDisplay !== null,
            perMile: load.rate_per_mile ? `$${load.rate_per_mile}/mile` : 'N/A',
            status: load.status || 'posted',
            postedTime: load.created_at ? formatTimeAgo(load.created_at) : 'Recently posted',
            carrier: load.equipment_type || 'Dry Van',
            distance: load.distance ? `${load.distance} miles` : 'N/A',
            urgency: load.urgency || 'normal',
            weight: weightDisplay,
            loadType: loadTypeDisplay,
            load_type: load.load_type, // Keep original for compatibility
            // Add offer tracking
            offers: load.offers || [],
            myOffer: (load.offers || []).find(o => o.carrier_id === currentUser?.uid),
            additional_routes: load.additional_routes || [],
            // Add coordinate data for map
            origin_lat: load.origin_lat,
            origin_lng: load.origin_lng,
            destination_lat: load.destination_lat,
            destination_lng: load.destination_lng
          }
        })
        setLoads(formattedLoads)
      }
    } catch (error) {
      console.error('Error fetching marketplace loads:', error)
      setLoads([]) // Show empty on error
    } finally {
      setLoadsLoading(false)
    }
  }

  useEffect(() => {
    fetchMarketplaceLoads()
  }, [currentUser, isMarketplaceReady])

  // Fetch marketplace drivers
  const fetchMarketplaceDrivers = async () => {
    if (!currentUser || !isMarketplaceReady) return

    setDriversLoading(true)
    try {
      const token = await currentUser.getIdToken()
      const response = await fetch(`${API_URL}/drivers?available_only=true`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      if (response.ok) {
        const data = await response.json()
        // Format drivers for UI
        const formattedDrivers = (data.drivers || []).map(driver => {
          // Build endorsements array
          const endorsements = []
          if (driver.hazmat_endorsement) endorsements.push('Hazmat')
          if (driver.tanker_endorsement) endorsements.push('Tanker')
          if (driver.doubles_triples) endorsements.push('Double/Triple')
          if (driver.passenger_endorsement) endorsements.push('Passenger')
          if (endorsements.length === 0) endorsements.push('None')

          // Build equipment/compliance tags
          const equipmentTypes = []
          if (driver.cdl_verified) equipmentTypes.push('CDL Valid')
          if (driver.medical_card_verified) equipmentTypes.push('Med Card Active')
          if (driver.drug_test_status === 'passed') equipmentTypes.push('MVR Clean')

          return {
            id: driver.id || driver.driver_id,
            name: driver.name || 'Unknown Driver',
            rating: driver.rating || 0,
            trips: driver.total_deliveries || driver.total_loads || 0,
            class: driver.cdl_class ? `${driver.cdl_class} - ${driver.cdl_state || ''}` : 'N/A',
            location: driver.current_location || driver.current_city || 'Unknown',
            experience: driver.years_experience ? `${driver.years_experience} years` : 'N/A',
            endorsements: endorsements,
            safetyScore: driver.safety_score || 0,
            onTime: driver.on_time_rate ? driver.on_time_rate >= 0.95 : false,
            available: driver.status === 'available',
            photo: `https://ui-avatars.com/api/?name=${encodeURIComponent(driver.name || 'Driver')}&background=random`,
            lastActivity: 'Recently active',
            equipmentTypes: equipmentTypes.length > 0 ? equipmentTypes : ['Pending Verification']
          }
        })
        setDrivers(formattedDrivers)
      }
    } catch (error) {
      console.error('Error fetching marketplace drivers:', error)
      setDrivers([])
    } finally {
      setDriversLoading(false)
    }
  }

  // Hire a driver
  const handleHireDriver = async (driver) => {
    if (!currentUser) return

    setHiringDriver(driver.id)
    try {
      const token = await currentUser.getIdToken()
      const response = await fetch(`${API_URL}/drivers/${driver.id}/hire`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      if (response.ok) {
        // Remove driver from list (since they're now hired)
        setDrivers(drivers.filter(d => d.id !== driver.id))
        alert(`Successfully hired ${driver.name}!`)
      } else {
        const error = await response.json()
        alert(`Failed to hire driver: ${error.detail || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Error hiring driver:', error)
      alert('Failed to hire driver. Please try again.')
    } finally {
      setHiringDriver(null)
    }
  }

  // Fetch drivers when drivers tab is active
  useEffect(() => {
    if (activeTab === 'drivers' && isMarketplaceReady) {
      fetchMarketplaceDrivers()
    }
  }, [activeTab, currentUser, isMarketplaceReady])

  // Open bid modal
  const handleOpenBidModal = (load) => {
    setSelectedLoad(load)
    setBidRate(load.rate.replace('$', '').replace(',', '') || '')
    setBidNotes('')
    setBidEta('')
    setBidModalOpen(true)
  }

  // Open details modal
  const handleOpenDetailsModal = async (load) => {
    if (!currentUser) return;
    
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/loads/${load.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        // Merge the detailed load data with the existing load data
        const detailedLoad = {
          ...load,
          ...data.load,
          // Map backend fields to frontend format
          pickup_city: data.load.origin_city || data.load.origin?.split(',')[0] || load.origin?.split(',')[0] || '',
          pickup_state: data.load.origin_state || data.load.origin?.split(',')[1]?.trim() || '',
          pickup_zip: data.load.origin_zip || '',
          delivery_city: data.load.destination_city || data.load.destination?.split(',')[0] || load.destination?.split(',')[0] || '',
          delivery_state: data.load.destination_state || data.load.destination?.split(',')[1]?.trim() || '',
          delivery_zip: data.load.destination_zip || '',
          pickup_date: data.load.pickup_date || load.pickupDate,
          delivery_date: data.load.delivery_date || load.deliveryDate,
          equipment_type: data.load.equipment_type || load.carrier,
          weight: data.load.weight || '',
          distance: data.load.miles || data.load.distance || load.distance,
          rate: data.load.rate || load.rate?.replace('$', '').replace(',', '') || '',
          special_instructions: data.load.special_instructions || data.load.notes || '',
          // Additional stops/routes with dates
          additional_stops: data.load.additional_stops || data.load.additional_routes || [],
          additional_routes: data.load.additional_routes || data.load.additional_stops || [],
          // Shipper information
          shipper_info: data.load.shipper_info || {},
          shipper_company_name: data.load.shipper_company_name || data.load.shipper_info?.company_name || '',
          shipper_compliance_score: data.load.shipper_compliance_score !== undefined ? data.load.shipper_compliance_score : null,
          // Total distance and price
          total_distance: data.load.total_distance || data.load.estimated_distance || data.load.miles || data.load.distance || null,
          total_price: data.load.total_price || data.load.total_rate || data.load.linehaul_rate || data.load.rate || null
        };
        setSelectedLoad(detailedLoad);
        setDetailsModalOpen(true);
      } else {
        // If we can't fetch details, still show the modal with available data
        setSelectedLoad(load);
        setDetailsModalOpen(true);
      }
    } catch (error) {
      console.error('Error fetching load details:', error);
      // Still show modal with available data
      setSelectedLoad(load);
      setDetailsModalOpen(true);
    }
  }

  // Submit bid
  const handleSubmitBid = async () => {
    if (!selectedLoad || !bidRate) {
      alert('Please enter a bid rate')
      return
    }

    setSubmittingBid(true)
    try {
      const token = await currentUser.getIdToken()
      const response = await fetch(`${API_URL}/loads/${selectedLoad.id}/tender-offer`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          rate: parseFloat(bidRate),
          notes: bidNotes || '',
          eta: bidEta || ''
        })
      })

      if (response.ok) {
        const _data = await response.json()
        alert('Bid submitted successfully!')
        setBidModalOpen(false)
        // Refresh loads to show new bid status
        await fetchMarketplaceLoads()
      } else {
        const error = await response.json()
        alert(`Failed to submit bid: ${error.detail || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Error submitting bid:', error)
      alert('Failed to submit bid. Please try again.')
    } finally {
      setSubmittingBid(false)
    }
  }

  // Helper function to format timestamp
  const formatTimeAgo = (timestamp) => {
    const now = Date.now() / 1000
    const diff = now - timestamp
    const hours = Math.floor(diff / 3600)
    if (hours < 1) return 'Posted < 1h ago'
    if (hours === 1) return 'Posted 1h ago'
    return `Posted ${hours}h ago`
  }

  // Show loading state while checking access
  if (checkingAccess) {
    return (
      <div className="marketplace-loading" style={{ padding: '40px', textAlign: 'center' }}>
        <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
        <p style={{ marginTop: '10px', color: '#64748b' }}>Checking marketplace access...</p>
      </div>
    )
  }

  // Show gating message if onboarding not complete or consents missing
  if (!isMarketplaceReady) {
    return (
      <div className="marketplace-gated" style={{
        padding: '60px 40px',
        textAlign: 'center',
        background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
        borderRadius: '16px',
        margin: '20px',
        border: '1px solid #e2e8f0'
      }}>
        <div style={{
          width: '80px',
          height: '80px',
          background: '#fef3c7',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 20px'
        }}>
          <i className="fa-solid fa-lock" style={{ fontSize: '2rem', color: '#f59e0b' }}></i>
        </div>

        <h2 style={{ fontSize: '1.75rem', color: '#1e293b', marginBottom: '10px' }}>
          Marketplace Access Locked
        </h2>

        <p style={{ color: '#64748b', marginBottom: '20px', maxWidth: '500px', margin: '0 auto 20px' }}>
          {gatingReason === 'consent'
            ? 'You must sign all required consent forms to access the marketplace.'
            : gatingReason === 'both'
            ? 'Complete your onboarding and sign required consent forms to unlock the marketplace.'
            : `Complete your onboarding to unlock the marketplace. You need a score of at least ${MARKETPLACE_THRESHOLD}% to access loads, drivers, and services.`
          }
        </p>

        {/* Show missing consents if applicable */}
        {!consentEligible && missingConsents.length > 0 && (
          <div style={{
            background: '#fef2f2',
            padding: '15px 20px',
            borderRadius: '12px',
            maxWidth: '400px',
            margin: '0 auto 20px',
            border: '1px solid #fecaca'
          }}>
            <div style={{ fontWeight: '600', color: '#dc2626', marginBottom: '10px' }}>
              <i className="fa-solid fa-file-signature" style={{ marginRight: '8px' }}></i>
              Missing Required Consents
            </div>
            <ul style={{ textAlign: 'left', margin: 0, paddingLeft: '20px', color: '#7f1d1d' }}>
              {missingConsents.map((consent, idx) => (
                <li key={idx} style={{ marginBottom: '5px' }}>
                  {consent.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </li>
              ))}
            </ul>
            <button
              onClick={() => window.location.href = '/carrier/consent'}
              style={{
                marginTop: '15px',
                padding: '10px 20px',
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Sign Consent Forms
            </button>
          </div>
        )}

        {/* Show onboarding score if applicable */}
        {(gatingReason === 'score' || gatingReason === 'both') && (
        <div style={{
          background: '#fff',
          padding: '20px',
          borderRadius: '12px',
          maxWidth: '400px',
          margin: '0 auto 30px',
          boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px', marginBottom: '15px' }}>
            <div style={{
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              background: onboardingScore >= 50 ? '#fef3c7' : '#fee2e2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.25rem',
              fontWeight: 'bold',
              color: onboardingScore >= 50 ? '#f59e0b' : '#ef4444'
            }}>
              {onboardingScore}%
            </div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: '600', color: '#1e293b' }}>Current Score</div>
              <div style={{ color: '#64748b', fontSize: '0.875rem' }}>
                Need {MARKETPLACE_THRESHOLD - onboardingScore}% more to unlock
              </div>
            </div>
          </div>

          <div style={{
            background: '#f1f5f9',
            height: '8px',
            borderRadius: '4px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${onboardingScore}%`,
              height: '100%',
              background: onboardingScore >= 50 ? '#f59e0b' : '#ef4444',
              borderRadius: '4px',
              transition: 'width 0.5s ease'
            }}></div>
          </div>
        </div>
        )}

        {nextActions.length > 0 && (
          <div style={{ textAlign: 'left', maxWidth: '400px', margin: '0 auto' }}>
            <h4 style={{ color: '#1e293b', marginBottom: '10px' }}>
              <i className="fa-solid fa-list-check" style={{ marginRight: '8px', color: '#3b82f6' }}></i>
              Complete These Steps:
            </h4>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {nextActions.slice(0, 3).map((action, index) => (
                <li key={index} style={{
                  padding: '10px 15px',
                  background: '#fff',
                  borderRadius: '8px',
                  marginBottom: '8px',
                  border: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px'
                }}>
                  <span style={{
                    width: '24px',
                    height: '24px',
                    background: '#3b82f6',
                    color: '#fff',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 'bold'
                  }}>
                    {index + 1}
                  </span>
                  <span style={{ color: '#475569' }}>{action}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={() => window.location.href = '/carrier-dashboard'}
          style={{
            marginTop: '30px',
            padding: '12px 24px',
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontWeight: '600',
            cursor: 'pointer',
            fontSize: '1rem'
          }}
        >
          <i className="fa-solid fa-arrow-left" style={{ marginRight: '8px' }}></i>
          Go to Dashboard
        </button>
      </div>
    )
  }


  return (
    <div className="marketplace">
      <header className="marketplace-header">
        <div className="marketplace-header-content">
          <h1>Marketplace</h1>
          <p className="marketplace-subtitle">Find loads, hire drivers, and connect with service providers</p>
        </div>
      </header>

      {/* Tabs Navigation */}
      <div className="marketplace-nav">
        <div className="marketplace-tabs">
          <button
            className={`marketplace-tab ${activeTab === 'loads' ? 'active' : ''}`}
            onClick={() => setActiveTab('loads')}
          >
            Loads
          </button>
          <button
            className={`marketplace-tab ${activeTab === 'drivers' ? 'active' : ''}`}
            onClick={() => setActiveTab('drivers')}
          >
            Drivers
          </button>
          <button
            className={`marketplace-tab ${activeTab === 'services' ? 'active' : ''}`}
            onClick={() => setActiveTab('services')}
          >
            Services
          </button>
        </div>
      </div>

      {/* Search and Filters - Only show on Loads tab */}
      {activeTab === 'loads' && (
        <div className="marketplace-controls">
          <div className="marketplace-inner">
            <div className="search-section">
          <div className="search-input-container">
            <i className="fa-solid fa-search search-icon" />
            <input
              type="text"
              className="marketplace-search"
              placeholder="Search loads, drivers, or services..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button className="btn small-cd">
              <i className="fa-solid fa-search" />
              Search
            </button>
          </div>
        </div>

        <div className="filters-section">
          <select
            className="marketplace-filter-select"
            value={equipmentType}
            onChange={(e) => setEquipmentType(e.target.value)}
          >
            <option value="">Equipment Type</option>
            <option value="dry-van">Dry Van</option>
            <option value="reefer">Reefer</option>
            <option value="flatbed">Flatbed</option>
          </select>

          <input
            type="text"
            className="marketplace-filter-input"
            placeholder="Origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />

          <input
            type="text"
            className="marketplace-filter-input"
            placeholder="Destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />

          <input
            type="text"
            className="marketplace-filter-input"
            placeholder="mm/dd/yyyy"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
          />

          <select
            className="marketplace-filter-select"
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
          >
            <option value="">Distance</option>
            <option value="0-100">0-100 miles</option>
            <option value="100-500">100-500 miles</option>
            <option value="500+">500+ miles</option>
          </select>
            </div>
          </div>
        </div>
      )}

      {/* Loads Content */}
      {activeTab === 'loads' && (
        <div className="loads-grid">
          {loads.filter(load => {
            // Search filter
            const searchLower = searchQuery.toLowerCase();
            const matchesSearch = !searchQuery || 
              load.origin?.toLowerCase().includes(searchLower) ||
              load.destination?.toLowerCase().includes(searchLower) ||
              load.carrier?.toLowerCase().includes(searchLower) ||
              load.loadType?.toLowerCase().includes(searchLower) ||
              load.id?.toString().toLowerCase().includes(searchLower);

            // Equipment type filter
            const matchesEquipment = !equipmentType || 
              load.carrier?.toLowerCase().includes(equipmentType.toLowerCase()) ||
              (equipmentType === 'dry-van' && (load.carrier?.toLowerCase().includes('dry') || load.carrier?.toLowerCase().includes('van'))) ||
              (equipmentType === 'reefer' && load.carrier?.toLowerCase().includes('reefer')) ||
              (equipmentType === 'flatbed' && load.carrier?.toLowerCase().includes('flatbed'));

            // Origin filter
            const matchesOrigin = !origin || 
              load.origin?.toLowerCase().includes(origin.toLowerCase());

            // Destination filter
            const matchesDestination = !destination || 
              load.destination?.toLowerCase().includes(destination.toLowerCase());

            // Distance filter
            let matchesDistance = true;
            if (distance) {
              const loadDistance = parseFloat(load.distance?.replace(' miles', '').replace(',', '') || '0');
              if (distance === '0-100') {
                matchesDistance = loadDistance >= 0 && loadDistance <= 100;
              } else if (distance === '100-500') {
                matchesDistance = loadDistance > 100 && loadDistance <= 500;
              } else if (distance === '500+') {
                matchesDistance = loadDistance > 500;
              }
            }

            // Date range filter (basic implementation)
            const matchesDate = !dateRange || 
              load.pickupDate?.toLowerCase().includes(dateRange.toLowerCase()) ||
              load.deliveryDate?.toLowerCase().includes(dateRange.toLowerCase());

            return matchesSearch && matchesEquipment && matchesOrigin && matchesDestination && matchesDistance && matchesDate;
          }).map(load => (
            <div key={load.id} className={`load-card ${load.urgency === 'urgent' ? 'urgent' : ''}`}>
              <div className="load-card-header">
                <div className="route-info">
                  <div className="route-cities">
                    <span className="origin">{load.origin}</span>
                    <i className="fa-solid fa-arrow-right route-arrow" />
                    <span className="destination">{load.destination}</span>
                    <div 
                      className="location-icon-wrapper"
                      onMouseEnter={(e) => {
                        if (load.origin && load.destination && load.origin !== 'N/A' && load.destination !== 'N/A') {
                          const rect = e.currentTarget.getBoundingClientRect()
                          const popupWidth = 400
                          const popupHeight = 360
                          const margin = 10
                          
                          // Calculate position, adjusting if it would go off-screen
                          let x = rect.left
                          let y = rect.top + rect.height + margin
                          
                          // Adjust if popup would go off right edge
                          if (x + popupWidth > window.innerWidth) {
                            x = window.innerWidth - popupWidth - margin
                          }
                          
                          // Adjust if popup would go off left edge
                          if (x < margin) {
                            x = margin
                          }
                          
                          // Adjust if popup would go off bottom edge (show above instead)
                          if (y + popupHeight > window.innerHeight) {
                            y = rect.top - popupHeight - margin
                          }
                          
                          // Ensure popup doesn't go off top edge
                          if (y < margin) {
                            y = margin
                          }
                          
                          setPopupPosition({ x, y })
                          setHoveredLoadId(load.id)
                        }
                      }}
                      onMouseLeave={() => {
                        // Don't close immediately - let the popup's onMouseEnter handle it
                      }}
                    >
                      <i className="fa-solid fa-location-dot location-icon" title="View route on map" />
                      {hoveredLoadId === load.id && (
                        <div 
                          className="map-popup"
                          style={{
                            position: 'fixed',
                            left: `${popupPosition.x}px`,
                            top: `${popupPosition.y}px`,
                            zIndex: 10000
                          }}
                          onMouseEnter={() => setHoveredLoadId(load.id)}
                          onMouseLeave={() => setHoveredLoadId(null)}
                        >
                          <div className="map-popup-content">
                            <div className="map-popup-header">
                              <span>
                                {load.origin} → {load.destination}
                                {hoverRouteByLoadId?.[load.id]?.distance_miles != null && (
                                  <> • {Number(hoverRouteByLoadId[load.id].distance_miles).toFixed(1)} mi</>
                                )}
                              </span>
                              <button 
                                className="map-popup-close"
                                onClick={() => setHoveredLoadId(null)}
                                aria-label="Close map"
                              >
                                ×
                              </button>
                            </div>
                            <div className="map-popup-body">
                              <RouteMap
                                origin={load.origin}
                                destination={load.destination}
                                waypoints={load.additional_routes?.map(r => r.location) || []}
                                truckType={getTruckTypeFromEquipmentLabel(load.carrier)}
                                height="300px"
                                width="400px"
                                onRouteCalculated={(data) => {
                                  setHoverRouteByLoadId((prev) => ({
                                    ...prev,
                                    [load.id]: data
                                  }))
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="route-meta">
                    <span className="pickup-date">{load.pickupDate}</span>
                    <span className="delivery-date">{load.deliveryDate}</span>
                  </div>
                </div>
                <div className={`status-badge status-${load.status.toLowerCase()}`}>
                  {load.status}
                </div>
              </div>

              <div className="load-details">
                <div className="load-rate">
                  {load.hasPrice ? (
                    <div className="rate-amount">{load.rate}</div>
                  ) : (
                    <div className="rate-amount" style={{ color: '#9ca3af', fontSize: '14px' }}>Rate not specified</div>
                  )}
                  {load.perMile !== 'N/A' && (
                    <div className="rate-per-mile">{load.perMile}</div>
                  )}
                </div>
                <div className="load-meta">
                  <div className="carrier-info">
                    <i className="fa-solid fa-truck" />
                    {load.carrier}
                  </div>
                  <div className="distance-info">
                    <i className="fa-solid fa-route" />
                    {load.distance}
                  </div>
                  {load.weight && load.weight !== 'N/A' && (
                    <div className="weight-info" style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      color: '#6b7280'
                    }}>
                      <i className="fa-solid fa-weight-hanging" />
                      {load.weight}
                    </div>
                  )}
                  {load.loadType && (
                    <div className="load-type-badge" style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: '600',
                      background: load.loadType === 'FTL' ? '#dbeafe' : load.loadType === 'LTL' ? '#fef3c7' : '#e0e7ff',
                      color: load.loadType === 'FTL' ? '#1e40af' : load.loadType === 'LTL' ? '#92400e' : '#3730a3'
                    }}>
                      {load.loadType}
                    </div>
                  )}
                  {load.additional_routes && load.additional_routes.length > 0 && (
                    <div style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: '600',
                      background: '#e0e7ff',
                      color: '#3730a3',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}>
                      <i className="fa-solid fa-route"></i>
                      +{load.additional_routes.length} stops
                    </div>
                  )}
                </div>
              </div>

              <div className="load-actions">
                {load.myOffer ? (
                  <>
                    <div className="my-offer-status" style={{
                      padding: '10px',
                      background: load.myOffer.status === 'accepted' ? '#10b981' : 
                                 load.myOffer.status === 'rejected' ? '#ef4444' : '#3b82f6',
                      color: 'white',
                      borderRadius: '8px',
                      textAlign: 'center',
                      fontSize: '14px',
                      fontWeight: '500',
                      marginBottom: '8px'
                    }}>
                      {load.myOffer.status === 'accepted' ? '✓ Bid Accepted' :
                       load.myOffer.status === 'rejected' ? '✗ Bid Rejected' :
                       '⏳ Bid Request Sent'}
                    </div>
                    <button 
                      className="btn small ghost-cd" 
                      style={{width: '100%'}}
                      onClick={() => handleOpenDetailsModal(load)}
                    >
                      View Details
                    </button>
                  </>
                ) : (
                  <>
                    <button 
                      className="btn small-cd" 
                      style={{width: '100%'}}
                      onClick={() => handleOpenBidModal(load)}
                    >
                      Submit Bid
                    </button>
                    <button 
                      className="btn small ghost-cd" 
                      style={{width: '100%'}}
                      onClick={() => handleOpenDetailsModal(load)}
                    >
                      View Details
                    </button>
                  </>
                )}
              </div>

              <div className="posted-time">{load.postedTime}</div>
            </div>
          ))}
        </div>
      )}

      {/* Drivers Content */}
      {activeTab === 'drivers' && (
        <div className="drivers-content">

          <div className="marketplace-drivers-filters">
            <div className="marketplace-filters-top-row">
              <div className="marketplace-filter-group">
                <label className="marketplace-filter-label">Location & Radius</label>
                <div className="marketplace-location-inputs">
                  <input 
                    className="marketplace-filter-input marketplace-location-input" 
                    placeholder="City, State or ZIP"
                    value=""
                    onChange={() => {}}
                  />
                  <select className="marketplace-filter-select marketplace-radius-select">
                    <option>25 miles</option>
                    <option>50 miles</option>
                    <option>100 miles</option>
                  </select>
                </div>
              </div>
              
              <div className="marketplace-filter-group">
                <label className="marketplace-filter-label">CDL Class</label>
                <select className="marketplace-filter-select">
                  <option>All Classes</option>
                  <option>CDL Class A</option>
                  <option>CDL Class B</option>
                  <option>CDL Class C</option>
                </select>
              </div>
              
              <div className="marketplace-filter-group">
                <label className="marketplace-filter-label">Status</label>
                <select className="marketplace-filter-select">
                  <option>All Status</option>
                  <option>Available</option>
                  <option>Assigned</option>
                  <option>Off Duty</option>
                </select>
              </div>
              
              <div className="marketplace-filter-group">
                <label className="marketplace-filter-label">Compliance</label>
                <select className="marketplace-filter-select">
                  <option>All</option>
                  <option>Compliant</option>
                  <option>Non-Compliant</option>
                </select>
              </div>
            </div>
            
            <div className="marketplace-endorsements-row">
              <span className="marketplace-filter-label">Endorsements</span>
              <div className="marketplace-endorsement-chips">
                <button className="marketplace-endorsement-chip">Hazmat</button>
                <button className="marketplace-endorsement-chip">Tanker</button>
                <button className="marketplace-endorsement-chip marketplace-selected">Double/Triple</button>
                <button className="marketplace-endorsement-chip">Passenger</button>
                <button className="marketplace-endorsement-chip">School Bus</button>
              </div>
            </div>
          </div>
          
          <div className="marketplace-drivers-results-bar">
            <div className="marketplace-results-count">1,247 drivers found</div>
            <div className="marketplace-results-controls">
              <div className="marketplace-sort-group">
                <label>Sort by:</label>
                <select className="marketplace-sort-select">
                  <option>Relevance</option>
                  <option>Rating</option>
                  <option>Experience</option>
                  <option>Location</option>
                </select>
              </div>
            </div>
          </div>

          <div className="drivers-actions">
          <button className="btn small ghost-cd">
            <i className="fa-solid fa-download"></i> Export
          </button>
          <button className="btn small-cd">
            <i className="fa-solid fa-plus"></i> Post Driver Request
          </button>
            </div>

          {driversLoading ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', marginRight: '10px' }}></i>
              Loading drivers...
            </div>
          ) : drivers.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
              <i className="fa-solid fa-users" style={{ fontSize: '48px', marginBottom: '20px', opacity: 0.5 }}></i>
              <p>No available drivers found</p>
            </div>
          ) : (
          <div className="marketplace-drivers-list">
            {drivers.map(driver => (
              <div key={driver.id} className="marketplace-driver-card">
                <div className="marketplace-driver-header">
                  <div className="marketplace-driver-left">
                    <div className="marketplace-driver-avatar">
                      <img src={driver.photo} alt={driver.name} />
                    </div>
                    <div className="marketplace-driver-info">
                      <div className="marketplace-driver-name-row">
                        <h3 className="marketplace-driver-name">{driver.name}</h3>
                        <div className="marketplace-driver-rating">
                          <i className="fa-solid fa-star" />
                          <span>{driver.rating}</span>
                          <span className="marketplace-trips-count">• {driver.trips} trips</span>
                        </div>
                      </div>
                      
                      <div className="marketplace-driver-details">
                        <div className="marketplace-detail-item">
                          <span className="marketplace-detail-label">CDL INFO</span>
                          <span className="marketplace-detail-value">Class {driver.class}</span>
                          <span className="marketplace-detail-sub">Exp: 03/2025</span>
                        </div>
                        
                        <div className="marketplace-detail-item">
                          <span className="marketplace-detail-label">LOCATION</span>
                          <span className="marketplace-detail-value">{driver.location}</span>
                          <span className="marketplace-detail-sub">{driver.lastActivity}</span>
                        </div>
                        
                        <div className="marketplace-detail-item">
                          <span className="marketplace-detail-label">STATUS</span>
                          <span className={`marketplace-detail-value marketplace-status-${driver.available ? 'available' : 'unavailable'}`}>
                            <i className="fa-solid fa-circle" />
                            {driver.available ? 'Available' : 'Not Available'}
                          </span>
                        </div>
                        
                        <div className="marketplace-detail-item">
                          <span className="marketplace-detail-label">AI SAFETY SCORE</span>
                          <span className="marketplace-detail-value marketplace-safety-score">
                            {driver.safetyScore}/100
                          </span>
                        </div>
                      </div>

                      <div className="marketplace-driver-tags">
                        <div className="marketplace-endorsements">
                          <span className="marketplace-tags-label">Endorsements:</span>
                          {driver.endorsements.map((endorsement, index) => (
                            <span key={index} className="marketplace-endorsement-tag">{endorsement}</span>
                          ))}
                        </div>
                        
                        <div className="marketplace-equipment-status">
                          {driver.equipmentTypes.map((equipment, index) => (
                            <span key={index} className={`marketplace-equipment-tag ${equipment.includes('Valid') || equipment.includes('Active') || equipment.includes('Clean') ? 'valid' : equipment.includes('Expiring') ? 'warning' : 'invalid'}`}>
                              <i className={`fa-solid ${equipment.includes('Valid') || equipment.includes('Active') || equipment.includes('Clean') ? 'fa-check-circle' : equipment.includes('Expiring') ? 'fa-exclamation-triangle' : 'fa-times-circle'}`} />
                              {equipment}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="marketplace-driver-actions">
                    <button 
                      className={`marketplace-btn-hire ${driver.available ? 'available' : 'unavailable'}`}
                      onClick={() => handleHireDriver(driver)}
                      disabled={hiringDriver === driver.id || !driver.available}
                    >
                      <i className="fa-solid fa-plus" />
                      {hiringDriver === driver.id ? 'Hiring...' : 'Hire Driver'}
                    </button>
                    <div className="marketplace-driver-menu">
                      <button className="marketplace-menu-btn" title="View Details">
                        <i className="fa-solid fa-file-text" />
                      </button>
                      <button className="marketplace-menu-btn" title="Message">
                        <i className="fa-solid fa-message" />
                      </button>
                      <button className="marketplace-menu-btn" title="Favorite">
                        <i className="fa-regular fa-heart" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          )}

          {!driversLoading && drivers.length > 0 && (
            <div className="drivers-pagination">
              <span>Showing {drivers.length} driver{drivers.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      )}

      {/* Services Content */}
      {activeTab === 'services' && (
        <div className="services-page">
          {/* Service Tabs */}
          <div className="services-header">
            <div className="services-tabs">
              <button className={`service-tab ${serviceTab === 'all' ? 'active' : ''}`} onClick={() => setServiceTab('all')}>
                <i className="fa-solid fa-th"></i> All Services
              </button>
              <button className={`service-tab ${serviceTab === 'fuel' ? 'active' : ''}`} onClick={() => setServiceTab('fuel')}>
                <i className="fa-solid fa-gas-pump"></i> Fuel
              </button>
              <button className={`service-tab ${serviceTab === 'parking' ? 'active' : ''}`} onClick={() => setServiceTab('parking')}>
                <i className="fa-solid fa-square-parking"></i> Parking
              </button>
              <button className={`service-tab ${serviceTab === 'parts' ? 'active' : ''}`} onClick={() => setServiceTab('parts')}>
                <i className="fa-solid fa-cog"></i> Parts
              </button>
              <button className={`service-tab ${serviceTab === 'maintenance' ? 'active' : ''}`} onClick={() => setServiceTab('maintenance')}>
                <i className="fa-solid fa-wrench"></i> Maintenance
              </button>
              <button className={`service-tab ${serviceTab === 'factoring' ? 'active' : ''}`} onClick={() => setServiceTab('factoring')}>
                <i className="fa-solid fa-dollar-sign"></i> Factoring
              </button>
              <button className={`service-tab ${serviceTab === 'insurance' ? 'active' : ''}`} onClick={() => setServiceTab('insurance')}>
                <i className="fa-solid fa-shield-alt"></i> Insurance
              </button>
              <button className={`service-tab ${serviceTab === 'food' ? 'active' : ''}`} onClick={() => setServiceTab('food')}>
                <i className="fa-solid fa-utensils"></i> Food
              </button>
              <button className={`service-tab ${serviceTab === 'favourites' ? 'active' : ''}`} onClick={() => setServiceTab('food')}>
                <i className="fa-solid fa-heart"></i> Favourites
              </button>
              <button className={`service-tab ${serviceTab === 'history' ? 'active' : ''}`} onClick={() => setServiceTab('food')}>
                <i className="fa-solid fa-history"></i> History
              </button>
            </div>
          </div>
          <div className="services-main">
            {/* Services Grid and Info */}
            <div className="services-left">
              <div className="services-info">
                <span>Showing 247 service providers</span>
                <div className="sort-controls">
                  <label htmlFor="services-sort-select">Sort by:</label>
                  <select id="services-sort-select" className="marketplace-filter-select" style={{ minWidth: 120 }}>
                    <option value="relevance">Relevance</option>
                    <option value="rating">Rating</option>
                    <option value="reviews">Reviews</option>
                    <option value="distance">Distance</option>
                  </select>
                  {isMobile && (
                    <button
                      className="btn-filter-toggle"
                      aria-label="Show Filters"
                      onClick={() => setShowSidebar((v) => !v)}
                      style={{ marginLeft: 8 }}
                    >
                      <i className="fa-solid fa-filter"></i>
                    </button>
                  )}
                </div>
              </div>

              {/* Service Cards Grid */}
              <div className="services-grid">
                {/* Pilot Flying J Card */}
                <div className="service-card">
                  <div className="card-header">
                    <div className="provider-info">
                      <div className="provider-logo red">PJ</div>
                      <div>
                        <h3>Pilot Flying J</h3>
                        <p>Fuel Network</p>
                      </div>
                    </div>
                    <i className="fa-regular fa-heart"></i>
                  </div>
                  <div className="service-features">
                    <span className="feature nationwide"><i class="fa-solid fa-location-dot"></i> Nationwide Coverage</span>
                    <div className="rating">
                      <span><i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i> 4.8</span>
                      <span>(1,247 reviews)</span>
                    </div>
                    <span className="discount"><i class="fa-solid fa-tag"></i> 12¢ off per gallon</span>
                    <span className="cashback">Plus 2% cash back on purchases</span>
                  </div>
                  <button className="btn small-cd" style={{width:'100%'}}>Request Quote</button>
                </div>

                {/* TruckPro Service Card */}
                <div className="service-card">
                  <div className="card-header">
                    <div className="provider-info">
                      <div className="provider-logo blue">TP</div>
                      <div>
                        <h3>TruckPro Service</h3>
                        <p>Maintenance & Repair</p>
                      </div>
                    </div>
                    <i className="fa-regular fa-heart"></i>
                  </div>
                  <div className="service-features">
                    <span className="location"><i class="fa-solid fa-location-dot"></i> Dallas, TX - 50 mile radius</span>
                    <div className="rating">
                      <span><i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i> 4.9</span>
                      <span>(456 reviews)</span>
                    </div>
                    <span className="cd-emergency"><i class="fa-solid fa-clock"></i> 24/7 Emergency Service</span>
                    <span className="mobile">Mobile repair units available</span>
                  </div>
                  <button className="btn small-cd" style={{width:'100%'}}>Request Quote</button>
                </div>

                {/* Progressive Commercial Card */}
                <div className="service-card">
                  <div className="card-header">
                    <div className="provider-info">
                      <div className="provider-logo">PC</div>
                      <div>
                        <h3>Progressive Commercial</h3>
                        <p>Commercial Insurance</p>
                      </div>
                    </div>
                    <i className="fa-solid fa-heart red"></i>
                  </div>
                  <div className="service-features">
                    <span className="coverage"><i class="fa-solid fa-location-dot"></i> All 50 States</span>
                    <div className="rating">
                      <span> 4.6</span>
                      <span>(2,134 reviews)</span>
                    </div>
                    <span className="savings"><i class="fa-solid fa-percent"></i> Save up to 25%</span>
                    <span className="discount">Multi-policy discount available</span>
                  </div>
                  <button className="btn small-cd" style={{width:'100%'}}>Get Quote</button>
                </div>

                {/* RTS Financial Card */}
                <div className="service-card">
                  <div className="card-header">
                    <div className="provider-info">
                      <div className="provider-logo dollar">$</div>
                      <div>
                        <h3>RTS Financial</h3>
                        <p>Invoice Factoring</p>
                      </div>
                    </div>
                    <i className="fa-regular fa-heart"></i>
                  </div>
                  <div className="service-features">
                    <span className="service-type"><i class="fa-solid fa-location-dot"></i> Nationwide Service</span>
                    <div className="rating">
                      <span><i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i> 4.7</span>
                      <span>(892 reviews)</span>
                    </div>
                    <span className="funding"><i class="fa-solid fa-bolt"></i> Same-day funding</span>
                    <span className="rate">Rates starting at 1.5%</span>
                  </div>
                  <button className="btn small-cd" style={{width:'100%'}}>Apply Now</button>
                </div>

                {/* SecurePark Network Card */}
                <div className="service-card">
                  <div className="card-header">
                    <div className="provider-info">
                      <div className="provider-logo purple">SP</div>
                      <div>
                        <h3>SecurePark Network</h3>
                        <p>Truck Parking</p>
                      </div>
                    </div>
                    <i className="fa-regular fa-heart"></i>
                  </div>
                  <div className="service-features">
                    <span className="locations"><i class="fa-solid fa-location-dot"></i> 150+ Locations</span>
                    <div className="rating">
                      <span><i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i> 4.5</span>
                      <span>(678 reviews)</span>
                    </div>
                    <span className="security"><i class="fa-solid fa-shield-alt"></i> Secure & Monitored</span>
                    <span className="available">24/7 security & reservations</span>
                  </div>
                  <button className="btn small-cd" style={{width:'100%'}}>Reserve Spot</button>
                </div>

                {/* FleetParts Direct Card */}
                <div className="service-card">
                  <div className="card-header">
                    <div className="provider-info">
                      <div className="provider-logo orange">FP</div>
                      <div>
                        <h3>FleetParts Direct</h3>
                        <p>Truck Parts & Components</p>
                      </div>
                    </div>
                    <i className="fa-regular fa-heart"></i>
                  </div>
                  <div className="service-features">
                    <span className="shipping"><i class="fa-solid fa-location-dot"></i> Same-day shipping</span>
                    <div className="rating">
                      <span><i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i> 4.8</span>
                      <span>(1,523 reviews)</span>
                    </div>
                    <span className="free-shipping"><i class="fa-solid fa-truck"></i> Free shipping $200+</span>
                    <span className="oem">OEM & aftermarket parts</span>
                  </div>
                  <button className="btn small-cd" style={{width:'100%'}}>Browse Parts</button>
                </div>
              </div>

              <div className="load-more">
                <button className="btn small ghost-cd">Load More Providers</button>
              </div>
            </div>

            {/* Filters Sidebar */}
            {(showSidebar || !isMobile) && (
              <div className={`services-sidebar${showSidebar && isMobile ? ' active' : ''}`}>
                {isMobile && (
                  <button
                    className="btn-filter-close"
                    aria-label="Close Filters"
                    onClick={() => setShowSidebar(false)}
                    style={{ float: 'right', marginBottom: 12 }}
                  >
                    <i className="fa-solid fa-times"></i>
                  </button>
                )}
                <h3>Filters</h3>
                
                <div className="filter-section">
                  <h4>Location</h4>
                  <input type="text" placeholder="Enter city or ZIP code" className="location-input" />
                  <div className="radius-selector">
                    <label>Radius</label>
                    <select>
                      <option>25 miles</option>
                      <option>50 miles</option>
                      <option>100 miles</option>
                    </select>
                  </div>
                </div>

                <div className="filter-section">
                  <h4>Minimum Rating</h4>
                  <div className="rating-filters">
                    <label><input type="radio" name="rating" />
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      5 stars
                    </label>
                    <label><input type="radio" name="rating" />
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      4+ stars
                    </label>
                    <label><input type="radio" name="rating" />
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      <i className="fa-solid fa-star" style={{color:'#fbbf24'}}></i>
                      3+ stars
                    </label>
                  </div>
                </div>

                <div className="filter-section">
                  <h4>Service Features</h4>
                  <div className="feature-checkboxes">
                    <label><input type="checkbox" /> 24/7 Service</label>
                    <label><input type="checkbox" checked /> Mobile Service</label>
                    <label><input type="checkbox" checked /> Same-day Service</label>
                    <label><input type="checkbox" /> Warranty Included</label>
                  </div>
                </div>

                <div className="filter-section">
                  <h4>Price Range</h4>
                  <div className="price-filters">
                    <label><input type="radio" name="price" /> $ - Budget</label>
                    <label><input type="radio" name="price" checked /> $$ - Moderate</label>
                    <label><input type="radio" name="price" /> $$$ - Premium</label>
                  </div>
                </div>

                <div className="filter-actions">
                  <button className="btn small-cd">Apply Filters</button>
                  <button className="btn small ghost-cd">Clear All Filters</button>
                </div>

                <div className="quick-actions">
                  <h4>Quick Actions</h4>
                  <button className="btn small ghost-cd" style={{ width: '100%' }}>
                    <i className="fa-solid fa-add"></i>
                    Request Service
                  </button>
                  <button className="btn small ghost-cd" style={{ width: '100%' }}>
                    <i className="fa-solid fa-exclamation-circle"></i>
                    Request Emergency Service
                  </button>
                  <button className="btn small ghost-cd" style={{ width: '100%' }}>
                    <i className="fa-solid fa-calendar"></i>
                    Schedule Maintenance
                  </button>
                  <button className="btn small ghost-cd" style={{ width: '100%' }}>
                    <i className="fa-solid fa-shield"></i>
                    Get Insurance Quote
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bid Modal */}
      {bidModalOpen && selectedLoad && (
        <div className="modal-overlay" onClick={() => setBidModalOpen(false)} style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{
            maxWidth: '500px',
            padding: '30px',
            background: 'white',
            borderRadius: '12px',
            boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
            maxHeight: '90vh',
            overflowY: 'auto'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px'
            }}>
              <h2 style={{ margin: 0, fontSize: '24px', color: '#1e293b' }}>Submit Bid</h2>
              <button 
                onClick={() => setBidModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  color: '#64748b'
                }}
              >
                ×
              </button>
            </div>

            <div style={{ marginBottom: '20px', padding: '15px', background: '#f8fafc', borderRadius: '8px' }}>
              <div style={{ fontSize: '14px', color: '#64748b', marginBottom: '8px' }}>Load Route</div>
              <div style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                {selectedLoad.origin} → {selectedLoad.destination}
              </div>
              <div style={{ fontSize: '14px', color: '#64748b', marginTop: '8px' }}>
                Pickup: {selectedLoad.pickupDate} | {selectedLoad.distance}
              </div>
            </div>

            {/* Route Map */}
            {selectedLoad.origin && selectedLoad.destination && (
              <div style={{ marginBottom: '20px', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                <RouteMap
                  origin={selectedLoad.origin}
                  destination={selectedLoad.destination}
                  waypoints={selectedLoad.additional_routes?.map(r => r.location) || []}
                  height="300px"
                />
              </div>
            )}

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#1e293b' }}>
                Your Bid Rate ($) *
              </label>
              <input
                type="number"
                value={bidRate}
                onChange={(e) => setBidRate(e.target.value)}
                placeholder="Enter your bid amount"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  fontSize: '16px'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#1e293b' }}>
                Estimated Delivery Time (Optional)
              </label>
              <input
                type="text"
                value={bidEta}
                onChange={(e) => setBidEta(e.target.value)}
                placeholder="e.g., 2 days, Dec 28"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  fontSize: '16px'
                }}
              />
            </div>

            <div style={{ marginBottom: '25px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#1e293b' }}>
                Notes (Optional)
              </label>
              <textarea
                value={bidNotes}
                onChange={(e) => setBidNotes(e.target.value)}
                placeholder="Any additional information for the shipper..."
                rows={4}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  fontSize: '16px',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={handleSubmitBid}
                disabled={submittingBid || !bidRate}
                className="btn"
                style={{
                  flex: 1,
                  padding: '12px',
                  background: submittingBid || !bidRate ? '#cbd5e1' : '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '16px',
                  fontWeight: '600',
                  cursor: submittingBid || !bidRate ? 'not-allowed' : 'pointer'
                }}
              >
                {submittingBid ? 'Submitting...' : 'Submit Bid'}
              </button>
              <button
                onClick={() => setBidModalOpen(false)}
                className="btn ghost-cd"
                style={{
                  flex: 1,
                  padding: '12px',
                  background: 'transparent',
                  color: '#64748b',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  fontSize: '16px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Load Details Modal */}
      {detailsModalOpen && selectedLoad && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 9999
          }}
          onClick={() => setDetailsModalOpen(false)}
        >
          <div
            style={{
              backgroundColor: 'white',
              padding: '30px',
              borderRadius: '8px',
              maxWidth: '700px',
              width: '90%',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginBottom: '20px', fontSize: '24px', fontWeight: '700', color: '#333' }}>
              Load Details
            </h2>

            {/* Route Information */}
            <div style={{ marginBottom: '25px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: '600', color: '#555', marginBottom: '15px' }}>
                Route Information
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Pickup Location:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>
                    {selectedLoad.pickup_city || selectedLoad.origin || 'N/A'}
                    {selectedLoad.pickup_state && `, ${selectedLoad.pickup_state}`}
                    {selectedLoad.pickup_zip && ` ${selectedLoad.pickup_zip}`}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Delivery Location:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>
                    {selectedLoad.delivery_city || selectedLoad.destination || 'N/A'}
                    {selectedLoad.delivery_state && `, ${selectedLoad.delivery_state}`}
                    {selectedLoad.delivery_zip && ` ${selectedLoad.delivery_zip}`}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Pickup Date:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>
                    {selectedLoad.pickup_date ? 
                      (typeof selectedLoad.pickup_date === 'string' && selectedLoad.pickup_date.includes('T') 
                        ? new Date(selectedLoad.pickup_date).toLocaleDateString()
                        : selectedLoad.pickup_date) 
                      : 'TBD'}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Delivery Date:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>
                    {selectedLoad.delivery_date ? 
                      (typeof selectedLoad.delivery_date === 'string' && selectedLoad.delivery_date.includes('T') 
                        ? new Date(selectedLoad.delivery_date).toLocaleDateString()
                        : selectedLoad.delivery_date) 
                      : 'TBD'}
                  </p>
                </div>
              </div>
            </div>

            {/* Additional Stops */}
            {(selectedLoad.additional_stops && selectedLoad.additional_stops.length > 0) || 
             (selectedLoad.additional_routes && selectedLoad.additional_routes.length > 0) ? (
              <div style={{ marginBottom: '25px' }}>
                <h3 style={{ fontSize: '18px', fontWeight: '600', color: '#555', marginBottom: '15px' }}>
                  Additional Stops & Pickup Points
                </h3>
                {(selectedLoad.additional_stops || selectedLoad.additional_routes || []).map((stop, index) => (
                  <div key={index} style={{ marginBottom: '10px', padding: '12px', backgroundColor: '#f9f9f9', borderRadius: '6px', borderLeft: '3px solid #3b82f6' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '5px' }}>
                      <p style={{ fontSize: '14px', color: '#333', fontWeight: '600', margin: 0 }}>
                        {stop.type === 'pickup' ? '📦 Pickup' : stop.type === 'delivery' ? '🚚 Delivery' : '📍 Stop'} {index + 1}
                      </p>
                      {stop.date && (
                        <p style={{ fontSize: '12px', color: '#666', margin: 0 }}>
                          {typeof stop.date === 'string' && stop.date.includes('T') 
                            ? new Date(stop.date).toLocaleDateString()
                            : stop.date}
                        </p>
                      )}
                    </div>
                    <p style={{ fontSize: '14px', color: '#333', margin: 0 }}>
                      {stop.location || stop.city || stop.address || 'N/A'}
                      {stop.city && stop.state && `, ${stop.state}`}
                      {stop.zip && ` ${stop.zip}`}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Equipment and Load Details */}
            <div style={{ marginBottom: '25px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: '600', color: '#555', marginBottom: '15px' }}>
                Equipment & Load Details
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Equipment Type:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>{selectedLoad.equipment_type}</p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Load Type:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>{selectedLoad.load_type || 'Full'}</p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Weight:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>
                    {selectedLoad.weight ? `${selectedLoad.weight} lbs` : 'N/A'}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Total Distance:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333', fontWeight: '600' }}>
                    {selectedLoad.total_distance ? `${selectedLoad.total_distance} miles` : 
                     selectedLoad.distance ? `${selectedLoad.distance}${typeof selectedLoad.distance === 'number' ? ' miles' : ''}` : 
                     selectedLoad.estimated_distance ? `${selectedLoad.estimated_distance} miles` : 'N/A'}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Total Price Offered:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#059669', fontWeight: '600' }}>
                    {selectedLoad.total_price ? `$${selectedLoad.total_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 
                     selectedLoad.rate ? `$${typeof selectedLoad.rate === 'string' ? selectedLoad.rate.replace('$', '').replace(',', '') : selectedLoad.rate}` : 
                     selectedLoad.linehaul_rate ? `$${selectedLoad.linehaul_rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Negotiable'}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                    <strong>Status:</strong>
                  </p>
                  <p style={{ fontSize: '14px', color: '#333' }}>{selectedLoad.status}</p>
                </div>
              </div>
            </div>

            {/* Shipper Information */}
            {(selectedLoad.shipper_info || selectedLoad.shipper_company_name || selectedLoad.shipper_compliance_score !== undefined) && (
              <div style={{ marginBottom: '25px' }}>
                <h3 style={{ fontSize: '18px', fontWeight: '600', color: '#555', marginBottom: '15px' }}>
                  Shipper Information
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  <div>
                    <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                      <strong>Company Name:</strong>
                    </p>
                    <p style={{ fontSize: '14px', color: '#333', fontWeight: '600' }}>
                      {selectedLoad.shipper_company_name || selectedLoad.shipper_info?.company_name || 'N/A'}
                    </p>
                  </div>
                  <div>
                    <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                      <strong>Compliance Score:</strong>
                    </p>
                    <p style={{ 
                      fontSize: '14px', 
                      color: selectedLoad.shipper_compliance_score >= 80 ? '#059669' : 
                             selectedLoad.shipper_compliance_score >= 60 ? '#d97706' : '#dc2626',
                      fontWeight: '600'
                    }}>
                      {selectedLoad.shipper_compliance_score !== undefined ? `${selectedLoad.shipper_compliance_score}%` : 'N/A'}
                    </p>
                  </div>
                  {selectedLoad.shipper_info?.contact_name && (
                    <div>
                      <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                        <strong>Contact Name:</strong>
                      </p>
                      <p style={{ fontSize: '14px', color: '#333' }}>
                        {selectedLoad.shipper_info.contact_name}
                      </p>
                    </div>
                  )}
                  {selectedLoad.shipper_info?.email && (
                    <div>
                      <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                        <strong>Email:</strong>
                      </p>
                      <p style={{ fontSize: '14px', color: '#333' }}>{selectedLoad.shipper_info.email}</p>
                    </div>
                  )}
                  {selectedLoad.shipper_info?.phone && (
                    <div>
                      <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                        <strong>Phone:</strong>
                      </p>
                      <p style={{ fontSize: '14px', color: '#333' }}>{selectedLoad.shipper_info.phone}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Special Instructions */}
            {selectedLoad.special_instructions && (
              <div style={{ marginBottom: '25px' }}>
                <h3 style={{ fontSize: '18px', fontWeight: '600', color: '#555', marginBottom: '15px' }}>
                  Special Instructions
                </h3>
                <p style={{ fontSize: '14px', color: '#333', lineHeight: '1.6' }}>
                  {selectedLoad.special_instructions}
                </p>
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setDetailsModalOpen(false)
                  handleOpenBidModal(selectedLoad)
                }}
                style={{
                  padding: '12px 24px',
                  backgroundColor: '#2563eb',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '16px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                Place Bid
              </button>
              <button
                onClick={() => setDetailsModalOpen(false)}
                style={{
                  padding: '12px 24px',
                  backgroundColor: '#e5e7eb',
                  color: '#374151',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '16px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}