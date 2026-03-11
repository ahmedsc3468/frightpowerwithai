import React, { useState, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { API_URL } from '../../config'
import LoadDetailsModal from './LoadDetailsModal'
import '../../styles/carrier/ShipperPartners.css'
// Use public placeholder user avatars instead of onboarding images
const avatarUrls = [
  'https://i.pravatar.cc/80?img=12',
  'https://i.pravatar.cc/80?img=32',
  'https://i.pravatar.cc/80?img=45',
  'https://i.pravatar.cc/80?img=56',
  'https://i.pravatar.cc/80?img=14',
  'https://i.pravatar.cc/80?img=21',
  'https://i.pravatar.cc/80?img=36',
  'https://i.pravatar.cc/80?img=8'
]

const FAVORITES_STORAGE_KEY = 'fp_carrier_partner_favorites_v1'

const stableHash = (value) => {
  const str = String(value ?? '')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash
}

const avatarForKey = (key) => {
  const idx = stableHash(key) % avatarUrls.length
  return avatarUrls[idx]
}

const normalizePartnerStatus = (rawStatus) => {
  const s = String(rawStatus ?? '').trim().toLowerCase()
  if (s === 'active' || s === 'partnered' || s === 'accepted') return 'Partnered'
  if (s === 'pending') return 'Pending'
  if (!s) return 'Partnered'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const partnerTypeLabel = (roleOrType) => {
  const v = String(roleOrType ?? '').trim().toLowerCase()
  if (!v) return ''
  if (v === 'broker') return 'Broker'
  if (v === 'shipper') return 'Shipper'
  if (v === 'shipper_broker' || v === 'shipper-broker' || v === 'shippers/brokers') return 'Shipper/Broker'
  return v.charAt(0).toUpperCase() + v.slice(1)
}

export default function ShipperPartners(){
  const { currentUser } = useAuth();
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [activeTab, setActiveTab] = useState('all') // all | favorites | invites | history
  const [partnersPage, setPartnersPage] = useState(1)
  const partnersPageSize = 10
  const [partners, setPartners] = useState([])
  const [invites, setInvites] = useState([])
  const [outgoingRequests, setOutgoingRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingInvites, setLoadingInvites] = useState(true)
  const [errorPartners, setErrorPartners] = useState('')
  const [errorInvites, setErrorInvites] = useState('')
  const [favoriteIds, setFavoriteIds] = useState(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_STORAGE_KEY)
      const arr = JSON.parse(raw || '[]')
      if (Array.isArray(arr)) return new Set(arr.map(String))
    } catch (e) {
      // ignore
    }
    return new Set()
  })

  // Fetch partners (accepted relationships)
  useEffect(() => {
    if (currentUser) fetchPartners()
  }, [currentUser]);

  // Fetch invitations
  useEffect(() => {
    if (currentUser && activeTab === 'invites') {
      fetchInvitations();
    }
  }, [currentUser, activeTab]);

  // Reset paging when filters/search change
  useEffect(() => {
    setPartnersPage(1)
  }, [query, statusFilter])

  const fetchPartners = async () => {
    if (!currentUser) return;
    setLoading(true);
    setErrorPartners('');
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/shippers/my-shippers`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const formattedPartners = (data.shippers || []).map(rel => {
          const shipperId = String(rel.shipper_id || rel.shipper_uid || rel.shipperId || '')
          const relationshipId = String(rel.id || rel.relationship_id || '')
          const favorite = favoriteIds.has(shipperId)
          const type = partnerTypeLabel(rel.shipper_role || rel.partner_type || rel.type)

          return {
            id: shipperId,
            relationshipId,
            name: rel.shipper_company || rel.shipper_name || rel.shipper_email || 'Unknown Partner',
            mc: type,
            contactName: rel.shipper_name || 'N/A',
            contactEmail: rel.shipper_email || '',
            phone: rel.shipper_phone || 'N/A',
            loads: rel.loads_completed || rel.loads || 0,
            avgPay: rel.avg_pay_speed || rel.avgPay || 'N/A',
            dispute: rel.dispute_rate || rel.dispute || 'N/A',
            status: normalizePartnerStatus(rel.status),
            favorite,
            rating: rel.rating || 0,
            onTime: rel.on_time_rate || rel.onTime || 'N/A',
            lastLoad: rel.last_load || rel.lastLoad || 'N/A',
            location: rel.location || 'N/A',
            acceptedAt: rel.accepted_at || rel.created_at || null
          }
        });
        setPartners(formattedPartners);
      } else {
        const msg = await response.text();
        setErrorPartners(msg || 'Failed to load partners');
        setPartners([]);
      }
    } catch (error) {
      console.error('Error fetching partners:', error);
      setErrorPartners('Failed to load partners');
      setPartners([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchInvitations = async () => {
    if (!currentUser) return;
    setLoadingInvites(true);
    setErrorInvites('');
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/carriers/invitations`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const formattedInvites = (data.invitations || []).map(inv => {
          const company = inv.shipper_company || ''
          const displayName = inv.shipper_name || ''
          const email = inv.shipper_email || ''
          const primaryName = String(company || displayName || email || 'Unknown Partner')

          return {
            id: String(inv.id || ''),
            invitationId: String(inv.id || ''),
            shipperId: String(inv.shipper_id || ''),
            name: primaryName,
            company: String(company || ''),
            contactName: String(displayName || ''),
            type: partnerTypeLabel(inv.shipper_role || inv.partner_type || inv.type),
            role: String(inv.shipper_role || ''),
            email: String(email || ''),
            phone: String(inv.shipper_phone || ''),
            state: String(inv.shipper_state || ''),
            city: String(inv.shipper_city || ''),
            rating: typeof inv.rating === 'number' ? inv.rating : null,
            status: String(inv.status || ''),
            badge: normalizePartnerStatus(inv.status),
            message: typeof inv.message === 'string' ? inv.message.trim() : '',
            createdAt: inv.created_at || null,
            acceptedAt: inv.accepted_at || null,
            received: inv.created_at ? formatRelativeTime(inv.created_at) : 'Recently'
          }
        });
        setInvites(formattedInvites);
      } else {
        const msg = await response.text();
        setErrorInvites(msg || 'Failed to load invitations');
        setInvites([]);
      }
    } catch (error) {
      console.error('Error fetching invitations:', error);
      setErrorInvites('Failed to load invitations');
      setInvites([]);
    } finally {
      setLoadingInvites(false);
    }
  };

  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return 'Recently';
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  };

  const handleAcceptInvite = async (invitationId) => {
    if (!currentUser) return;
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/carriers/invitations/${invitationId}/accept`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        alert('Invitation accepted! The partner has been added to your list.');
        // Refresh invitations and partners (real data only)
        await Promise.all([fetchInvitations(), fetchPartners()])
      } else {
        const error = await response.json();
        alert(error.detail || 'Failed to accept invitation');
      }
    } catch (error) {
      console.error('Error accepting invitation:', error);
      alert('Failed to accept invitation. Please try again.');
    }
  };

  const handleDeclineInvite = async (invitationId) => {
    if (!currentUser) return;
    if (!confirm('Are you sure you want to decline this invitation?')) return;

    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${API_URL}/carriers/invitations/${invitationId}/decline`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        alert('Invitation declined.');
        fetchInvitations();
      } else {
        const error = await response.json();
        alert(error.detail || 'Failed to decline invitation');
      }
    } catch (error) {
      console.error('Error declining invitation:', error);
      alert('Failed to decline invitation. Please try again.');
    }
  };

  const [localPartners, setLocalPartners] = useState([])
  const [openMenuId, setOpenMenuId] = useState(null)
  const [inviteTab, setInviteTab] = useState('incoming') // incoming | requests

  const [inviteQuery, setInviteQuery] = useState('')
  const [inviteStatusFilter, setInviteStatusFilter] = useState('pending') // all | pending | accepted | declined
  const [inviteRegionFilter, setInviteRegionFilter] = useState('all')

  const [favTypeFilter, setFavTypeFilter] = useState('all')
  const [favStatusFilter, setFavStatusFilter] = useState('all')
  const [favSort, setFavSort] = useState('name_asc')
  const [favRatingFilter, setFavRatingFilter] = useState('all')
  const [favLocationFilter, setFavLocationFilter] = useState('all')

  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileData, setProfileData] = useState(null)

  const [docsModalOpen, setDocsModalOpen] = useState(false)
  const [docsPartner, setDocsPartner] = useState(null)
  const [docsLoadsLoading, setDocsLoadsLoading] = useState(false)
  const [docsLoadsError, setDocsLoadsError] = useState('')
  const [docsLoads, setDocsLoads] = useState([])

  const [detailsLoad, setDetailsLoad] = useState(null)

  // Update localPartners when partners change
  useEffect(() => {
    setLocalPartners(partners);
  }, [partners, loading]);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favoriteIds)))
    } catch (e) {
      // ignore
    }
  }, [favoriteIds])

  const toggleFavorite = (partnerId) => {
    const id = String(partnerId || '')
    if (!id) return
    setFavoriteIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setLocalPartners(prev => prev.map(x => x.id === id ? { ...x, favorite: !x.favorite } : x))
  }

  const handleRemovePartner = async (relationshipId, partnerId) => {
    if (!currentUser) return
    if (!relationshipId) {
      alert('Unable to remove: missing relationship id')
      return
    }
    if (!confirm('Remove this partner?')) return

    try {
      const token = await currentUser.getIdToken()
      const response = await fetch(`${API_URL}/shipper-carrier-relationships/${relationshipId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })
      if (response.ok) {
        setLocalPartners(prev => prev.filter(p => p.relationshipId !== relationshipId))
        setPartners(prev => prev.filter(p => p.relationshipId !== relationshipId))
        setFavoriteIds(prev => {
          const next = new Set(prev)
          const id = String(partnerId || '')
          if (id) next.delete(id)
          return next
        })
      } else {
        const err = await response.json().catch(() => null)
        alert(err?.detail || 'Failed to remove partner')
      }
    } catch (e) {
      console.error('Error removing partner:', e)
      alert('Failed to remove partner')
    }
  }

  const openPartnerProfile = async (partnerId) => {
    const pid = String(partnerId || '').trim()
    if (!currentUser || !pid) return

    setProfileModalOpen(true)
    setProfileLoading(true)
    setProfileError('')
    setProfileData(null)
    try {
      const token = await currentUser.getIdToken()
      const res = await fetch(`${API_URL}/partners/${encodeURIComponent(pid)}/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setProfileError(err?.detail || 'Failed to load profile')
        return
      }
      const data = await res.json()
      setProfileData(data?.profile || null)
    } catch (e) {
      setProfileError(e?.message || 'Failed to load profile')
    } finally {
      setProfileLoading(false)
    }
  }

  const openPartnerDocs = async (partner) => {
    const pid = String(partner?.id || '').trim()
    if (!currentUser || !pid) return

    setDocsPartner(partner)
    setDocsModalOpen(true)
    setDocsLoadsLoading(true)
    setDocsLoadsError('')
    setDocsLoads([])
    try {
      const token = await currentUser.getIdToken()
      const res = await fetch(`${API_URL}/loads?page=1&page_size=250&exclude_drafts=true`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setDocsLoadsError(err?.detail || 'Failed to load loads')
        return
      }
      const data = await res.json()
      const allLoads = Array.isArray(data?.loads) ? data.loads : (Array.isArray(data) ? data : [])
      const filteredLoads = allLoads.filter(l => {
        const createdBy = String(l?.created_by || l?.createdBy || l?.shipper_id || '').trim()
        return createdBy && createdBy === pid
      })
      // Sort newest first
      filteredLoads.sort((a, b) => {
        const at = Number(a?.updated_at || a?.created_at || 0)
        const bt = Number(b?.updated_at || b?.created_at || 0)
        return bt - at
      })
      setDocsLoads(filteredLoads)
    } catch (e) {
      setDocsLoadsError(e?.message || 'Failed to load loads')
    } finally {
      setDocsLoadsLoading(false)
    }
  }

  const closeProfileModal = () => {
    setProfileModalOpen(false)
    setProfileLoading(false)
    setProfileError('')
    setProfileData(null)
  }

  const closeDocsModal = () => {
    setDocsModalOpen(false)
    setDocsPartner(null)
    setDocsLoads([])
    setDocsLoadsError('')
    setDocsLoadsLoading(false)
  }

  const filtered = localPartners.filter(p => {
    if (!p) return false

    const status = String(p.status || '').toLowerCase()
    if (statusFilter !== 'all' && status !== statusFilter) return false

    if (!query) return true
    const q = query.toLowerCase()
    const name = String(p.name || '').toLowerCase()
    const email = String(p.contactEmail || '').toLowerCase()
    return name.includes(q) || email.includes(q)
  })

  const totalPartnerPages = Math.max(1, Math.ceil(filtered.length / partnersPageSize))
  const safePartnersPage = Math.min(Math.max(1, partnersPage), totalPartnerPages)
  const startIdx = (safePartnersPage - 1) * partnersPageSize
  const endIdxExclusive = startIdx + partnersPageSize
  const pagedPartners = filtered.slice(startIdx, endIdxExclusive)

  useEffect(() => {
    if (partnersPage !== safePartnersPage) setPartnersPage(safePartnersPage)
  }, [partnersPage, safePartnersPage])

  const listForInviteTab = inviteTab === 'incoming' ? invites : outgoingRequests

  const filteredInviteList = listForInviteTab
    .filter(inv => {
      if (!inv) return false
      const status = String(inv.status || '').toLowerCase()
      if (inviteStatusFilter !== 'all' && status !== inviteStatusFilter) return false
      const region = String(inv.state || '').trim().toUpperCase()
      if (inviteRegionFilter !== 'all' && region !== inviteRegionFilter) return false

      const q = String(inviteQuery || '').trim().toLowerCase()
      if (!q) return true
      const hay = [inv.name, inv.company, inv.contactName, inv.email, inv.phone, inv.state, inv.city]
        .map(x => String(x || '').toLowerCase())
        .join(' | ')
      return hay.includes(q)
    })
    .sort((a, b) => {
      const at = Number(a?.createdAt || 0)
      const bt = Number(b?.createdAt || 0)
      return bt - at
    })

  const inviteStates = Array.from(
    new Set(
      listForInviteTab
        .map(i => String(i?.state || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ).sort()

  const pendingInvitesCount = invites.filter(i => String(i?.status || '').toLowerCase() === 'pending').length
  const activePartnersCount = partners.length

  const startOfMonthEpoch = (() => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
    return Math.floor(start.getTime() / 1000)
  })()
  const acceptedThisMonthCount = partners.filter(p => {
    const ts = Number(p?.acceptedAt || 0)
    return ts && ts >= startOfMonthEpoch
  }).length
  const requestsSentCount = outgoingRequests.length

  const favorites = localPartners.filter(p => p.favorite)

  const favoriteLocations = Array.from(
    new Set(
      favorites
        .map(f => String(f?.location || '').trim())
        .filter(v => v && v.toLowerCase() !== 'n/a')
    )
  ).sort((a, b) => a.localeCompare(b))

  const filteredFavorites = favorites
    .filter(p => {
      if (!p) return false
      if (favTypeFilter !== 'all') {
        const t = String(p?.mc || '').trim().toLowerCase()
        if (favTypeFilter === 'shipper' && t !== 'shipper') return false
        if (favTypeFilter === 'broker' && t !== 'broker') return false
      }
      if (favStatusFilter !== 'all') {
        const s = String(p?.status || '').trim().toLowerCase()
        if (s !== favStatusFilter) return false
      }
      if (favRatingFilter !== 'all') {
        const r = Number(p?.rating || 0)
        if (favRatingFilter === '4' && r < 4) return false
        if (favRatingFilter === '3' && r < 3) return false
      }
      if (favLocationFilter !== 'all') {
        const loc = String(p?.location || '').trim()
        if (loc !== favLocationFilter) return false
      }
      return true
    })
    .sort((a, b) => {
      const an = String(a?.name || '')
      const bn = String(b?.name || '')
      if (favSort === 'name_desc') return bn.localeCompare(an)
      return an.localeCompare(bn)
    })

  const clearFavFilters = () => {
    setFavTypeFilter('all')
    setFavStatusFilter('all')
    setFavSort('name_asc')
    setFavRatingFilter('all')
    setFavLocationFilter('all')
  }

  const rows = loading ? (
    <div className="list-row no-results">
      <div className="col" style={{flex:1,textAlign:'center',padding:'32px 0',color:'#6b7280'}}>Loading partners...</div>
    </div>
  ) : errorPartners ? (
    <div className="list-row no-results">
      <div className="col" style={{flex:1,textAlign:'center',padding:'32px 0',color:'#6b7280'}}>{errorPartners}</div>
    </div>
  ) : filtered.length === 0 ? (
    <div className="list-row no-results">
      <div className="col" style={{flex:1,textAlign:'center',padding:'32px 0',color:'#6b7280'}}>No partners found</div>
    </div>
  ) : (
    pagedPartners.map(p => (
      <div className="list-row" key={p.id}>
        <div className="col partner">
          <div className="avatar">
            <img src={avatarForKey(p.id)} alt={`${p.name} avatar`} />
          </div>
          <div>
            <div className="name">{p.name} <span className="mc">{p.mc}</span></div>
          </div>
          <button
            aria-label={p.favorite ? 'Unfavorite' : 'Mark as favorite'}
            className={`fav ${p.favorite ? 'on' : ''}`}
            onClick={() => toggleFavorite(p.id)}
          >
            <i className={`fa-star ${p.favorite ? 'fa-solid' : 'fa-regular'}`} />
          </button>
        </div>
        <div className="col contact">
          <div className="cname">{p.contactName}</div>
          <div className="cmeta">{p.contactEmail} <br /><span className="phone muted">{p.phone}</span></div>
        </div>
        <div className="col small center">{p.loads}</div>
        <div className="col small center">{p.avgPay}</div>
        <div className="col small center">{p.dispute}</div>
        <div className="col small center"><span className={`status ${p.status.toLowerCase()}`}>{p.status}</span></div>
        <div className="col actions">
          <a className="link desktop-only" onClick={() => openPartnerProfile(p.id)}>View</a>
          <a className="link desktop-only" onClick={() => openPartnerDocs(p)}>Docs</a>
          <a className="link remove desktop-only" onClick={() => handleRemovePartner(p.relationshipId, p.id)}>Remove</a>

          {/* Ellipsis menu for small screens */}
          <div className="actions-ellipsis">
            <button
              className="ellipsis-btn"
              aria-haspopup="true"
              aria-expanded={openMenuId === p.id}
              onClick={() => setOpenMenuId(openMenuId === p.id ? null : p.id)}
            >
              <i className="fa-solid fa-ellipsis-vertical" aria-hidden="true" />
            </button>

            {openMenuId === p.id && (
              <div className="ellipsis-menu" role="menu">
                <button role="menuitem" onClick={() => { openPartnerProfile(p.id); setOpenMenuId(null) }}>View</button>
                <button role="menuitem" onClick={() => { openPartnerDocs(p); setOpenMenuId(null) }}>Docs</button>
                <button role="menuitem" onClick={() => { handleRemovePartner(p.relationshipId, p.id); setOpenMenuId(null) }} className="danger">Remove</button>
              </div>
            )}
          </div>
        </div>
      </div>
    ))
  )

  return (
    <div className="carrier-partners">
      <header className="fp-header">
        <div className="fp-header-titles">
          <h2>My Shippers/Brokers</h2>
          <p className="fp-subtitle">Manage partnerships, scorecards, and document exchanges</p>
        </div>
        <div>
          <button className="btn small-cd" onClick={() => setActiveTab('invites')}>+ Add Partner</button>
        </div>
      </header>

      <div className="partners-nav">
        <div className="tabs" role="tablist" aria-label="Partners tabs">
          <button
            role="tab"
            aria-selected={activeTab === 'all'}
            className={`tab ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >All Partners</button>

          <button
            role="tab"
            aria-selected={activeTab === 'favorites'}
            className={`tab ${activeTab === 'favorites' ? 'active' : ''}`}
            onClick={() => setActiveTab('favorites')}
          >Favorites</button>

          <button
            role="tab"
            aria-selected={activeTab === 'invites'}
            className={`tab ${activeTab === 'invites' ? 'active' : ''}`}
            onClick={() => setActiveTab('invites')}
          >Invites & Requests</button>

          <button
            role="tab"
            aria-selected={activeTab === 'history'}
            className={`tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >Document History</button>
        </div>
        {/* primary search/status controls removed as requested */}
      </div>

      {/* Show the primary search and status controls only on the All Partners tab */}
      {activeTab === 'all' && (
        <div className="controls" style={{marginTop:12,marginBottom:12,alignItems:'center'}}>
          <input
            placeholder="Search partners..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="partnered">Partnered</option>
            <option value="pending">Pending</option>
          </select>
        </div>
      )}

      {activeTab === 'all' && (
        loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280' }}>
            <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', marginBottom: '8px' }}></i>
            <p>Loading partners...</p>
          </div>
        ) : errorPartners ? (
          <div style={{ padding: '24px', color: '#6b7280' }}>{errorPartners}</div>
        ) : null
      )}

      {activeTab === 'favorites' ? (
        <div className="favorites-grid">
          {/* Filter & Sort bar above favorites grid (matches attachment) */}
          <div className="filter-sort-bar card">
            <div className="fs-left">
              <div className="fs-title">Filter & Sort</div>
            </div>
            <div className="fs-controls">
              <div className="fs-control">
                <select value={favTypeFilter} onChange={(e) => setFavTypeFilter(e.target.value)}>
                  <option value="all">All Partners</option>
                  <option value="shipper">Shipper</option>
                  <option value="broker">Broker</option>
                </select>
              </div>
              <div className="fs-control">
                <select value={favStatusFilter} onChange={(e) => setFavStatusFilter(e.target.value)}>
                  <option value="all">All Status</option>
                  <option value="partnered">Partnered</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
              <div className="fs-control">
                <select value={favSort} onChange={(e) => setFavSort(e.target.value)}>
                  <option value="name_asc">Name A-Z</option>
                  <option value="name_desc">Name Z-A</option>
                </select>
              </div>

              <div className="fs-control">
                <select value={favRatingFilter} onChange={(e) => setFavRatingFilter(e.target.value)}>
                  <option value="all">All Ratings</option>
                  <option value="4">4+</option>
                  <option value="3">3+</option>
                </select>
              </div>

              <div className="fs-control">
                <select value={favLocationFilter} onChange={(e) => setFavLocationFilter(e.target.value)} disabled={favoriteLocations.length === 0}>
                  <option value="all">All Locations</option>
                  {favoriteLocations.map(loc => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                </select>
              </div>

            </div>
            <div className="fs-right">
              <a className="clear-all" onClick={clearFavFilters}>Clear All</a>
            </div>
          </div>
          {favorites.length === 0 ? (
            <div className="no-results" style={{padding:24,color:'#6b7280'}}>No favorites yet</div>
          ) : filteredFavorites.length === 0 ? (
            <div className="no-results" style={{padding:24,color:'#6b7280'}}>No favorites match your filters</div>
          ) : (
            <div className="grid">
                {filteredFavorites.map(p => (
                <div className="fav-card card" key={p.id}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <div className="fav-card-left">
                      <div className="avatar square">
                        <img src={avatarForKey(p.id)} alt={`${p.name} avatar`} />
                      </div>
                      <div>
                        <div className="fav-title">{p.name}</div>
                        <div className="fav-sub muted">{p.mc}</div>
                      </div>
                    </div>
                    <div className="status-icons">
                      <span className="dot online" title="Online"></span>
                      <i className="fa-solid fa-check-circle verify" title="Verified" />
                      <i className="fa-heart fa-regular fav-heart" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="fav-stats">
                    <div className="stat-row"><div className="label">Pay Speed</div><div className="value">{p.avgPay}</div></div>
                    <div className="stat-row"><div className="label">On-time Rate</div><div className="value green">{p.onTime}</div></div>
                    <div className="stat-row"><div className="label">Rating</div><div className="value stars">{Array.from({length:5}).map((_,i)=>(<i key={i} className={`fa-star ${i < Math.round(p.rating) ? 'fa-solid' : 'fa-regular'}`} />))} <span className="rating-num">{p.rating}</span></div></div>
                    <div className="stat-row"><div className="label">Last Load</div><div className="value">{p.lastLoad}</div></div>

                  <div className="divider" />

                  <div className="fav-contact" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
                    <div className="contact-left"><i className="fa-solid fa-phone" /> <span className="muted">{p.phone}</span></div>
                    <div className="contact-right"><i className="fa-solid fa-location-dot" /> <span className="muted">{p.location}</span></div>
                  </div>

                  <div className="fav-actions">
                    <button className="btn small-cd" style={{width: '100%'}}>Message</button>
                  <button className="btn small ghost-cd" style={{width: '100%'}}>Invite</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : activeTab === 'invites' ? (
        <div className="invites-list">
          <div className="invites-tabs">
            <button
              className={`inv-tab ${inviteTab === 'incoming' ? 'active' : ''}`}
              onClick={() => setInviteTab('incoming')}
            >
              <span className="icon"><i className="fa-solid fa-inbox" /></span>
              Incoming Invites <span className="count">{pendingInvitesCount}</span>
            </button>

            <button
              className={`inv-tab ${inviteTab === 'requests' ? 'active' : ''}`}
              onClick={() => setInviteTab('requests')}
            >
              <span className="icon"><i className="fa-solid fa-paper-plane" /></span>
              My Requests <span className="count">{outgoingRequests.length}</span>
            </button>
          </div>

          <div className="invites-controls">
            <input
              className="inv-search"
              placeholder="Search invites by name, email, phone, location"
              value={inviteQuery}
              onChange={(e) => setInviteQuery(e.target.value)}
              disabled={inviteTab !== 'incoming'}
            />
            <select
              className="inv-select"
              value={inviteStatusFilter}
              onChange={(e) => setInviteStatusFilter(e.target.value)}
              disabled={inviteTab !== 'incoming'}
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="declined">Declined</option>
            </select>
            <select
              className="inv-select"
              value={inviteRegionFilter}
              onChange={(e) => setInviteRegionFilter(e.target.value)}
              disabled={inviteTab !== 'incoming' || inviteStates.length === 0}
            >
              <option value="all">All Regions</option>
              {inviteStates.map(st => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
            <div className="inv-actions">
              <button className="icon-btnn" aria-label="filters"><i className="fa-solid fa-sliders" /></button>
              <button className="icon-btnn" aria-label="sort"><i className="fa-solid fa-arrow-up-wide-short" /></button>
            </div>
          </div>

          {loadingInvites ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280' }}>
              <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '24px', marginBottom: '8px' }}></i>
              <p>Loading invitations...</p>
            </div>
          ) : (
            filteredInviteList.map(inv => (
            <div className="invite-card card" key={inv.id} data-type={inviteTab === 'incoming' ? 'incoming' : 'request'}>
              <div className="invite-row" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
                <div style={{display:'flex',alignItems:'center',gap:12}}>
                  <div className="avatar square" style={{width:48,height:48,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                    <img src={avatarForKey(inv.id)} alt={`${inv.name} avatar`} style={{width:'100%',height:'100%',objectFit:'cover'}} />
                  </div>
                  <div>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <div style={{fontWeight:700}}>{inv.name}</div>
                      {/* add a normalized class from the badge text so we can target variants in CSS */}
                      <div className={`invite-badge ${inv.badge ? inv.badge.toLowerCase().replace(/\s+/g,'-') : ''}`}>{inv.badge}</div>
                    </div>
                    <div className="muted" style={{fontSize:13,marginTop:6}}>
                      {inv.type ? `${inv.type} · ` : ''}
                      {inv.email ? inv.email : 'No email'}
                      {inv.phone ? ` · ${inv.phone}` : ''}
                      {inv.city || inv.state ? ` · ${[inv.city, inv.state].filter(Boolean).join(', ')}` : ''}
                    </div>
                  </div>
                </div>

                  <div className="invite-right" style={{display:'flex',alignItems:'center',gap:8}}>
                  <div className="invite-stars" style={{display:'flex',alignItems:'center',gap:6,marginRight:12}}>
                    {typeof inv.rating === 'number' && inv.rating > 0 ? (
                      <>
                        {Array.from({length:5}).map((_,i)=> (
                          <i key={i} className={`fa-star ${i < Math.round(inv.rating) ? 'fa-solid' : 'fa-regular'}`} style={{color:'#fbbf24'}} />
                        ))}
                        <div className="muted" style={{marginLeft:8}}>{inv.rating} Rating</div>
                      </>
                    ) : (
                      <div className="muted">No rating</div>
                    )}
                  </div>
                  <div className="invite-action-desktop" style={{gap:8}}>
                    <>
                      <button className="btn small ghost-cd" onClick={() => openPartnerProfile(inv.shipperId)}>View Profile</button>
                      <button 
                        className="btn small ghost-cd" 
                        style={{color: '#c51313ff'}}
                        onClick={() => handleDeclineInvite(inv.invitationId)}
                      >
                        Decline
                      </button>
                      <button 
                        className="btn small-cd"
                        onClick={() => handleAcceptInvite(inv.invitationId)}
                      >
                        Accept
                      </button>
                    </>
                  </div>
                </div>
              </div>

              <div className="invite-message">
                <div className="invite-message-text">{inv.message || 'No message provided.'}</div>
              </div>

              <div className="invite-meta" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:10}}>
                <div style={{display:'flex',alignItems:'center',gap:12}}>
                  <div className="muted">Received {inv.received}</div>
                  <div className="invite-action-mobile">
                    <>
                      <button className="btn small ghost-cd" onClick={() => openPartnerProfile(inv.shipperId)}>View Profile</button>
                      <button 
                        className="btn small ghost-cd" 
                        style={{borderColor:'#fdecea',color:'#ef4444'}}
                        onClick={() => handleDeclineInvite(inv.invitationId)}
                      >
                        Decline
                      </button>
                      <button 
                        className="btn small ghost-cd"
                        onClick={() => handleAcceptInvite(inv.invitationId)}
                      >
                        Accept
                      </button>
                    </>
                  </div>
                </div>
                <div className="muted" />
              </div>

              {/* Bottom action bar shown when sidebar collapses (mobile/tablet compact view) */}
              <div className="invite-actions-bottom" style={{marginTop:12}}>
                {/* Mobile-only rating shown above buttons at very small widths (<=400px) */}
                <div className="invite-rating mobile-only" style={{display:'none',alignItems:'center',gap:8,marginBottom:8}}>
                  {typeof inv.rating === 'number' && inv.rating > 0 ? (
                    <>
                      {Array.from({length:5}).map((_,i)=> (
                        <i key={i} className={`fa-star ${i < Math.round(inv.rating) ? 'fa-solid' : 'fa-regular'}`} style={{color:'#fbbf24'}} />
                      ))}
                      <div className="muted" style={{marginLeft:8}}>{inv.rating} Rating</div>
                    </>
                  ) : (
                    <div className="muted">No rating</div>
                  )}
                </div>
                <>
                  <button className="btn small ghost-cd" style={{flex:1,marginRight:8}} onClick={() => openPartnerProfile(inv.shipperId)}>View Profile</button>
                  <button 
                    className="btn small ghost-cd" 
                    style={{flex:1,marginRight:8,color: '#c51313ff'}}
                    onClick={() => handleDeclineInvite(inv.invitationId)}
                  >
                    Decline
                  </button>
                  <button 
                    className="btn small-cd" 
                    style={{flex:1}}
                    onClick={() => handleAcceptInvite(inv.invitationId)}
                  >
                    Accept
                  </button>
                </>
              </div>
            </div>
            ))
          )}

          {!loadingInvites && inviteTab === 'incoming' && errorInvites && (
            <div style={{ padding: '16px 0', color: '#6b7280' }}>{errorInvites}</div>
          )}

          {!loadingInvites && inviteTab === 'incoming' && !errorInvites && pendingInvitesCount === 0 && inviteStatusFilter === 'pending' && (
            <div style={{ padding: '24px', color: '#6b7280' }}>No pending invitations.</div>
          )}

          {!loadingInvites && inviteTab === 'incoming' && !errorInvites && listForInviteTab.length > 0 && filteredInviteList.length === 0 && (
            <div style={{ padding: '24px', color: '#6b7280' }}>No invites match your filters.</div>
          )}

          {!loadingInvites && inviteTab === 'requests' && outgoingRequests.length === 0 && (
            <div style={{ padding: '24px', color: '#6b7280' }}>No outgoing requests.</div>
          )}

          {!loadingInvites && inviteTab === 'requests' && outgoingRequests.length > 0 && filteredInviteList.length === 0 && (
            <div style={{ padding: '24px', color: '#6b7280' }}>No requests match your filters.</div>
          )}

          {/* Invites stats summary cards (end of invites screen) */}
          <div className="invites-stats">
            <div className="cd-stat-card card">
              <div className="stat-left"><div className="icon-box pending"><i className="fa-solid fa-inbox" /></div></div>
              <div className="stat-right"><div className="stat-num">{pendingInvitesCount}</div><div className="stat-label">Pending Invites</div></div>
            </div>

            <div className="cd-stat-card card">
              <div className="stat-left"><div className="icon-box accepted"><i className="fa-solid fa-check-circle" /></div></div>
              <div className="stat-right"><div className="stat-num">{acceptedThisMonthCount}</div><div className="stat-label">Accepted This Month</div></div>
            </div>

            <div className="cd-stat-card card">
              <div className="stat-left"><div className="icon-box sent"><i className="fa-solid fa-paper-plane" /></div></div>
              <div className="stat-right"><div className="stat-num">{requestsSentCount}</div><div className="stat-label">Requests Sent</div></div>
            </div>

            <div className="cd-stat-card card">
              <div className="stat-left"><div className="icon-box active"><i className="fa-solid fa-handshake" /></div></div>
              <div className="stat-right"><div className="stat-num">{activePartnersCount}</div><div className="stat-label">Active Partners</div></div>
            </div>
          </div>
        </div>
      ) : activeTab === 'history' ? (
        <div className="document-history">
          <div style={{ padding: '24px', color: '#6b7280' }}>
            Document history is not available yet.
          </div>
        </div>
      ) : (
        <div className="partners-list card">
          <div className="list-head">
            <div className="col partner">Partner</div>
            <div className="col contact">Contact</div>
            <div className="col small">Loads Done</div>
            <div className="col small">Avg Pay Speed</div>
            <div className="col small">Dispute %</div>
            <div className="col small">Status</div>
            <div className="col actions">Actions</div>
          </div>

          {rows}

          <div className="list-footer">
            <div className="meta">
              {filtered.length === 0
                ? `Showing 0 of ${localPartners.length} partners`
                : `Showing ${Math.min(startIdx + 1, filtered.length)}-${Math.min(endIdxExclusive, filtered.length)} of ${filtered.length} partners`}
            </div>
            <div className="pager">
              <button
                className="page"
                disabled={safePartnersPage <= 1}
                onClick={() => setPartnersPage(Math.max(1, safePartnersPage - 1))}
                type="button"
              >
                Previous
              </button>

              {Array.from({ length: totalPartnerPages }, (_, i) => i + 1).map(pn => (
                <button
                  key={pn}
                  className={`page ${pn === safePartnersPage ? 'active' : ''}`}
                  onClick={() => setPartnersPage(pn)}
                  type="button"
                >
                  {pn}
                </button>
              ))}

              <button
                className="page"
                disabled={safePartnersPage >= totalPartnerPages}
                onClick={() => setPartnersPage(Math.min(totalPartnerPages, safePartnersPage + 1))}
                type="button"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {profileModalOpen && (
        <div
          onClick={closeProfileModal}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: 9000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 12,
              width: 'min(720px, 100%)',
              maxHeight: '85vh',
              overflow: 'auto',
              border: '1px solid #e5e7eb',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>Partner Profile</div>
                <div style={{ marginTop: 2, color: '#6b7280', fontSize: 13 }}>{profileLoading ? 'Loading…' : ''}</div>
              </div>
              <button className="btn small ghost-cd" onClick={closeProfileModal} type="button">Close</button>
            </div>

            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {profileError && (
                <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8 }}>{profileError}</div>
              )}

              {!profileError && !profileLoading && !profileData && (
                <div style={{ color: '#6b7280' }}>No profile data found.</div>
              )}

              {profileData && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Info label="Name" value={String(profileData.display_name || 'N/A')} />
                  <Info label="Company" value={String(profileData.company_name || 'N/A')} />
                  <Info label="Role" value={String(profileData.role || 'N/A')} />
                  <Info label="Email" value={String(profileData.email || 'N/A')} />
                  <Info label="Phone" value={String(profileData.phone || 'N/A')} />
                  <Info
                    label="Address"
                    value={
                      [profileData.address, profileData.city, profileData.state, profileData.zip, profileData.country]
                        .filter(Boolean)
                        .join(', ') || 'N/A'
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {docsModalOpen && (
        <div
          onClick={closeDocsModal}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: 9000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 12,
              width: 'min(960px, 100%)',
              maxHeight: '85vh',
              overflow: 'auto',
              border: '1px solid #e5e7eb',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>Partner Documents</div>
                <div style={{ marginTop: 2, color: '#6b7280', fontSize: 13 }}>{docsPartner?.name ? `Partner: ${docsPartner.name}` : ''}</div>
              </div>
              <button className="btn small ghost-cd" onClick={closeDocsModal} type="button">Close</button>
            </div>

            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {docsLoadsError && (
                <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8 }}>{docsLoadsError}</div>
              )}

              {docsLoadsLoading ? (
                <div style={{ color: '#6b7280' }}>Loading loads…</div>
              ) : docsLoads.length === 0 ? (
                <div style={{ color: '#6b7280' }}>No loads found for this partner.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {docsLoads.map(l => {
                    const loadId = String(l?.load_id || l?.id || '').trim()
                    const loadNumber = String(l?.load_number || '').trim() || loadId
                    return (
                      <div key={loadId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 800, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loadNumber}</div>
                          <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {String(l?.origin || 'N/A')} → {String(l?.destination || 'N/A')} · {String(l?.status || 'N/A')}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                          <button className="btn small ghost-cd" type="button" onClick={() => setDetailsLoad({ load_id: loadId })} disabled={!loadId}>
                            View Docs
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {detailsLoad && <LoadDetailsModal load={detailsLoad} onClose={() => setDetailsLoad(null)} />}
    </div>
  )
}

function Info({ label, value }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>{label}</div>
      <div style={{ marginTop: 4, color: '#111827', fontWeight: 700, wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}
