import React, { useState, useEffect } from 'react';
import '../../styles/driver/Marketplace.css';
import { useAuth } from '../../contexts/AuthContext';
import { useUserSettings } from '../../contexts/UserSettingsContext';
import { API_URL } from '../../config';
import { AUTO_REFRESH_MS } from '../../constants/refresh';
import { useGeolocation, sortServicesByDistance, calculateDistance } from '../../hooks/useGeolocation';
import { t } from '../../i18n/translate';
import { db } from '../../firebase';
import { collection, doc, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';

const MARKETPLACE_THRESHOLD = 60;
const ACCESS_CACHE_PREFIX = 'fp_driver_marketplace_access_v1:';

const SERVICE_TYPE_LABELS = {
  fuel: { key: 'marketplace.serviceType.fuel', fallback: 'Fuel' },
  parking: { key: 'marketplace.serviceType.parking', fallback: 'Parking' },
  repair: { key: 'marketplace.serviceType.repair', fallback: 'Repair' },
  legal: { key: 'marketplace.serviceType.legal', fallback: 'Legal' },
  training: { key: 'marketplace.serviceType.training', fallback: 'Training' },
  eld: { key: 'marketplace.serviceType.eld', fallback: 'ELD/Tech' },
};

function readAccessCache(uid) {
  if (!uid) return null;
  try {
    const raw = sessionStorage.getItem(`${ACCESS_CACHE_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const ts = Number(parsed.ts || 0);
    if (!ts || (Date.now() - ts) > AUTO_REFRESH_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAccessCache(uid, data) {
  if (!uid) return;
  try {
    sessionStorage.setItem(`${ACCESS_CACHE_PREFIX}${uid}`, JSON.stringify({ ts: Date.now(), ...(data || {}) }));
  } catch {
    // ignore
  }
}

export default function Marketplace({ isPostHire, setIsPostHire, isAvailable, onAvailabilityToggle, onNavigate }) {
  const { currentUser } = useAuth();
  const { settings } = useUserSettings();
  const language = settings?.language || 'English';
  const _locale = language === 'Spanish' ? 'es-ES' : language === 'Arabic' ? 'ar' : 'en-US';
  const tr = (key, fallback) => t(language, key, fallback);
  const trServiceType = (type) => {
    const label = SERVICE_TYPE_LABELS[type];
    if (!label) return String(type || '').replace(/_/g, ' ');
    return tr(label.key, label.fallback);
  };
  const cachedAccess = readAccessCache(currentUser?.uid);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isMarketplaceReady, setIsMarketplaceReady] = useState(() => cachedAccess?.isMarketplaceReady ?? true);
  const [onboardingScore, setOnboardingScore] = useState(() => cachedAccess?.onboardingScore ?? 100);
  const [nextActions, setNextActions] = useState(() => cachedAccess?.nextActions ?? []);
  const [checkingAccess, setCheckingAccess] = useState(() => (currentUser ? !cachedAccess : true));
  const [consentEligible, setConsentEligible] = useState(() => cachedAccess?.consentEligible ?? true);
  const [missingConsents, setMissingConsents] = useState(() => cachedAccess?.missingConsents ?? []);
  const [gatingReason, setGatingReason] = useState(() => cachedAccess?.gatingReason ?? '');
  const [driverInsights, setDriverInsights] = useState(null);
  const [driverInsightsLoading, setDriverInsightsLoading] = useState(false);
  const [driverInsightsError, setDriverInsightsError] = useState('');

  // Keep local dark-mode state in sync with the dashboard root class
  useEffect(() => {
    const root = document.querySelector('.fp-dashboard-root');
    const update = () => setIsDarkMode(Boolean(root?.classList.contains('dark-root')));
    update();
    if (!root) return;
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const mpTheme = {
    text: isDarkMode ? '#f1f5f9' : '#1e293b',
    muted: isDarkMode ? '#94a3b8' : '#64748b',
    border: isDarkMode ? '#353535' : '#e2e8f0',
    surface: isDarkMode ? '#2c2c2c' : '#ffffff',
    surfaceAlt: isDarkMode ? '#1f2937' : '#f8fafc',
    dangerBg: isDarkMode ? '#3f0a0a' : '#fef2f2',
    dangerBorder: isDarkMode ? '#7f1d1d' : '#fecaca',
    dangerText: isDarkMode ? '#fecaca' : '#7f1d1d'
  };
  
  // Geolocation hook with GPS â†’ WiFi fallback
  const { location, loading: locationLoading, error: locationError, accuracy, method, refreshLocation } = useGeolocation(true);
  
  // Nearby services state
  const [nearbyServices, setNearbyServices] = useState([]);
  const [selectedServiceType, setSelectedServiceType] = useState(null); // For filtering
  const [showServiceModal, setShowServiceModal] = useState(false); // For modal display
  const [showFilterModal, setShowFilterModal] = useState(false); // For filter modal
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false); // For favorites filter
  const [favoriteServices, setFavoriteServices] = useState([]); // Store favorite service IDs (for quick lookup)
  const [favoriteServicesData, setFavoriteServicesData] = useState([]); // Full favorite service data with coordinates
  const [selectedFilters, setSelectedFilters] = useState({
    fuel: false,
    parking: false,
    repair: false,
    legal: false,
    training: false,
    eld: false
  });
  
  // Load favorites from Firestore on component mount and when user changes
  useEffect(() => {
    if (!currentUser) return;
    
    console.log('ðŸ”¥ Setting up favorites listener for user:', currentUser.uid);
    
    // Real-time listener for favorites
    const favoritesRef = collection(db, 'driver_favorites', currentUser.uid, 'services');
    const unsubscribe = onSnapshot(favoritesRef, 
      (snapshot) => {
        const favorites = [];
        const favoriteIds = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data();
          favorites.push({
            id: doc.id,
            ...data
          });
          favoriteIds.push(doc.id);
        });
        
        console.log(`ðŸ’– Loaded ${favorites.length} favorites from Firestore`);
        setFavoriteServicesData(favorites);
        setFavoriteServices(favoriteIds);
      },
      (error) => {
        console.error('âŒ Error loading favorites:', error);
      }
    );
    
    return () => unsubscribe();
  }, [currentUser]);
  
  // Debug: Log location changes
  useEffect(() => {
    if (location) {
      console.log('ðŸ“ Location detected:', {
        latitude: location.latitude,
        longitude: location.longitude,
        method: method,
        accuracy: accuracy
      });
    }
  }, [location, method, accuracy]);
  
  // Debug: Log services changes
  useEffect(() => {
    console.log('ðŸª Nearby services updated:', nearbyServices.length, 'services');
    if (nearbyServices.length > 0) {
      console.log('Service types:', nearbyServices.map(s => s.type).join(', '));
    }
  }, [nearbyServices]);

  // Check onboarding status AND consent eligibility to gate marketplace
  useEffect(() => {
    const checkMarketplaceAccess = async () => {
      if (!currentUser) {
        setCheckingAccess(false);
        return;
      }

      // If we recently checked, don't re-run on quick remounts.
      const fresh = readAccessCache(currentUser.uid);
      if (fresh) {
        setIsMarketplaceReady(Boolean(fresh.isMarketplaceReady));
        setOnboardingScore(Number(fresh.onboardingScore ?? 0));
        setNextActions(Array.isArray(fresh.nextActions) ? fresh.nextActions : []);
        setConsentEligible(Boolean(fresh.consentEligible));
        setMissingConsents(Array.isArray(fresh.missingConsents) ? fresh.missingConsents : []);
        setGatingReason(String(fresh.gatingReason || ''));
        setCheckingAccess(false);
        return;
      }

      setCheckingAccess(true);

      try {
        const token = await currentUser.getIdToken();

        let scoreValue = 0;
        let nextActionsValue = [];
        let consentsEligibleValue = true;
        let missingConsentsValue = [];

        // Check onboarding score
        const onboardingResponse = await fetch(`${API_URL}/onboarding/coach-status`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        let scoreOk = true;
        if (onboardingResponse.ok) {
          const data = await onboardingResponse.json();
          const score = data.total_score || 0;
          scoreValue = score;
          nextActionsValue = data.next_best_actions || [];
          setOnboardingScore(score);
          scoreOk = score >= MARKETPLACE_THRESHOLD;
          setNextActions(nextActionsValue);
        }

        // Check consent eligibility
        const consentResponse = await fetch(`${API_URL}/consents/marketplace-eligibility`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        let consentsOk = true;
        if (consentResponse.ok) {
          const consentData = await consentResponse.json();
          consentsOk = consentData.eligible;
          consentsEligibleValue = consentData.eligible;
          missingConsentsValue = consentData.missing_consents || [];
          setConsentEligible(consentsEligibleValue);
          setMissingConsents(missingConsentsValue);
        }

        // Determine gating reason
        const gating = (!scoreOk && !consentsOk) ? 'both' : (!scoreOk ? 'score' : (!consentsOk ? 'consent' : ''));
        if (gating) setGatingReason(gating);

        const ready = scoreOk && consentsOk;
        setIsMarketplaceReady(ready);

        writeAccessCache(currentUser.uid, {
          isMarketplaceReady: ready,
          onboardingScore: Number(scoreValue || 0),
          nextActions: Array.isArray(nextActionsValue) ? nextActionsValue : [],
          consentEligible: Boolean(consentsEligibleValue),
          missingConsents: Array.isArray(missingConsentsValue) ? missingConsentsValue : [],
          gatingReason: gating,
        });
      } catch (error) {
        console.error('Error checking marketplace access:', error);
        setConsentEligible(false);
        setMissingConsents([]);
        setGatingReason('consent');
        setIsMarketplaceReady(false);

        writeAccessCache(currentUser.uid, {
          isMarketplaceReady: false,
          onboardingScore: Number(onboardingScore ?? 0),
          nextActions: Array.isArray(nextActions) ? nextActions : [],
          consentEligible: false,
          missingConsents: [],
          gatingReason: 'consent',
        });
      } finally {
        setCheckingAccess(false);
      }
    };

    checkMarketplaceAccess();
  }, [currentUser]);

  useEffect(() => {
    let isMounted = true;
    let intervalId = null;

    const fetchDriverInsights = async () => {
      if (!currentUser) return;
      if (isMounted) {
        setDriverInsightsLoading(true);
        setDriverInsightsError('');
      }
      try {
        const token = await currentUser.getIdToken();
        const response = await fetch(`${API_URL}/driver/dashboard/insights`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (isMounted) {
          setDriverInsights(payload);
        }
      } catch (error) {
        console.error('Failed to load driver marketplace insights:', error);
        if (isMounted) {
          setDriverInsightsError('Live AI insights are unavailable. Showing fallback guidance.');
        }
      } finally {
        if (isMounted) {
          setDriverInsightsLoading(false);
        }
      }
    };

    if (currentUser) {
      fetchDriverInsights();
      intervalId = window.setInterval(fetchDriverInsights, 60000);
    }

    return () => {
      isMounted = false;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [currentUser]);

  // Fetch nearby services when location is available
  useEffect(() => {
    const fetchNearbyServices = async () => {
      if (!location) {
        console.log('âš ï¸ Location not available yet, skipping service fetch');
        return;
      }

      console.log('ðŸ” Fetching nearby services for location:', location);

      // First, always generate mock data as fallback
      const mockData = getMockNearbyServices(location);
      console.log('âœ… Generated', mockData.length, 'mock services');

      // If no user, just use mock data
      if (!currentUser) {
        console.log('ðŸ‘¤ No user logged in, using mock data only');
        setNearbyServices(mockData);
        return;
      }

      try {
        const token = await currentUser.getIdToken();
        
        // Try to fetch from backend
        console.log('ðŸŒ Attempting to fetch from backend API...');
        const response = await fetch(
          `${API_URL}/marketplace/nearby-services?latitude=${location.latitude}&longitude=${location.longitude}&radius=10`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (response.ok) {
          const data = await response.json();
          console.log('âœ… Backend API response:', data);
          
          // If backend returns services, use them
          if (data.services && data.services.length > 0) {
            console.log('ðŸ”¢ Recalculating distances for', data.services.length, 'backend services');
            
            // Recalculate and sort by distance from current location
            const sortedServices = sortServicesByDistance(data.services, location);
            
            // Log the fuel stations specifically
            const fuelStations = sortedServices.filter(s => s.type === 'fuel');
            console.log(`â›½ Found ${fuelStations.length} fuel stations:`, 
              fuelStations.map(f => `${f.name} - ${f.distance?.toFixed(1)} miles`).join(', ')
            );
            
            setNearbyServices(sortedServices);
            console.log(`âœ… Using ${sortedServices.length} services from backend (nearest: ${sortedServices[0]?.name} at ${sortedServices[0]?.distance?.toFixed(1)} miles)`);
          } else {
            // Backend returned no services, use mock data
            console.log('âš ï¸ Backend returned no services, using mock data');
            setNearbyServices(mockData);
          }
        } else {
          console.log('âš ï¸ Backend API failed with status:', response.status);
          setNearbyServices(mockData);
        }
      } catch (error) {
        console.error('âŒ Error fetching from backend:', error);
        console.log('âœ… Using mock data as fallback');
        setNearbyServices(mockData);
      }
    };

    fetchNearbyServices();
  }, [location, currentUser]);

  // Mock nearby services generator (for development/fallback)
  const getMockNearbyServices = (currentLocation) => {
    if (!currentLocation) {
      console.log('âš ï¸ getMockNearbyServices: No location provided');
      return [];
    }
    
    console.log('ðŸ­ Generating mock services for location:', currentLocation);
    
    const mockServices = [
      {
        id: 1,
        name: 'Shell Station',
        type: 'fuel',
        latitude: currentLocation.latitude + 0.01,
        longitude: currentLocation.longitude + 0.01,
        description: tr('marketplace.mock.shell.description', 'Premium fuel station with truck parking and amenities'),
        openStatus: tr('marketplace.mock.shell.openStatus', 'Open 24/7'),
        offers: tr('marketplace.mock.shell.offers', '15Â¢ discount active'),
        verified: true,
        phone: '1-800-SHELL-GO',
        website: 'https://www.shell.us',
        address: 'Main St & Highway 95'
      },
      {
        id: 2,
        name: 'Mike\'s Truck Repair',
        type: 'repair',
        latitude: currentLocation.latitude + 0.03,
        longitude: currentLocation.longitude - 0.02,
        description: tr('marketplace.mock.mikesRepair.description', 'Full-service truck repair and maintenance facility'),
        openStatus: tr('marketplace.mock.mikesRepair.openStatus', 'Open until 8 PM'),
        offers: tr('marketplace.mock.mikesRepair.offers', 'Emergency service available'),
        verified: true,
        phone: '1-555-REPAIR-1',
        email: 'service@mikestruckrepair.com',
        address: '456 Industrial Blvd'
      },
      {
        id: 3,
        name: 'TruckStop Plaza',
        type: 'parking',
        latitude: currentLocation.latitude - 0.05,
        longitude: currentLocation.longitude + 0.04,
        description: tr('marketplace.mock.truckStopPlaza.description', 'Secure parking with showers, food court, and WiFi'),
        openStatus: tr('marketplace.mock.truckStopPlaza.openStatus', 'Open 24/7'),
        offers: tr('marketplace.mock.truckStopPlaza.offers', '42 spots available'),
        verified: true,
        phone: '1-555-PARK-NOW',
        website: 'https://www.truckstopplaza.com',
        address: '789 Highway Rest Stop'
      },
      {
        id: 4,
        name: 'Pilot Travel Center',
        type: 'fuel',
        latitude: currentLocation.latitude + 0.02,
        longitude: currentLocation.longitude - 0.03,
        description: tr('marketplace.mock.pilot.description', 'Full-service travel center with fuel, food, and parking'),
        openStatus: tr('marketplace.mock.pilot.openStatus', 'Open 24/7'),
        offers: tr('marketplace.mock.pilot.offers', '10Â¢ discount with rewards'),
        verified: true,
        phone: '1-877-PILOT-77',
        website: 'https://www.pilotflyingj.com',
        address: 'Exit 45, Interstate 80'
      },
      {
        id: 5,
        name: 'Loves Truck Stop',
        type: 'fuel',
        latitude: currentLocation.latitude - 0.02,
        longitude: currentLocation.longitude + 0.02,
        description: tr('marketplace.mock.loves.description', 'Major truck stop chain with all amenities'),
        openStatus: tr('marketplace.mock.loves.openStatus', 'Open 24/7'),
        offers: tr('marketplace.mock.loves.offers', 'Free shower with fuel'),
        verified: true,
        phone: '1-800-LOVES-01',
        website: 'https://www.loves.com',
        address: 'Mile Marker 127'
      },
      {
        id: 6,
        name: 'TVC Legal Protection',
        type: 'legal',
        latitude: currentLocation.latitude + 0.08,
        longitude: currentLocation.longitude - 0.01,
        description: tr('marketplace.mock.tvc.description', 'Comprehensive CDL protection and legal services'),
        openStatus: tr('marketplace.mock.tvc.openStatus', 'Mon-Fri 9 AM - 6 PM'),
        offers: tr('marketplace.mock.tvc.offers', '20% off this week'),
        verified: true,
        phone: '1-888-TVC-LEGAL',
        website: 'https://www.tvcprotection.com',
        email: 'info@tvcprotection.com',
        address: 'Nationwide Service'
      },
      {
        id: 7,
        name: 'CDL Training Academy',
        type: 'training',
        latitude: currentLocation.latitude - 0.03,
        longitude: currentLocation.longitude - 0.04,
        description: tr('marketplace.mock.trainingAcademy.description', 'Professional CDL training and certification courses'),
        openStatus: tr('marketplace.mock.trainingAcademy.openStatus', 'Mon-Sat 8 AM - 5 PM'),
        offers: tr('marketplace.mock.trainingAcademy.offers', 'New class starting soon'),
        verified: true,
        phone: '1-555-CDL-TRAIN',
        website: 'https://www.cdlacademy.com',
        email: 'register@cdlacademy.com',
        address: '321 Training Center Dr'
      },
      {
        id: 8,
        name: 'ELD Tech Solutions',
        type: 'eld',
        latitude: currentLocation.latitude + 0.04,
        longitude: currentLocation.longitude + 0.03,
        description: tr('marketplace.mock.eldTech.description', 'ELD devices, installation, and technical support'),
        openStatus: tr('marketplace.mock.eldTech.openStatus', 'Mon-Fri 9 AM - 5 PM'),
        offers: tr('marketplace.mock.eldTech.offers', 'Free installation'),
        verified: true,
        phone: '1-877-ELD-TECH',
        website: 'https://www.eldtech.com',
        email: 'support@eldtech.com',
        address: '555 Technology Park'
      }
    ];

    const sorted = sortServicesByDistance(mockServices, currentLocation);
    console.log(`âœ… Generated ${sorted.length} mock services, nearest is ${sorted[0]?.name} at ${sorted[0]?.distance?.toFixed(1)} miles`);
    return sorted;
  };

  // Handle contact action - opens appropriate app
  const handleContact = async (service) => {
    // Try to get phone number from service data or fetch from web
    let phoneNumber = service.phone;
    
    // If no phone number in service data, try to fetch from Google search
    if (!phoneNumber) {
      console.log(`ðŸ“ž No phone number available for ${service.name}, attempting to fetch...`);
      
      // Use Google search to find contact info (this opens in new tab as fallback)
      const searchQuery = encodeURIComponent(`${service.name} ${service.address} phone number contact`);
      
      // Show alert to user
      handlePhoneNotAvailable(service);
      window.open(`https://www.google.com/search?q=${searchQuery}`, '_blank');
      return;
    }
    
    // Clean phone number (remove spaces, dashes, parentheses)
    phoneNumber = phoneNumber.replace(/[\s\-()]/g, '');
    
    // Try to open device dialer with tel: protocol
    try {
      console.log(`ðŸ“ž Opening dialer with number: ${phoneNumber}`);
      
      // Create a temporary link to trigger tel: protocol
      const telLink = document.createElement('a');
      telLink.href = `tel:${phoneNumber}`;
      telLink.style.display = 'none';
      document.body.appendChild(telLink);
      
      // Click the link to open dialer
      telLink.click();
      
      // Clean up
      setTimeout(() => {
        document.body.removeChild(telLink);
      }, 100);
      
      // Check if dialer opened (best effort - not all browsers allow detection)
      // Show success message after short delay
      setTimeout(() => {
        // If user is still on page, assume dialer didn't open
        if (document.hasFocus()) {
          console.warn('âš ï¸ Dialer may not have opened');
          
          // Fallback: try alternative contact methods
          if (service.email) {
            const emailConfirm =
              tr('marketplace.confirms.unableToOpenDialerEmailPrefix', 'Unable to open dialer. Would you like to send an email to ') +
              String(service.name || '') +
              tr('marketplace.confirms.unableToOpenDialerEmailSuffix', ' instead?');
            if (confirm(emailConfirm)) {
              window.location.href = `mailto:${service.email}`;
            }
          } else if (service.website) {
            const siteConfirm =
              tr('marketplace.confirms.unableToOpenDialerWebsitePrefix', 'Unable to open dialer. Would you like to visit ') +
              String(service.name || '') +
              tr('marketplace.confirms.unableToOpenDialerWebsiteSuffix', "'s website instead?");
            if (confirm(siteConfirm)) {
              window.open(service.website, '_blank');
            }
          } else {
            handleUnableToOpenDialer(service, { canCopy: true });
            
            // Try to copy to clipboard
            if (navigator.clipboard) {
              navigator.clipboard.writeText(service.phone).then(() => {
                console.log('ðŸ“‹ Phone number copied to clipboard');
              }).catch(err => {
                console.error('Failed to copy to clipboard:', err);
              });
            }
          }
        }
      }, 1000);
      
    } catch (error) {
      console.error('âŒ Error opening dialer:', error);
      
      // Show error and provide alternatives
      handleUnableToOpenDialer(service, { canCopy: false });
      
      // Try to copy to clipboard as fallback
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(service.phone);
          alert(tr('marketplace.alerts.phoneCopied', 'Phone number copied to clipboard!'));
        } catch (err) {
          console.error('Failed to copy to clipboard:', err);
        }
      }
    }
  };

  // Filter services by type
  const getFilteredServices = (type) => {
    if (!type) return nearbyServices;
    return nearbyServices.filter(service => service.type === type);
  };

  // Get all services matching selected filters
  const getFilteredByCategory = () => {
    // If showing favorites only
    if (showFavoritesOnly) {
      // Use favoriteServicesData with calculated distances
      if (!location || favoriteServicesData.length === 0) {
        return favoriteServicesData;
      }
      
      // Calculate distance for each favorite service
      const favoritesWithDistance = favoriteServicesData.map(service => {
        const distance = calculateDistance(
          location.latitude,
          location.longitude,
          service.latitude,
          service.longitude
        );
        
        return {
          ...service,
          distance: distance
        };
      });
      
      // Sort by distance
      return favoritesWithDistance.sort((a, b) => a.distance - b.distance);
    }
    
    // Check if any filter is selected
    const hasActiveFilters = Object.values(selectedFilters).some(v => v);
    
    // If no filters selected, show nearest from each category
    if (!hasActiveFilters) {
      const categories = ['fuel', 'parking', 'repair', 'legal', 'training', 'eld'];
      const nearestServices = [];
      
      categories.forEach(category => {
        const categoryServices = nearbyServices.filter(s => s.type === category);
        if (categoryServices.length > 0) {
          nearestServices.push(categoryServices[0]);
        }
      });
      
      return nearestServices;
    }
    
    // Return all services matching selected filters
    return nearbyServices.filter(service => selectedFilters[service.type]);
  };

  // Handle filter toggle
  const handleFilterToggle = (filterKey) => {
    setSelectedFilters(prev => ({
      ...prev,
      [filterKey]: !prev[filterKey]
    }));
  };

  // Handle select all filters
  const handleSelectAllFilters = () => {
    const allSelected = Object.values(selectedFilters).every(v => v);
    const newState = allSelected ? {
      fuel: false,
      parking: false,
      repair: false,
      legal: false,
      training: false,
      eld: false
    } : {
      fuel: true,
      parking: true,
      repair: true,
      legal: true,
      training: true,
      eld: true
    };
    setSelectedFilters(newState);
  };

  // Handle favorite toggle - Save/Delete from Firestore
  const handleToggleFavorite = async (service) => {
    if (!currentUser) {
      console.error('âŒ No user logged in');
      return;
    }
    
    const serviceId = service.id;
    const isFavorite = favoriteServices.includes(serviceId);
    
    try {
      const favoriteDocRef = doc(db, 'driver_favorites', currentUser.uid, 'services', serviceId);
      
      if (isFavorite) {
        // Remove from favorites
        console.log('ðŸ’” Removing from favorites:', service.name);
        await deleteDoc(favoriteDocRef);
      } else {
        // Add to favorites
        console.log('ðŸ’– Adding to favorites:', service.name);
        
        const favoriteData = {
          serviceId: serviceId,
          name: service.name,
          type: service.type,
          address: service.address || '',
          latitude: service.latitude,
          longitude: service.longitude,
          phone: service.phone || '',
          email: service.email || '',
          website: service.website || '',
          rating: service.rating || 0,
          description: service.description || '',
          openStatus: service.openStatus || '',
          verified: service.verified || false,
          addedAt: new Date().toISOString(),
          source: service.source || 'geoapify'
        };
        
        await setDoc(favoriteDocRef, favoriteData);
      }
      // State updates handled automatically by onSnapshot listener
    } catch (error) {
      console.error('âŒ Error toggling favorite:', error);
      alert(tr('marketplace.alerts.favoritesUpdateFailed', 'Failed to update favorites. Please try again.'));
    }
  };

  const handlePhoneNotAvailable = (service) => {
    const name = String(service?.name || '');
    alert(
      tr('marketplace.alerts.phoneNotAvailablePrefix', 'Phone number not available for ') +
        name +
        tr(
          'marketplace.alerts.phoneNotAvailableSuffix',
          '. Opening search results to find contact information.'
        )
    );
  };

  const handleUnableToOpenDialer = (service, { canCopy = false } = {}) => {
    const phone = String(service?.phone || '');
    const prefix = tr('marketplace.alerts.unableToOpenDialerPrefix', 'Unable to open dialer. Phone number: ');
    const suffix = canCopy
      ? tr(
          'marketplace.alerts.unableToOpenDialerCopySuffix',
          '\n\nPlease dial manually or copy this number.'
        )
      : tr('marketplace.alerts.unableToOpenDialerManualSuffix', '\n\nPlease dial manually.');
    alert(prefix + phone + suffix);
  };

  // Handle favorites button click
  const handleFavoritesClick = () => {
    setShowFavoritesOnly(!showFavoritesOnly);
  };

  // Handle service type button click
  const handleServiceTypeClick = (type) => {
    setSelectedServiceType(type);
    setShowServiceModal(true);
  };

  // Show loading state while checking access
  if (checkingAccess) {
    return (
      <div className="dd-marketplace marketplace-loading" style={{ padding: '40px', textAlign: 'center' }}>
        <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
        <p style={{ marginTop: '10px', color: mpTheme.muted }}>{tr('marketplace.checkingAccess', 'Checking marketplace access...')}</p>
      </div>
    );
  }

  // Show gating message if onboarding not complete or consents missing
  if (!isMarketplaceReady) {
    const scoreNeeded = Math.max(0, Number(MARKETPLACE_THRESHOLD) - Number(onboardingScore || 0));

    return (
      <div className="dd-marketplace marketplace-gated" style={{
        padding: '60px 40px',
        textAlign: 'center',
        background: isDarkMode ? mpTheme.surfaceAlt : 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
        borderRadius: '16px',
        margin: '20px',
        border: `1px solid ${mpTheme.border}`
      }}>
        <div style={{
          width: '80px',
          height: '80px',
          background: isDarkMode ? 'rgba(245,158,11,0.14)' : '#fef3c7',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 20px'
        }}>
          <i className="fa-solid fa-lock" style={{ fontSize: '2rem', color: '#f59e0b' }}></i>
        </div>

        <h2 style={{ fontSize: '1.75rem', color: mpTheme.text, marginBottom: '10px' }}>
          {tr('marketplace.gate.title', 'Marketplace Access Locked')}
        </h2>

        <p style={{ color: mpTheme.muted, marginBottom: '20px', maxWidth: '500px', margin: '0 auto 20px' }}>
          {gatingReason === 'consent'
            ? tr('marketplace.gate.reasonConsent', 'You must sign all required consent forms to access the marketplace.')
            : gatingReason === 'both'
            ? tr('marketplace.gate.reasonBoth', 'Complete your onboarding and sign required consent forms to unlock the marketplace.')
            : tr('marketplace.gate.reasonScorePrefix', 'Complete your onboarding to unlock the marketplace. Score needed: ') +
              MARKETPLACE_THRESHOLD +
              '%'
          }
        </p>

        {(gatingReason === 'consent' || gatingReason === 'both') && (
          <div style={{ marginBottom: '22px', display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <button
              className="btn small-cd"
              onClick={() => {
                if (typeof onNavigate === 'function') onNavigate('esign');
              }}
              disabled={typeof onNavigate !== 'function'}
            >
              {tr('marketplace.gate.goToEsign', 'Go to Consent & E-Signature')}
            </button>
          </div>
        )}

        {/* Show missing consents if applicable */}
        {!consentEligible && missingConsents.length > 0 && (
          <div style={{
            background: mpTheme.dangerBg,
            padding: '15px 20px',
            borderRadius: '12px',
            maxWidth: '400px',
            margin: '0 auto 20px',
            border: `1px solid ${mpTheme.dangerBorder}`
          }}>
            <div style={{ fontWeight: '600', color: mpTheme.dangerText, marginBottom: '10px' }}>
              <i className="fa-solid fa-file-signature" style={{ marginRight: '8px' }}></i>
              {tr('marketplace.gate.missingConsents', 'Missing Required Consents')}
            </div>
            <ul style={{ textAlign: 'left', margin: 0, paddingLeft: '20px', color: mpTheme.dangerText }}>
              {missingConsents.map((consent, idx) => (
                <li key={idx} style={{ marginBottom: '5px' }}>
                  {consent.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Show onboarding score if applicable */}
        {(gatingReason === 'score' || gatingReason === 'both') && (
        <div style={{
          background: mpTheme.surface,
          padding: '20px',
          borderRadius: '12px',
          maxWidth: '400px',
          margin: '0 auto 30px',
          boxShadow: isDarkMode ? 'none' : '0 4px 6px -1px rgba(0,0,0,0.1)',
          border: isDarkMode ? `1px solid ${mpTheme.border}` : undefined
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px', marginBottom: '15px' }}>
            <div style={{
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              background: isDarkMode
                ? (onboardingScore >= 50 ? 'rgba(245,158,11,0.16)' : 'rgba(239,68,68,0.16)')
                : (onboardingScore >= 50 ? '#fef3c7' : '#fee2e2'),
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
              <div style={{ fontWeight: '600', color: mpTheme.text }}>{tr('marketplace.gate.currentScore', 'Current Score')}</div>
              <div style={{ color: mpTheme.muted, fontSize: '0.875rem' }}>
                {tr('marketplace.gate.needPrefix', 'Need ') + scoreNeeded + tr('marketplace.gate.needSuffix', '% more to unlock')}
              </div>
            </div>
          </div>
        </div>
        )}

        {nextActions.length > 0 && (gatingReason === 'score' || gatingReason === 'both') && (
          <div style={{ textAlign: 'left', maxWidth: '400px', margin: '0 auto' }}>
            <h4 style={{ color: mpTheme.text, marginBottom: '10px' }}>{tr('marketplace.gate.completeSteps', 'Complete These Steps:')}</h4>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {nextActions.slice(0, 3).map((action, index) => (
                <li key={index} style={{
                  padding: '10px 15px',
                  background: mpTheme.surface,
                  borderRadius: '8px',
                  marginBottom: '8px',
                  border: `1px solid ${mpTheme.border}`
                }}>
                  {action}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const driverMarketplaceInsights = (Array.isArray(driverInsights?.ai_suggestions) ? driverInsights.ai_suggestions : [])
    .map((item, idx) => ({
      id: String(item?.id || `driver_marketplace_insight_${idx}`),
      title: String(item?.title || ''),
      detail: String(item?.detail || ''),
      action_type: String(item?.action_type || 'nav'),
      action_target: String(item?.action_target || ''),
      action_label: String(item?.action_label || 'Open'),
      priority: String(item?.priority || 'medium'),
    }))
    .filter((item) => item.title && item.detail)
    .slice(0, 3);

  const driverMarketplaceInsightFallback = [
    {
      id: 'driver_marketplace_fallback_demand',
      title: tr('marketplace.aiStaffingInsights.highDemandTitle', 'High Demand Alert'),
      detail: tr(
        'marketplace.aiStaffingInsights.highDemandBody',
        'There are active carrier opportunities in your region. Keep your profile and documents updated.'
      ),
      action_type: 'nav',
      action_target: 'hiring',
      action_label: tr('marketplace.aiStaffingInsights.highDemandAction', 'Open Hiring'),
      priority: 'medium',
    },
    {
      id: 'driver_marketplace_fallback_offer',
      title: tr('marketplace.aiStaffingInsights.specialOfferTitle', 'Special Offer'),
      detail: tr(
        'marketplace.aiStaffingInsights.specialOfferBody',
        'Review service provider offers that match your compliance and route needs.'
      ),
      action_type: 'nav',
      action_target: 'marketplace',
      action_label: tr('marketplace.aiStaffingInsights.specialOfferAction', 'Open Marketplace'),
      priority: 'low',
    },
  ];

  const displayedDriverMarketplaceInsights = driverMarketplaceInsights.length > 0
    ? driverMarketplaceInsights
    : driverMarketplaceInsightFallback;

  const runDriverMarketplaceInsightAction = (insight) => {
    const actionType = String(insight?.action_type || '').trim().toLowerCase();
    const actionTarget = String(insight?.action_target || '').trim();
    if (actionType === 'toggle_availability') {
      if (typeof onAvailabilityToggle === 'function') onAvailabilityToggle();
      return;
    }
    if (actionType !== 'nav' || !actionTarget || actionTarget === 'marketplace') return;
    if (typeof onNavigate === 'function') {
      onNavigate(actionTarget);
    } else {
      window.location.href = `/driver-dashboard?nav=${encodeURIComponent(actionTarget)}`;
    }
  };

  function PostHireMarketplaceView() {
    return (
      <div className="dd-marketplace">
        <header className="fp-header">
          <div className="fp-header-titles">
            <h2>{tr('marketplace.title', 'Marketplace')}</h2>
            <p className="fp-subtitle">{tr('marketplace.subtitle', 'Your smart CDL staffing hub - connect with carriers and service providers')}</p>
            <button onClick={() => setIsPostHire(false)} className="btn small dd-back-btn">{tr('marketplace.preHire', 'Pre-Hire')}</button>
          </div>
        </header>
        
        <section className="fp-grid">
          {/* Driver Availability Section */}
          <div className="card mp-availability-card">
            <div className="card-header">
              <h3>{tr('marketplace.driverAvailability.title', 'Driver Availability')}</h3>
              <span className={`int-status-badge ${isAvailable ? 'active' : 'inactive'}`}>
                {isAvailable ? tr('marketplace.driverAvailability.currentlyAvailable', 'Currently Available') : tr('marketplace.driverAvailability.currentlyUnavailable', 'Currently Unavailable')}
              </span>
            </div>
            <div className="mp-availability-content">
              <div className="mp-visibility-status">
                <div className={`mp-status-icon ${isAvailable ? 'active' : 'inactive'}`}></div>
                <span>
                  {isAvailable 
                    ? tr('marketplace.driverAvailability.visibleToCarrier', 'You are visible for your associated carrier')
                    : tr('marketplace.driverAvailability.notVisibleToCarrier', 'You are not visible for your associated carrier. Toggle availability to share your status.')}
                </span>
              </div>
              <div className="mp-consent-info">
                <p className="mp-consent-text">
                  {isAvailable 
                    ? tr('marketplace.driverAvailability.autoConsentBody', "By being available, you've agreed to share your CDL & compliance information with your associated carrier through FreightPower.")
                    : tr('marketplace.driverAvailability.becomeAvailableBody', 'Mark yourself as available to share your status with your associated carrier.')}
                </p>
                {isAvailable ? (
                  <button className='btn small-cd'>
                    <i className="fa-solid fa-info-circle"></i>
                    {tr('marketplace.driverAvailability.autoConsentActive', 'Auto-Consent Active')}
                  </button>
                ) : (
                  <button 
                    className='btn small-cd'
                    onClick={onAvailabilityToggle}
                    style={{ background: '#3b82f6' }}
                  >
                    <i className="fa-solid fa-toggle-on"></i>
                    {tr('marketplace.driverAvailability.becomeAvailable', 'Become Available')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Promote Myself Section */}
          <div className="mp-promote-card" style={{ opacity: 0.55 }}>
            <div className="mp-promote-content">
              <div className="mp-promote-header">
                <i className="fa-solid fa-star"></i>
                <h4>{tr('marketplace.promote.title', 'Promote Myself')}</h4>
              </div>
              <p className="mp-promote-text">{tr('marketplace.promote.body', 'Boost your profile to appear higher in carrier searches')}</p>
                <div className="mp-coming-soon-tag">{tr('marketplace.comingSoon', 'Coming Soon')}</div>
              <button className="btn small-cd" disabled style={{ cursor: 'not-allowed' }}>{tr('marketplace.promote.cta', 'Promote Profile')}</button>
            </div>
          </div>

          {/* AI Staffing Insights */}
          <div className="card mp-ai-insights-card">
            <div className="mp-ai-header">
              <h3>{tr('marketplace.aiStaffingInsights.title', 'AI Staffing Insights')}</h3>
            </div>
            <div className="mp-insights-grid">
              {displayedDriverMarketplaceInsights.map((insight, idx) => {
                const itemClass = idx % 2 === 0 ? 'high-demand' : 'special-offer';
                const icon = String(insight.priority || '').toLowerCase() === 'high' ? 'fa-triangle-exclamation' : 'fa-lightbulb';
                return (
                  <div key={insight.id} className={`mp-insight-item ${itemClass}`}>
                    <div className="mp-insight-header">
                      <i className={`fa-solid ${icon}`}></i>
                      <span>{insight.title}</span>
                    </div>
                    <p>{insight.detail}</p>
                    <button
                      className="btn small-cd"
                      onClick={() => runDriverMarketplaceInsightAction(insight)}
                      style={{ marginTop: '10px' }}
                    >
                      {insight.action_label || tr('marketplace.open', 'Open')}
                    </button>
                  </div>
                );
              })}
              {driverInsightsLoading && (
                <div className="mp-insight-item high-demand">
                  <div className="mp-insight-header">
                    <i className="fa-solid fa-spinner fa-spin"></i>
                    <span>{tr('marketplace.aiStaffingInsights.loadingTitle', 'Refreshing Insights')}</span>
                  </div>
                  <p>{tr('marketplace.aiStaffingInsights.loadingBody', 'Loading live staffing suggestions for your account.')}</p>
                </div>
              )}
              {driverInsightsError && !driverInsightsLoading && (
                <div className="mp-insight-item special-offer">
                  <div className="mp-insight-header">
                    <i className="fa-solid fa-circle-exclamation"></i>
                    <span>{tr('marketplace.aiStaffingInsights.fallbackTitle', 'Fallback Guidance')}</span>
                  </div>
                  <p>{driverInsightsError}</p>
                </div>
              )}
            </div>
          </div>
          {/* Service Providers Hub */}
          <div className="card mp-services-card">
            <div className="card-header">
              <h3>{tr('marketplace.serviceProvidersHub.title', 'Service Providers Hub')}</h3>
              <div className="mp-search-bar">
                <i className="fa-solid fa-search"></i>
                <input type="text" placeholder={tr('marketplace.search.placeholderShort', 'Search services...')} />
              </div>
            </div>
            
            <div className="mp-services-grid">
              <div className="mp-service-category" style={{ opacity: 0.55 }}>
                <div>
                  <div className="mp-service-icon cdl-protection">
                  <i className="fa-solid fa-shield"></i>
                </div>
                <h4>{tr('marketplace.categories.cdlProtection.title', 'CDL Protection (TVC)')}</h4>
                <p>{tr('marketplace.categories.cdlProtection.body', 'Protect your CDL with expert legal representation and violation defense services.')}</p>
                <span className="mp-coming-soon-tag">{tr('marketplace.comingSoon', 'Coming Soon')}</span>
                </div>
                <button className="btn small-cd" disabled style={{marginTop: '20px', width: '100%', cursor: 'not-allowed'}}>{tr('marketplace.explore', 'Explore')}</button>
              </div>

              <div className="mp-service-category" style={{ opacity: 0.55 }}>
                <div>
                  <div className="mp-service-icon eld-solutions">
                  <i className="fa-solid fa-tablet-screen-button"></i>
                </div>
                <h4>{tr('marketplace.categories.eldSolutions.title', 'ELD Solutions')}</h4>
                <p>{tr('marketplace.categories.eldSolutions.body', 'Advanced ELD integrations with real-time compliance monitoring and reporting.')}</p>
                <span className="mp-coming-soon-tag">{tr('marketplace.comingSoon', 'Coming Soon')}</span>
                </div>
                <button className="btn small-cd" disabled style={{marginTop: '20px', width: '100%', cursor: 'not-allowed'}}>{tr('marketplace.explore', 'Explore')}</button>
              </div>

              <div className="mp-service-category">
                <div>
                  <div className="mp-service-icon fuel-programs">
                  <i className="fa-solid fa-gas-pump"></i>
                </div>
                <h4>{tr('marketplace.categories.fuelPrograms.title', 'Fuel Programs')}</h4>
                <p>{tr('marketplace.categories.fuelPrograms.body', 'Access exclusive fuel discounts and rewards programs nationwide.')}</p>
                <span className="int-status-badge active">{tr('marketplace.categories.fuelPrograms.badge', 'Save up to 15Â¢/gal')}</span>
                </div>
                <button
                  className="btn small-cd"
                  style={{marginTop: '20px', width: '100%'}}
                  onClick={() => handleServiceTypeClick('fuel')}
                >
                  {tr('marketplace.explore', 'Explore')}
                </button>
              </div>

              <div className="mp-service-category">
                <div>
                  <div className="mp-service-icon roadside">
                  <i className="fa-solid fa-wrench"></i>
                </div>
                <h4>{tr('marketplace.categories.roadsideRepair.title', 'Roadside Repair')}</h4>
                <p>{tr('marketplace.categories.roadsideRepair.body', '24/7 roadside assistance and repair network for emergency breakdowns.')}</p>
                <span className="int-status-badge warning">{tr('marketplace.categories.roadsideRepair.badge', '24/7 Available')}</span>
                </div>
                <button
                  className="btn small-cd"
                  style={{marginTop: '20px', width: '100%'}}
                  onClick={() => handleServiceTypeClick('repair')}
                >
                  {tr('marketplace.explore', 'Explore')}
                </button>
              </div>

              <div className="mp-service-category" style={{ opacity: 0.55 }}>
                <div>
                  <div className="mp-service-icon training">
                  <i className="fa-solid fa-graduation-cap"></i>
                </div>
                <h4>{tr('marketplace.categories.trainingCompliance.title', 'Training & Compliance')}</h4>
                <p>{tr('marketplace.categories.trainingCompliance.body', 'Continuing education and compliance training to advance your career.')}</p>
                <span className="mp-coming-soon-tag">{tr('marketplace.comingSoon', 'Coming Soon')}</span>
                </div>
                <button className="btn small-cd" disabled style={{marginTop: '20px', width: '100%', cursor: 'not-allowed'}}>{tr('marketplace.explore', 'Explore')}</button>
              </div>

              <div className="mp-service-category" style={{ opacity: 0.55 }}>
                <div>
                  <div className="mp-service-icon financial">
                  <i className="fa-solid fa-credit-card"></i>
                </div>
                <h4>{tr('marketplace.categories.financialServices.title', 'Financial Services')}</h4>
                <p>{tr('marketplace.categories.financialServices.body', 'Banking, factoring, and financial planning services for drivers.')}</p>
                <span className="mp-coming-soon-tag">{tr('marketplace.comingSoon', 'Coming Soon')}</span>
                </div>
                <button className="btn small-cd" disabled style={{marginTop: '20px', width: '100%', cursor: 'not-allowed'}}>{tr('marketplace.explore', 'Explore')}</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  function ServiceTypeModal() {
    if (!showServiceModal) return null;
    return (
      <div className="modal-overlay" onClick={() => setShowServiceModal(false)}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '800px', maxHeight: '80vh', overflowY: 'auto' }}>
          <div className="modal-header">
            <h2 style={{ textTransform: 'capitalize' }}>
              {selectedServiceType === 'fuel' && <i className="fa-solid fa-gas-pump" style={{ marginRight: '10px', color: '#3b82f6' }}></i>}
              {selectedServiceType === 'parking' && <i className="fa-solid fa-parking" style={{ marginRight: '10px', color: '#8b5cf6' }}></i>}
              {selectedServiceType === 'repair' && <i className="fa-solid fa-wrench" style={{ marginRight: '10px', color: '#f59e0b' }}></i>}
              {selectedServiceType === 'legal' && <i className="fa-solid fa-scale-balanced" style={{ marginRight: '10px', color: '#ef4444' }}></i>}
              {selectedServiceType === 'training' && <i className="fa-solid fa-graduation-cap" style={{ marginRight: '10px', color: '#10b981' }}></i>}
              {selectedServiceType === 'eld' && <i className="fa-solid fa-mobile-screen" style={{ marginRight: '10px', color: '#6366f1' }}></i>}
              {trServiceType(selectedServiceType)} {tr('marketplace.servicesSuffix', 'Services')}
            </h2>
            <button className="modal-close" onClick={() => setShowServiceModal(false)}>
              <i className="fa-solid fa-times"></i>
            </button>
          </div>
          <div className="modal-body">
            {locationLoading && (
              <div style={{ padding: '40px', textAlign: 'center' }}>
                <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '2rem', color: '#3b82f6' }}></i>
                <p style={{ marginTop: '10px', color: mpTheme.muted }}>{tr('marketplace.loadingServices', 'Loading services...')}</p>
              </div>
            )}

            {!locationLoading && getFilteredServices(selectedServiceType).length === 0 && (
              <div style={{ padding: '40px', textAlign: 'center' }}>
                <i className="fa-solid fa-circle-exclamation" style={{ fontSize: '2rem', color: '#f59e0b' }}></i>
                <p style={{ marginTop: '15px', color: mpTheme.muted, fontWeight: '600' }}>
                  {tr('marketplace.noServicesOfTypePrefix', 'No ') + trServiceType(selectedServiceType) + tr('marketplace.noServicesOfTypeSuffix', ' services found nearby')}
                </p>
                <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginTop: '8px' }}>
                  {tr('marketplace.tryExpandOrLater', 'Try expanding your search radius or check back later')}
                </p>
              </div>
            )}

            {!locationLoading && getFilteredServices(selectedServiceType).map((service) => (
              <div key={service.id} style={{
                background: mpTheme.surfaceAlt,
                borderRadius: '12px',
                padding: '20px',
                marginBottom: '15px',
                border: `1px solid ${mpTheme.border}`
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                      <h3 style={{ margin: 0, color: mpTheme.text }}>{service.name}</h3>
                      {service.verified && (
                        <span className="int-status-badge active" style={{ fontSize: '0.75rem' }}>
                          <i className="fa-solid fa-check-circle" style={{ marginRight: '4px' }}></i>
                          {tr('marketplace.verified', 'Verified')}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginBottom: '10px', flexWrap: 'wrap' }}>
                      {service.distance && (
                        <span style={{ color: '#3b82f6', fontWeight: '600', fontSize: '0.875rem' }}>
                          <i className="fa-solid fa-location-arrow" style={{ marginRight: '4px' }}></i>
                          {service.distance.toFixed(1)} {tr('marketplace.units.milesAway', 'miles away')}
                        </span>
                      )}
                      <span style={{ color: mpTheme.muted, fontSize: '0.875rem' }}>
                        <i className="fa-solid fa-clock" style={{ marginRight: '4px' }}></i>
                        {service.openStatus}
                      </span>
                    </div>

                    <p style={{ color: mpTheme.muted, marginBottom: '10px', fontSize: '0.9375rem' }}>
                      {service.description}
                    </p>

                    {service.address && (
                      <p style={{ color: mpTheme.muted, fontSize: '0.875rem', marginBottom: '8px' }}>
                        <i className="fa-solid fa-location-dot" style={{ marginRight: '6px' }}></i>
                        {service.address}
                      </p>
                    )}

                    <div style={{ display: 'flex', gap: '10px', marginTop: '15px', flexWrap: 'wrap' }}>
                      {service.phone && (
                        <a
                          href={`tel:${service.phone}`}
                          className="btn small-cd"
                          style={{ textDecoration: 'none' }}
                        >
                          <i className="fa-solid fa-phone" style={{ marginRight: '6px' }}></i>
                          {tr('marketplace.call', 'Call')}
                        </a>
                      )}
                      {service.website && (
                        <a
                          href={service.website}
                          target="_blank"
                          rel="noreferrer"
                          className="btn small ghost-cd"
                          style={{ textDecoration: 'none' }}
                        >
                          <i className="fa-solid fa-globe" style={{ marginRight: '6px' }}></i>
                          {tr('marketplace.website', 'Website')}
                        </a>
                      )}
                      <button
                        className="btn small ghost-cd"
                        onClick={() => handleToggleFavorite(service)}
                      >
                        <i className={`fa-${favoriteServices.includes(service.id) ? 'solid' : 'regular'} fa-heart`} style={{ marginRight: '6px' }}></i>
                        {favoriteServices.includes(service.id) ? tr('marketplace.saved', 'Saved') : tr('marketplace.save', 'Save')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (isPostHire) {
    return (
      <>
        <PostHireMarketplaceView />
        <ServiceTypeModal />
      </>
    );
  }

  return (
    <div className="dd-marketplace">
      <header className="fp-header">
        <div className="fp-header-titles">
          <h2>{tr('marketplace.title', 'Marketplace')}</h2>
          <p className="fp-subtitle">{tr('marketplace.subtitle', 'Your smart CDL staffing hub - connect with carriers and service providers')}</p>
          <button onClick={() => setIsPostHire(true)} className="btn small green-btn">{tr('marketplace.postHire', 'Post Hire')}</button>
        </div>
      </header>
      
      <section className="fp-grid">
        {/* Availability Status Alert - Dynamic based on isAvailable */}
        <div className="card mp-alert-card">
          <div className="mp-alert-content">
            {isAvailable ? (
              <>
                <i className="fa-solid fa-eye mp-alert-icon" style={{ color: '#10b981' }}></i>
                <div className="mp-alert-text">
                  <span className="mp-alert-title" style={{ color: '#10b981' }}>{tr('marketplace.visibility.visibleTitle', 'You are currently visible to carriers')}</span>
                  <p className="mp-alert-subtitle">{tr('marketplace.visibility.visibleSubtitle', "You're in the hiring pool and can receive job offers")}</p>
                </div>
                <button 
                  className="btn small-cd"
                  onClick={onAvailabilityToggle}
                  style={{ background: '#6c757d' }}
                >
                  <i className="fa-solid fa-eye-slash" style={{ marginRight: '6px' }}></i>
                  {tr('marketplace.visibility.hide', 'Hide from Carriers')}
                </button>
              </>
            ) : (
              <>
                <i className="fa-solid fa-eye-slash mp-alert-icon"></i>
                <div className="mp-alert-text">
                  <span className="mp-alert-title">{tr('marketplace.visibility.hiddenTitle', 'You are currently hidden from carriers')}</span>
                  <p className="mp-alert-subtitle">{tr('marketplace.visibility.hiddenSubtitle', "Toggle 'Available' to enter the hiring pool")}</p>
                </div>
                <button 
                  className="btn small-cd"
                  onClick={onAvailabilityToggle}
                >
                  <i className="fa-solid fa-eye" style={{ marginRight: '6px' }}></i>
                  {tr('marketplace.driverAvailability.becomeAvailable', 'Become Available')}
                </button>
              </>
            )}
          </div>
        </div>

        {/* GPS-Based Services */}
        <div className="card mp-gps-services-card">
          <div className="card-header">
            <h3>{tr('marketplace.gpsServices.title', 'GPS-Based Services')}</h3>
            {location && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.875rem' }}>
                <i className={`fa-solid ${method === 'gps' ? 'fa-satellite-dish' : 'fa-wifi'}`} 
                   style={{ color: method === 'gps' ? '#10b981' : '#f59e0b' }}></i>
                <span style={{ color: mpTheme.muted }}>
                  {(method === 'gps' ? tr('marketplace.location.gps', 'GPS Location') : tr('marketplace.location.wifi', 'WiFi Location'))}
                  {accuracy && accuracy < 100
                    ? tr('marketplace.location.highAccuracy', ' (High Accuracy)')
                    : accuracy && accuracy < 500
                    ? ` (Â±${Math.round(accuracy)}m)`
                    : tr('marketplace.location.lowAccuracy', ' (Low Accuracy)')}
                </span>
                <button 
                  onClick={refreshLocation}
                  className="btn small-cd"
                  style={{ marginLeft: '8px', fontSize: '0.75rem', padding: '4px 8px' }}
                >
                  <i className="fa-solid fa-refresh"></i>
                </button>
              </div>
            )}
          </div>
          
          {locationLoading && (
            <div style={{ padding: '20px', textAlign: 'center' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '1.5rem', color: '#3b82f6' }}></i>
              <p style={{ marginTop: '10px', color: mpTheme.muted }}>{tr('marketplace.gettingLocation', 'Getting your location...')}</p>
            </div>
          )}
          
          {locationError && (
            <div style={{ 
              padding: '20px', 
              textAlign: 'center', 
              background: isDarkMode ? 'rgba(239,68,68,0.12)' : '#fef2f2', 
              borderRadius: '8px', 
              margin: '10px' 
            }}>
              <i className="fa-solid fa-exclamation-triangle" style={{ color: '#ef4444', fontSize: '1.5rem' }}></i>
              <p style={{ marginTop: '10px', color: isDarkMode ? '#ef4444' : '#dc2626' }}>{locationError}</p>
              <button onClick={refreshLocation} className="btn small-cd" style={{ marginTop: '10px' }}>
                {tr('marketplace.tryAgain', 'Try Again')}
              </button>
            </div>
          )}
          
          {!locationLoading && !locationError && (
            <>
              <div className="mp-search-container">
                <div className="mp-search-input">
                  <i className="fa-solid fa-search"></i>
                  <input type="text" placeholder={tr('marketplace.search.placeholderNearYou', 'Search services near you...')} />
                </div>
              </div>

              <div className="mp-service-icons-grid">
                <div className="mp-service-icon-item" onClick={() => handleServiceTypeClick('fuel')} style={{ cursor: 'pointer' }}>
                  <div className="mp-service-icon fuel">
                    <i className="fa-solid fa-gas-pump"></i>
                  </div>
                  <span>{tr('marketplace.icons.fuelStations', 'Fuel Stations')}</span>
                </div>
                <div className="mp-service-icon-item" onClick={() => handleServiceTypeClick('parking')} style={{ cursor: 'pointer' }}>
                  <div className="mp-service-icon parking">
                    <i className="fa-solid fa-parking"></i>
                  </div>
                  <span>{trServiceType('parking')}</span>
                </div>
                <div className="mp-service-icon-item" onClick={() => handleServiceTypeClick('repair')} style={{ cursor: 'pointer' }}>
                  <div className="mp-service-icon repair">
                    <i className="fa-solid fa-wrench"></i>
                  </div>
                  <span>{tr('marketplace.icons.repairShops', 'Repair Shops')}</span>
                </div>
                <div className="mp-service-icon-item" onClick={() => handleServiceTypeClick('legal')} style={{ cursor: 'pointer' }}>
                  <div className="mp-service-icon cdl">
                    <i className="fa-solid fa-scale-balanced"></i>
                  </div>
                  <span>{tr('marketplace.icons.cdlProtection', 'CDL Protection')}</span>
                </div>
                <div className="mp-service-icon-item" onClick={() => handleServiceTypeClick('training')} style={{ cursor: 'pointer' }}>
                  <div className="mp-service-icon training">
                    <i className="fa-solid fa-graduation-cap"></i>
                  </div>
                  <span>{trServiceType('training')}</span>
                </div>
                <div className="mp-service-icon-item" onClick={() => handleServiceTypeClick('eld')} style={{ cursor: 'pointer' }}>
                  <div className="mp-service-icon eld">
                    <i className="fa-solid fa-mobile-screen"></i>
                  </div>
                  <span>{trServiceType('eld')}</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* AI Highlights */}
        <div className="card mp-highlights-card">
          <div className="card-header">
            <h3>{tr('marketplace.aiHighlights.title', 'AI Highlights')}</h3>
          </div>
          
          {location && nearbyServices.length > 0 && (
            <>
              <div className="mp-highlight-item">
                <div className="mp-highlight-icon">
                  <i className="fa-solid fa-gas-pump"></i>
                </div>
                <div className="mp-highlight-content">
                  <h4>{tr('marketplace.aiHighlights.fuelDiscountTitle', 'Fuel Discount Alert')}</h4>
                  <p>
                    {(nearbyServices.find(s => s.type === 'fuel')?.name || tr('marketplace.aiHighlights.nearbyFuelStation', 'Nearby Fuel Station'))} - 
                    {(nearbyServices.find(s => s.type === 'fuel')?.offers || tr('marketplace.aiHighlights.defaultFuelOffer', '10Â¢ off per gallon'))}, 
                    {(nearbyServices.find(s => s.type === 'fuel')?.distance?.toFixed(1) || '2.3')} {tr('marketplace.units.milesAhead', 'miles ahead')}
                  </p>
                </div>
              </div>

              {nearbyServices.find(s => s.type === 'parking') && (
                <div className="mp-highlight-item">
                  <div className="mp-highlight-icon">
                    <i className="fa-solid fa-parking"></i>
                  </div>
                  <div className="mp-highlight-content">
                    <h4>{tr('marketplace.aiHighlights.parkingAvailableTitle', 'Parking Available')}</h4>
                    <p>
                      {nearbyServices.find(s => s.type === 'parking').name} - 
                      {nearbyServices.find(s => s.type === 'parking').offers}, 
                      {nearbyServices.find(s => s.type === 'parking').distance?.toFixed(1)} {tr('marketplace.units.milesAway', 'miles away')}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          {(!location || nearbyServices.length === 0) && (
            <>
              <div className="mp-highlight-item">
                <div className="mp-highlight-icon">
                  <i className="fa-solid fa-gas-pump"></i>
                </div>
                <div className="mp-highlight-content">
                  <h4>{tr('marketplace.aiHighlights.fuelDiscountTitle', 'Fuel Discount Alert')}</h4>
                  <p>{tr('marketplace.aiHighlights.enableLocationForFuel', 'Enable location to see nearby fuel discounts')}</p>
                </div>
              </div>
            </>
          )}

          <div className="mp-highlight-item">
            <div className="mp-highlight-icon">
              <i className="fa-solid fa-exclamation-triangle"></i>
            </div>
            <div className="mp-highlight-content">
              <h4>{tr('marketplace.aiHighlights.cdlRenewalTitle', 'CDL Renewal Reminder')}</h4>
              <p>{tr('marketplace.aiHighlights.cdlRenewalBody', 'Your CDL expires in 45 days - renew to stay eligible')}</p>
            </div>
          </div>
        </div>

        {/* Nearby Service Providers */}
        <div className="card mp-nearby-providers-card">
          <div className="card-header">
            <h3>{tr('marketplace.nearbyProviders.title', 'Nearby Service Providers')}</h3>
            <div className="mp-filter-controls">
              <button className="btn small mp-filter-btn" onClick={() => setShowFilterModal(true)}>
                <i className="fa-solid fa-filter"></i>
                {tr('marketplace.filters', 'Filters')}
              </button>
              <button 
                className={`btn small mp-favorites-btn ${showFavoritesOnly ? 'active' : ''}`}
                onClick={handleFavoritesClick}
              >
                <i className={`fa-${showFavoritesOnly ? 'solid' : 'regular'} fa-heart`}></i>
                {tr('marketplace.favorites', 'Favorites')} {favoriteServices.length > 0 && `(${favoriteServices.length})`}
              </button>
            </div>
          </div>

          {locationLoading && (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '1.5rem', color: '#3b82f6' }}></i>
              <p style={{ marginTop: '10px', color: mpTheme.muted }}>{tr('marketplace.loadingNearbyServices', 'Loading nearby services...')}</p>
            </div>
          )}

          {!locationLoading && locationError && (
            <div style={{ 
              padding: '40px', 
              textAlign: 'center',
              background: isDarkMode ? 'rgba(239,68,68,0.12)' : '#fef2f2',
              borderRadius: '8px',
              margin: '10px'
            }}>
              <i className="fa-solid fa-location-crosshairs" style={{ color: '#ef4444', fontSize: '2rem' }}></i>
              <p style={{ marginTop: '15px', color: isDarkMode ? '#ef4444' : '#dc2626', fontWeight: '600' }}>
                {tr('marketplace.locationRequired.title', 'Location Required')}
              </p>
              <p style={{ color: mpTheme.muted, marginTop: '8px' }}>
                {tr('marketplace.locationRequired.body', 'Enable location services to see nearby providers')}
              </p>
              <button onClick={refreshLocation} className="btn small-cd" style={{ marginTop: '15px' }}>
                {tr('marketplace.locationRequired.enable', 'Enable Location')}
              </button>
            </div>
          )}

          {!locationLoading && !locationError && nearbyServices.length > 0 && (
            <>
              {/* Filter/Favorites Status Banner */}
              {(showFavoritesOnly || Object.values(selectedFilters).some(v => v)) && (
                <div style={{
                  padding: '12px',
                  background: isDarkMode
                    ? (showFavoritesOnly ? 'rgba(239,68,68,0.10)' : 'rgba(59,130,246,0.10)')
                    : (showFavoritesOnly ? '#fef2f2' : '#eff6ff'),
                  borderRadius: '8px',
                  margin: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '0.875rem'
                }}>
                  <div>
                    {showFavoritesOnly ? (
                      <span style={{ color: isDarkMode ? '#ef4444' : '#991b1b', fontWeight: '600' }}>
                        <i className="fa-solid fa-heart" style={{ marginRight: '6px' }}></i>
                        {tr('marketplace.banner.showingFavoritesPrefix', 'Showing ') +
                          getFilteredByCategory().length +
                          ' ' +
                          (getFilteredByCategory().length === 1
                            ? tr('marketplace.banner.favoriteServiceSingular', 'favorite service')
                            : tr('marketplace.banner.favoriteServicePlural', 'favorite services'))}
                      </span>
                    ) : (
                      <span style={{ color: isDarkMode ? '#3b82f6' : '#1e40af', fontWeight: '600' }}>
                        <i className="fa-solid fa-filter" style={{ marginRight: '6px' }}></i>
                        {tr('marketplace.banner.filtersAppliedPrefix', 'Filters applied: ') +
                          Object.entries(selectedFilters)
                            .filter(([_k, v]) => v)
                            .map(([k]) => trServiceType(k))
                            .join(', ')}
                      </span>
                    )}
                  </div>
                  <button 
                    className="btn small"
                    onClick={() => {
                      if (showFavoritesOnly) {
                        setShowFavoritesOnly(false);
                      } else {
                        setSelectedFilters({
                          fuel: false,
                          parking: false,
                          repair: false,
                          legal: false,
                          training: false,
                          eld: false
                        });
                      }
                    }}
                    style={{ 
                      padding: '4px 10px', 
                      fontSize: '0.75rem'
                    }}
                  >
                    {tr('marketplace.clear', 'Clear')}
                  </button>
                </div>
              )}
              
              {/* Debug info logged to console instead of UI */}
              {(() => {
                console.log(`ðŸ“Š Services: ${nearbyServices.length} total (${nearbyServices.filter(s => s.type === 'fuel').length} fuel stations)`);
                console.log(`ðŸ“ Location: ${location?.latitude.toFixed(4)}, ${location?.longitude.toFixed(4)} | Method: ${method}`);
                console.log('ðŸ” Nearest 5:', nearbyServices.slice(0, 5).map(s => `${s.name} (${s.type}, ${s.distance?.toFixed(1)}mi)`));
                return null;
              })()}
              
              <div className="mp-provider-list">
              
              {/* Filtered Services */}
              {getFilteredByCategory().map((service) => {
                const serviceIcons = {
                  fuel: 'fa-gas-pump',
                  repair: 'fa-wrench',
                  parking: 'fa-parking',
                  legal: 'fa-scale-balanced',
                  training: 'fa-graduation-cap',
                  eld: 'fa-mobile-screen'
                };

                return (
                  <div key={service.id} className="mp-provider-item">
                    <div className={`mp-provider-icon ${service.type}`}>
                      <i className={`fa-solid ${serviceIcons[service.type] || 'fa-store'}`}></i>
                    </div>
                    <div className="mp-provider-info">
                      <h4>{service.name}</h4>
                      <p>
                        {(service.distance ? `${service.distance.toFixed(1)} ${tr('marketplace.units.miles', 'miles')}` : tr('marketplace.nearby', 'Nearby'))} â€¢ {service.openStatus}
                      </p>
                      <p className="mp-provider-description">{service.description}</p>
                      {service.offers && (
                        <span className="mp-provider-offer">{service.offers}</span>
                      )}
                      {service.address && (
                        <p style={{ fontSize: '0.875rem', color: mpTheme.muted, marginTop: '4px' }}>
                          <i className="fa-solid fa-location-dot" style={{ marginRight: '4px' }}></i>
                          {service.address}
                        </p>
                      )}
                    </div>
                    <div className="mp-provider-actions">
                      {service.verified && (
                        <span className="int-status-badge active">
                          {tr('marketplace.verified', 'Verified')}
                        </span>
                      )}
                      <button 
                        className="favorite-btn"
                        onClick={() => handleToggleFavorite(service)}
                        style={{ 
                          marginBottom: '8px',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '1.5rem',
                          color: favoriteServices.includes(service.id) ? '#ef4444' : '#cbd5e1',
                          transition: 'all 0.2s'
                        }}
                        title={favoriteServices.includes(service.id)
                          ? tr('marketplace.favorites.remove', 'Remove from favorites')
                          : tr('marketplace.favorites.add', 'Add to favorites')}
                      >
                        <i className={`fa-${favoriteServices.includes(service.id) ? 'solid' : 'regular'} fa-heart`}></i>
                      </button>
                      <button 
                        className="btn small-cd" 
                        onClick={() => handleContact(service)}
                        style={{ marginTop: '8px', width: '100%' }}
                      >
                        <i className="fa-solid fa-phone" style={{ marginRight: '6px' }}></i>
                        {tr('marketplace.contact', 'Contact')}
                      </button>
                      {service.latitude && service.longitude && (
                        <button 
                          className="btn small"
                          onClick={() => {
                            const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${service.latitude},${service.longitude}`;
                            window.open(mapsUrl, '_blank');
                          }}
                          style={{ marginTop: '8px', width: '100%' }}
                            title={tr('marketplace.openInGoogleMaps', 'Open in Google Maps')}
                        >
                          <i className="fa-solid fa-map-location-dot" style={{ marginRight: '6px' }}></i>
                          {tr('marketplace.locate', 'Locate')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {!locationLoading && !locationError && showFavoritesOnly && favoriteServices.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-regular fa-heart" style={{ fontSize: '2rem', color: '#94a3b8' }}></i>
              <p style={{ marginTop: '15px', color: mpTheme.muted, fontWeight: '600' }}>
                {tr('marketplace.noFavoritesYet', 'No favorites yet')}
              </p>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginTop: '8px' }}>
                {tr('marketplace.noFavoritesBody', 'Click the heart icon on any service to add it to your favorites')}
              </p>
            </div>
          )}

          {!locationLoading && !locationError && !showFavoritesOnly && nearbyServices.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <i className="fa-solid fa-map-location-dot" style={{ fontSize: '2rem', color: '#94a3b8' }}></i>
              <p style={{ marginTop: '15px', color: mpTheme.muted }}>
                {tr('marketplace.noServicesInArea', 'No services found in your area')}
              </p>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginTop: '8px' }}>
                {tr('marketplace.tryExpandRadius', 'Try expanding your search radius')}
              </p>
              
              {/* Debug Information */}
              <div style={{ 
                marginTop: '20px', 
                padding: '15px', 
                background: isDarkMode ? 'rgba(245,158,11,0.14)' : '#fef3c7', 
                borderRadius: '8px', 
                textAlign: 'left',
                fontSize: '0.875rem',
                fontFamily: 'monospace'
              }}>
                <strong style={{ color: isDarkMode ? '#f59e0b' : '#92400e' }}>{tr('marketplace.debug.title', 'ðŸ› Debug Info:')}</strong>
                <div style={{ marginTop: '8px', color: isDarkMode ? mpTheme.text : '#78350f' }}>
                  <div>{tr('marketplace.debug.locationLoading', 'Location Loading: ')}{locationLoading ? tr('marketplace.debug.yes', 'Yes') : tr('marketplace.debug.no', 'No')}</div>
                  <div>{tr('marketplace.debug.locationError', 'Location Error: ')}{locationError || tr('marketplace.debug.none', 'None')}</div>
                  <div>{tr('marketplace.debug.location', 'Location: ')}{location ? `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}` : tr('marketplace.debug.notAvailable', 'Not available')}</div>
                  <div>{tr('marketplace.debug.method', 'Method: ')}{method || tr('marketplace.debug.notDetected', 'Not detected')}</div>
                  <div>{tr('marketplace.debug.servicesCount', 'Services Count: ')}{nearbyServices.length}</div>
                  <div>{tr('marketplace.debug.currentUser', 'Current User: ')}{currentUser ? tr('marketplace.debug.loggedIn', 'Logged in') : tr('marketplace.debug.notLoggedIn', 'Not logged in')}</div>
                </div>
                <button 
                  onClick={() => {
                    console.log('Full Debug State:', {
                      location,
                      locationLoading,
                      locationError,
                      method,
                      accuracy,
                      nearbyServices,
                      currentUser: !!currentUser
                    });
                  }}
                  className="btn small-cd"
                  style={{ marginTop: '10px', fontSize: '0.75rem' }}
                >
                  {tr('marketplace.debug.logFullState', 'Log Full State to Console')}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <ServiceTypeModal />

      {/* Filter Modal */}
      {showFilterModal && (
        <div className="modal-overlay" onClick={() => setShowFilterModal(false)}>
          <div className="modal-content filter-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
            <div className="modal-header">
              <h2>
                <i className="fa-solid fa-filter" style={{ marginRight: '10px', color: '#3b82f6' }}></i>
                {tr('marketplace.filterModal.title', 'Service Filters')}
              </h2>
              <button className="modal-close" onClick={() => setShowFilterModal(false)}>
                <i className="fa-solid fa-times"></i>
              </button>
            </div>
            <div className="modal-body">
              <p style={{ color: mpTheme.muted, fontSize: '0.875rem', marginBottom: '16px' }}>
                {tr('marketplace.filterModal.subtitle', 'Select service categories to display')}
              </p>

              <div className="filter-options-horizontal">
                <div className="filter-option-compact" onClick={() => handleFilterToggle('fuel')}>
                  <div className={`filter-checkbox ${selectedFilters.fuel ? 'checked' : ''}`}>
                    {selectedFilters.fuel && <i className="fa-solid fa-check"></i>}
                  </div>
                  <div className="filter-icon fuel">
                    <i className="fa-solid fa-gas-pump"></i>
                  </div>
                  <span className="filter-label-compact">{trServiceType('fuel')}</span>
                  <span className="filter-count-compact">
                    {nearbyServices.filter(s => s.type === 'fuel').length}
                  </span>
                </div>

                <div className="filter-option-compact" onClick={() => handleFilterToggle('parking')}>
                  <div className={`filter-checkbox ${selectedFilters.parking ? 'checked' : ''}`}>
                    {selectedFilters.parking && <i className="fa-solid fa-check"></i>}
                  </div>
                  <div className="filter-icon parking">
                    <i className="fa-solid fa-parking"></i>
                  </div>
                  <span className="filter-label-compact">{trServiceType('parking')}</span>
                  <span className="filter-count-compact">
                    {nearbyServices.filter(s => s.type === 'parking').length}
                  </span>
                </div>

                <div className="filter-option-compact" onClick={() => handleFilterToggle('repair')}>
                  <div className={`filter-checkbox ${selectedFilters.repair ? 'checked' : ''}`}>
                    {selectedFilters.repair && <i className="fa-solid fa-check"></i>}
                  </div>
                  <div className="filter-icon repair">
                    <i className="fa-solid fa-wrench"></i>
                  </div>
                  <span className="filter-label-compact">{trServiceType('repair')}</span>
                  <span className="filter-count-compact">
                    {nearbyServices.filter(s => s.type === 'repair').length}
                  </span>
                </div>

                <div className="filter-option-compact" onClick={() => handleFilterToggle('legal')}>
                  <div className={`filter-checkbox ${selectedFilters.legal ? 'checked' : ''}`}>
                    {selectedFilters.legal && <i className="fa-solid fa-check"></i>}
                  </div>
                  <div className="filter-icon cdl">
                    <i className="fa-solid fa-scale-balanced"></i>
                  </div>
                  <span className="filter-label-compact">{trServiceType('legal')}</span>
                  <span className="filter-count-compact">
                    {nearbyServices.filter(s => s.type === 'legal').length}
                  </span>
                </div>

                <div className="filter-option-compact" onClick={() => handleFilterToggle('training')}>
                  <div className={`filter-checkbox ${selectedFilters.training ? 'checked' : ''}`}>
                    {selectedFilters.training && <i className="fa-solid fa-check"></i>}
                  </div>
                  <div className="filter-icon training">
                    <i className="fa-solid fa-graduation-cap"></i>
                  </div>
                  <span className="filter-label-compact">{trServiceType('training')}</span>
                  <span className="filter-count-compact">
                    {nearbyServices.filter(s => s.type === 'training').length}
                  </span>
                </div>

                <div className="filter-option-compact" onClick={() => handleFilterToggle('eld')}>
                  <div className={`filter-checkbox ${selectedFilters.eld ? 'checked' : ''}`}>
                    {selectedFilters.eld && <i className="fa-solid fa-check"></i>}
                  </div>
                  <div className="filter-icon eld">
                    <i className="fa-solid fa-mobile-screen"></i>
                  </div>
                  <span className="filter-label-compact">{trServiceType('eld')}</span>
                  <span className="filter-count-compact">
                    {nearbyServices.filter(s => s.type === 'eld').length}
                  </span>
                </div>
              </div>

              <div className="filter-actions">
                <button 
                  className="btn small" 
                  onClick={handleSelectAllFilters}
                  style={{ flex: 1 }}
                >
                  {Object.values(selectedFilters).every(v => v)
                    ? tr('marketplace.filterModal.deselectAll', 'Deselect All')
                    : tr('marketplace.filterModal.selectAll', 'Select All')}
                </button>
                <button 
                  className="btn small-cd" 
                  onClick={() => setShowFilterModal(false)}
                  style={{ flex: 1 }}
                >
                  {tr('marketplace.filterModal.apply', 'Apply Filters')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
