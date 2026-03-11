import React, { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { API_URL } from '../../config'
import carrier_ob_1 from '../../assets/carrier_ob_1.png'
import carrier_ob_2 from '../../assets/carrier_ob_2.jpg'
import carrier_ob_3 from '../../assets/carrier_ob_3.jpg'
import './Onboarding.css'
import Chatbot from '../../components/landing_page/Chatbot'
import verification from '../../assets/verification_bg.svg'
import botpic from '../../assets/chatbot.svg'

export default function CarrierOnboarding(){
  const navigate = useNavigate()
  const location = useLocation()
  const { currentUser } = useAuth()
  const images = [carrier_ob_1, carrier_ob_2, carrier_ob_3]
  const [_currentImg, setCurrentImg] = useState(0)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [readOnlyFields, setReadOnlyFields] = useState({})
  const [_existingOnboardingData, setExistingOnboardingData] = useState(null)

  // File upload refs
  const brokerAgreementRef = useRef()
  const mcAuthorityRef = useRef()
  const coiRef = useRef()
  const w9Ref = useRef()
  const voidedCheckRef = useRef()
  const factoringRef = useRef()

  // File upload state
  const [uploads, setUploads] = useState({
    brokerAgreement: null,
    mcAuthority: null,
    coi: null,
    w9: null,
    voidedCheck: null,
    factoring: null
  })
  const [uploading, setUploading] = useState({})
  const [uploadError, setUploadError] = useState('')
  const [uploadSuccess, setUploadSuccess] = useState('')

  // Form state for all onboarding data
  const [formData, setFormData] = useState({
    // Business Info (Step 1)
    companyName: '',
    dotNumber: '',
    mcNumber: '',
    einNumber: '',
    companyAddress: '',
    contactEmail: '',
    contactPhone: '',
    // Owner Info (Step 2)
    ownerName: '',
    ownerTitle: '',
    ownerPhone: '',
    ownerEmail: '',
    // Fleet Info (Step 3)
    fleetSize: '',
    equipmentType: 'dry_van',
    avgTruckModelYear: '',
    homeTerminal: '',
    eldProvider: '',
    factoringCompany: '',
    insuranceProvider: '',
    preferredLanes: '',
    // Documents will be uploaded separately
  })

  const updateField = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  // Pre-fill form from chatbot data or fetch existing data
  useEffect(() => {
    const loadOnboardingData = async () => {
      // First check if navigated from chatbot with prefill data
      if (location.state?.prefill) {
        const prefill = location.state.prefill
        setFormData(prev => ({
          ...prev,
          companyName: prefill.company_name || prefill.companyName || '',
          dotNumber: prefill.dot_number || prefill.dotNumber || '',
          mcNumber: prefill.mc_number || prefill.mcNumber || '',
          ownerName: prefill.full_name || prefill.ownerName || prefill.fullName || '',
        }))
        // Mark chatbot-provided fields as read-only
        setReadOnlyFields({
          dotNumber: true,
          mcNumber: true,
          companyName: true,
          ownerName: true
        })
        setExistingOnboardingData(prefill)
        return
      }

      // Otherwise, fetch existing data from backend
      if (!currentUser) return
      try {
        const token = await currentUser.getIdToken()
        const response = await fetch(`${API_URL}/onboarding/data`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        })
        if (response.ok) {
          const result = await response.json()
          const data = result.data
          
          // Populate form with existing data
          if (data.companyName) setFormData(prev => ({ ...prev, companyName: data.companyName }))
          if (data.dotNumber) setFormData(prev => ({ ...prev, dotNumber: data.dotNumber }))
          if (data.mcNumber) setFormData(prev => ({ ...prev, mcNumber: data.mcNumber }))
          if (data.firstName) setFormData(prev => ({ ...prev, firstName: data.firstName }))
          if (data.lastName) setFormData(prev => ({ ...prev, lastName: data.lastName }))
          
          // Mark extracted fields (from documents) as read-only
          const readOnlySet = {}
          if (data.dotNumber) readOnlySet.dotNumber = true
          if (data.mcNumber) readOnlySet.mcNumber = true
          if (data.companyName) readOnlySet.companyName = true
          setReadOnlyFields(readOnlySet)
          
          setExistingOnboardingData(data)
        }
      } catch (error) {
        console.error('Error fetching onboarding data:', error)
      }
    }

    loadOnboardingData()
  }, [location.state, currentUser])

  // Handle file upload to API
  const handleFileUpload = async (field, file, documentType) => {
    if (!file) return

    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png']
    if (!allowedTypes.includes(file.type)) {
      setUploadError('Only PDF, JPG, and PNG files are allowed')
      setTimeout(() => setUploadError(''), 5000)
      return
    }

    if (file.size > 25 * 1024 * 1024) {
      setUploadError('File size must be less than 25MB')
      setTimeout(() => setUploadError(''), 5000)
      return
    }

    setUploading(prev => ({ ...prev, [field]: true }))
    setUploadError('')

    try {
      const token = currentUser ? await currentUser.getIdToken() : null
      const formDataUpload = new FormData()
      formDataUpload.append('file', file)
      formDataUpload.append('document_type', documentType)

      const headers = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      const response = await fetch(`${API_URL}/documents`, {
        method: 'POST',
        headers,
        body: formDataUpload
      })

      const result = await response.json()

      if (response.ok) {
        setUploads(prev => ({ ...prev, [field]: { file, response: result } }))
        setUploadSuccess(`${file.name} uploaded successfully!`)
        setTimeout(() => setUploadSuccess(''), 5000)
      } else {
        setUploadError(result.detail || 'Failed to upload document')
        setTimeout(() => setUploadError(''), 5000)
      }
    } catch (error) {
      console.error('Upload error:', error)
      setUploadError('Failed to upload document. Please try again.')
      setTimeout(() => setUploadError(''), 5000)
    } finally {
      setUploading(prev => ({ ...prev, [field]: false }))
    }
  }

  const handleFileInput = (field, documentType, e) => {
    const file = e.target.files?.[0]
    if (file) handleFileUpload(field, file, documentType)
  }

  const handleFileDrop = (field, documentType, e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) handleFileUpload(field, file, documentType)
  }

  const preventDefault = (e) => e.preventDefault()

  useEffect(()=>{
    const t = setInterval(()=> setCurrentImg(p => (p+1)%images.length), 2500)
    return ()=> clearInterval(t)
  },[])

  const steps = ['Business Info','Owner Information (Optional)','Fleet Information','Compliance','Final Review']

  function handleNext(){
    setCurrentStep(s => Math.min(5, s+1))
  }
  function handleBack(){
    setCurrentStep(s => Math.max(1, s-1))
  }

  // Save onboarding data to backend
  const handleFinish = async () => {
    if (!currentUser) {
      navigate('/carrier-dashboard')
      return
    }

    setSaving(true)
    setSaveError('')

    try {
      const token = await currentUser.getIdToken()
      const response = await fetch(`${API_URL}/onboarding/save`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          role: 'carrier',
          data: formData
        })
      })

      if (response.ok) {
        navigate('/carrier-dashboard')
      } else {
        const data = await response.json()
        setSaveError(data.detail || 'Failed to save onboarding data')
      }
    } catch (error) {
      console.error('Error saving onboarding:', error)
      setSaveError('Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
  <div className="onboarding-container">
      <aside className="onboarding-steps">
        <div className="logo">LOGO</div>
        <ol>
          {steps.map((s, i) => {
            const step = i+1
            const cls = step === currentStep ? 'active' : step < currentStep ? 'completed' : ''
            return (
              <li key={s} className={cls}>
                <div className="step-num">{step}</div>
                <div className="step-info">
                  <div className="step-title">{s}</div>
                </div>
                <div className="step-arrow">›</div>
              </li>
            )
          })}
        </ol>
      </aside>

      <main className="onboarding-main">
        <img src={verification} alt="Pattern" className="onboarding-pattern-bg"/>
        <div className="onboarding-card">
          <h2>{steps[currentStep-1]}</h2>
          {currentStep === 2 ? (
            <p className="muted">Upload your ID document for faster verification</p>
          ) : currentStep === 3 ? (
            <p className="muted">Please update your fleet information</p>
          ) : currentStep === 4 ? (
            <p className="muted">Please Provide your Compliance Documents</p>
          ) : currentStep === 5 ? (
            <p className="muted">Please review the information you provided before submitting.</p>
          ) : (
            <p className="muted">Please Provide your Business information</p>
          )}

          {saveError && (
            <div style={{background: '#fee2e2', color: '#dc2626', padding: '12px', borderRadius: '8px', marginBottom: '16px'}}>
              {saveError}
            </div>
          )}

          <form className="onboarding-form" onSubmit={(e)=>e.preventDefault()}>
            {currentStep === 1 && (
              <>
                <label>Company Name {readOnlyFields.companyName && <span style={{color: '#f59e0b', fontSize: '0.85rem'}}>(from document)</span>}</label>
                <input placeholder="Enter company name" value={formData.companyName} onChange={(e) => updateField('companyName', e.target.value)} disabled={readOnlyFields.companyName} style={{opacity: readOnlyFields.companyName ? 0.6 : 1}} />

                <label>DOT Number {readOnlyFields.dotNumber && <span style={{color: '#f59e0b', fontSize: '0.85rem'}}>(extracted from document)</span>} <small className="field-note">(with real-time FMCSA check if possible) <span className='fetch-btn'>Fetch from FMCSA</span></small></label>
                <input placeholder="DOT Number" value={formData.dotNumber} onChange={(e) => updateField('dotNumber', e.target.value)} disabled={readOnlyFields.dotNumber} style={{opacity: readOnlyFields.dotNumber ? 0.6 : 1}} />

                <label style={{display:'flex', alignItems:'center', gap:8}}>MC Number {readOnlyFields.mcNumber && <span style={{color: '#f59e0b', fontSize: '0.85rem'}}>(extracted from document)</span>}
                  <button type="button" aria-label="MC info" title="MC info" className="mc-info-btn">?
                  </button>
                </label>
                <input placeholder="MC Number" value={formData.mcNumber} onChange={(e) => updateField('mcNumber', e.target.value)} disabled={readOnlyFields.mcNumber} style={{opacity: readOnlyFields.mcNumber ? 0.6 : 1}} />
                <div className="mc-subtext">We’ll verify your FMCSA data automatically to speed up approval.</div>

                <label>Tax ID (EIN)</label>
                <input placeholder="Tx ID (EIN)" value={formData.einNumber} onChange={(e) => updateField('einNumber', e.target.value)} />

                <label>Company Address</label>
                <input placeholder="Company Address" value={formData.companyAddress} onChange={(e) => updateField('companyAddress', e.target.value)} />

                <div className="row">
                  <div className="col">
                    <label>Contact Email</label>
                    <input placeholder="email@company.com" value={formData.contactEmail} onChange={(e) => updateField('contactEmail', e.target.value)} />
                  </div>
                  <div className="col">
                    <label>Phone <small className="field-note">(optional)</small></label>
                    <input placeholder="+1 (555) 555-5555" value={formData.contactPhone} onChange={(e) => updateField('contactPhone', e.target.value)} />
                  </div>
                </div>

                <div className="divider-line" />
              </>
            )}

            {currentStep === 2 && (
              <>
                <label>Full Name</label>
                <input placeholder="Full name" value={formData.ownerName} onChange={(e) => updateField('ownerName', e.target.value)} />

                <label>Title</label>
                <input placeholder="Title" value={formData.ownerTitle} onChange={(e) => updateField('ownerTitle', e.target.value)} />

                <div style={{display:'flex',gap:12}}>
                  <div style={{flex:1}}>
                    <label>Phone Number<small className='field-note'> (optional)</small></label>
                    <input placeholder="+1 (555) 555-5555" value={formData.ownerPhone} onChange={(e) => updateField('ownerPhone', e.target.value)} />
                  </div>
                  <div style={{flex:1}}>
                    <label>Email Address<small className='field-note'> (optional)</small></label>
                    <input placeholder="email@company.com" value={formData.ownerEmail} onChange={(e) => updateField('ownerEmail', e.target.value)} />
                  </div>
                </div>
              </>
            )}

            {currentStep === 3 && (
              <>
                <label>Fleet Size</label>
                <input type="number" min="0" placeholder="Number of power units" value={formData.fleetSize} onChange={(e) => updateField('fleetSize', e.target.value)} />

                <label>Equipment Type</label>
                <select value={formData.equipmentType} onChange={(e) => updateField('equipmentType', e.target.value)}>
                  <option value="dry_van">Dry Van</option>
                  <option value="reefer">Reefer</option>
                  <option value="flatbed">Flatbed</option>
                  <option value="step_deck">Step Deck</option>
                  <option value="other">Other</option>
                </select>

                <div className="row">
                  <div className="col">
                    <label>Average Truck Model Year</label>
                    <input type="text" placeholder="e.g., 2020" value={formData.avgTruckModelYear} onChange={(e) => updateField('avgTruckModelYear', e.target.value)} />
                  </div>
                  <div className="col">
                    <label>Home Terminal (City, State)</label>
                    <input placeholder="City, State" value={formData.homeTerminal} onChange={(e) => updateField('homeTerminal', e.target.value)} />
                  </div>
                </div>

                <div className="row">
                  <div className="col">
                    <label>ELD Provider</label>
                    <input placeholder="ELD provider name" value={formData.eldProvider} onChange={(e) => updateField('eldProvider', e.target.value)} />
                  </div>
                  <div className="col">
                    <label>Factoring Company</label>
                    <input placeholder="Factoring company name" value={formData.factoringCompany} onChange={(e) => updateField('factoringCompany', e.target.value)} />
                  </div>
                </div>

                <label>Insurance Provider</label>
                <input placeholder="Insurance provider name" value={formData.insuranceProvider} onChange={(e) => updateField('insuranceProvider', e.target.value)} />

                <div>
                  <label>Preferred Lanes / Routes</label>
                  <textarea placeholder="e.g., I-95 corridor, Midwest regional, TX -> CA lanes" rows={4} value={formData.preferredLanes} onChange={(e) => updateField('preferredLanes', e.target.value)} />
                </div>

                <div className="divider-line" />
              </>
            )}

            {currentStep === 4 && (
              <>
                {uploadError && (
                  <div style={{padding:'12px',background:'#fee2e2',color:'#dc2626',borderRadius:'8px',marginBottom:'16px'}}>
                    {uploadError}
                  </div>
                )}
                {uploadSuccess && (
                  <div style={{padding:'12px',background:'#dcfce7',color:'#16a34a',borderRadius:'8px',marginBottom:'16px'}}>
                    {uploadSuccess}
                  </div>
                )}

                <label>Broker Carrier Agreement</label>
                <input type="file" ref={brokerAgreementRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('brokerAgreement', 'broker_agreement', e)} />
                <div className="upload-box" style={{cursor:'pointer'}} onClick={() => brokerAgreementRef.current?.click()} onDrop={(e) => handleFileDrop('brokerAgreement', 'broker_agreement', e)} onDragOver={preventDefault} onDragEnter={preventDefault}>
                  {uploading.brokerAgreement ? <div style={{color:'#2563eb'}}>Uploading...</div> : uploads.brokerAgreement ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.brokerAgreement.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : <><i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" /><br />Click to upload or drag and drop</>}
                </div>

                <label>MC Authority Letter (FMCSA)</label>
                <input type="file" ref={mcAuthorityRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('mcAuthority', 'mc_authority', e)} />
                <div className="upload-box" style={{cursor:'pointer'}} onClick={() => mcAuthorityRef.current?.click()} onDrop={(e) => handleFileDrop('mcAuthority', 'mc_authority', e)} onDragOver={preventDefault} onDragEnter={preventDefault}>
                  {uploading.mcAuthority ? <div style={{color:'#2563eb'}}>Uploading...</div> : uploads.mcAuthority ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.mcAuthority.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : <><i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" /><br />Click to upload or drag and drop</>}
                </div>

                <label>Certificate of Insurance (COI)</label>
                <input type="file" ref={coiRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('coi', 'coi', e)} />
                <div className="upload-box" style={{cursor:'pointer'}} onClick={() => coiRef.current?.click()} onDrop={(e) => handleFileDrop('coi', 'coi', e)} onDragOver={preventDefault} onDragEnter={preventDefault}>
                  {uploading.coi ? <div style={{color:'#2563eb'}}>Uploading...</div> : uploads.coi ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.coi.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : <><i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" /><br />Click to upload or drag and drop</>}
                </div>

                <label>W9 Form</label>
                <input type="file" ref={w9Ref} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('w9', 'w9', e)} />
                <div className="upload-box" style={{cursor:'pointer'}} onClick={() => w9Ref.current?.click()} onDrop={(e) => handleFileDrop('w9', 'w9', e)} onDragOver={preventDefault} onDragEnter={preventDefault}>
                  {uploading.w9 ? <div style={{color:'#2563eb'}}>Uploading...</div> : uploads.w9 ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.w9.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : <><i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" /><br />Click to upload or drag and drop</>}
                </div>

                <label>Voided Check / Bank Letter</label>
                <input type="file" ref={voidedCheckRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('voidedCheck', 'voided_check', e)} />
                <div className="upload-box" style={{cursor:'pointer'}} onClick={() => voidedCheckRef.current?.click()} onDrop={(e) => handleFileDrop('voidedCheck', 'voided_check', e)} onDragOver={preventDefault} onDragEnter={preventDefault}>
                  {uploading.voidedCheck ? <div style={{color:'#2563eb'}}>Uploading...</div> : uploads.voidedCheck ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.voidedCheck.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : <><i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" /><br />Click to upload or drag and drop</>}
                </div>

                <label>Factoring Agreement or Notice of Assignment (if applicable)</label>
                <input type="file" ref={factoringRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('factoring', 'factoring_agreement', e)} />
                <div className="upload-box" style={{cursor:'pointer'}} onClick={() => factoringRef.current?.click()} onDrop={(e) => handleFileDrop('factoring', 'factoring_agreement', e)} onDragOver={preventDefault} onDragEnter={preventDefault}>
                  {uploading.factoring ? <div style={{color:'#2563eb'}}>Uploading...</div> : uploads.factoring ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.factoring.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : <><i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" /><br />Click to upload or drag and drop</>}
                </div>
              </>
            )}

            {currentStep === 5 && (
              <FinalReview formData={formData} uploads={uploads} onEdit={(s) => setCurrentStep(s)} />
            )}

            <div className="onboarding-actions">
              <button type="button" className="btn btn-secondary" onClick={handleBack} disabled={currentStep===1 || saving}>Back</button>
              <button type="button" className={"btn btn-primary " + (currentStep===5 ? '' : 'enabled')} onClick={currentStep===5 ? handleFinish : handleNext} disabled={saving}>
                {saving ? 'Saving...' : (currentStep===5 ? 'Finish' : 'Next')}
              </button>
            </div>
          </form>
        </div>

      </main>
      {/* Chat bubble trigger (matches landing page behavior) */}
      <div className="hero-chat-bubble" onClick={() => setIsChatOpen(s => !s)} style={{position: 'fixed', right: 18, bottom: 18, zIndex: 999}}>
        <img src={botpic} alt="AI Assistant" style={{width:42,height:42}} />
      </div>
      <Chatbot isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
    </div>
  )
}

function FinalReview({ formData, uploads, onEdit }){
  // Use formData from props for review
  const equipmentLabels = {
    dry_van: 'Dry Van',
    reefer: 'Reefer',
    flatbed: 'Flatbed',
    step_deck: 'Step Deck',
    other: 'Other'
  }

  // Documents list to display with matching upload keys
  const docs = [
    {key:'coi', label: 'Certificate of Insurance (COI)'},
    {key:'w9', label: 'W9 Form'},
    {key:'mcAuthority', label: 'MC Authority Letter'},
    {key:'voidedCheck', label: 'Voided Check / Bank Letter'},
    {key:'factoring', label: 'Factoring Agreement'},
    {key:'brokerAgreement', label: 'Broker Carrier Agreement'}
  ];

  return (
    <div style={{border:'1px solid #eef2f7',borderRadius:8,padding:16,display:'flex',flexDirection:'column',gap:12}}>
      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Business Information</h4>
          <button type="button" onClick={() => onEdit(1)} style={{color:'#3b82f6',background:'none',border:'none',cursor:'pointer',fontSize:12}}>Edit</button>
        </div>
        <p style={{margin:0}}><strong>Company:</strong> {formData.companyName || '-'}</p>
        <p style={{margin:0}}><strong>DOT:</strong> {formData.dotNumber || '-'}</p>
        <p style={{margin:0}}><strong>MC:</strong> {formData.mcNumber || '-'}</p>
        <p style={{margin:0}}><strong>EIN:</strong> {formData.einNumber || '-'}</p>
        <p style={{margin:0}}><strong>Email:</strong> {formData.contactEmail || '-'}</p>
        <p style={{margin:0}}><strong>Phone:</strong> {formData.contactPhone || '-'}</p>
      </section>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Owner / Contact</h4>
          <button type="button" onClick={() => onEdit(2)} style={{color:'#3b82f6',background:'none',border:'none',cursor:'pointer',fontSize:12}}>Edit</button>
        </div>
        <p style={{margin:0}}><strong>Name:</strong> {formData.ownerName || '-'}</p>
        <p style={{margin:0}}><strong>Title:</strong> {formData.ownerTitle || '-'}</p>
        <p style={{margin:0}}><strong>Phone:</strong> {formData.ownerPhone || '-'}</p>
        <p style={{margin:0}}><strong>Email:</strong> {formData.ownerEmail || '-'}</p>
      </section>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Fleet Information</h4>
          <button type="button" onClick={() => onEdit(3)} style={{color:'#3b82f6',background:'none',border:'none',cursor:'pointer',fontSize:12}}>Edit</button>
        </div>
        <p style={{margin:0}}><strong>Fleet Size:</strong> {formData.fleetSize || '-'}</p>
        <p style={{margin:0}}><strong>Equipment:</strong> {equipmentLabels[formData.equipmentType] || '-'}</p>
        <p style={{margin:0}}><strong>Home Terminal:</strong> {formData.homeTerminal || '-'}</p>
        <p style={{margin:0}}><strong>ELD Provider:</strong> {formData.eldProvider || '-'}</p>
        <p style={{margin:0}}><strong>Factoring:</strong> {formData.factoringCompany || '-'}</p>
        <p style={{margin:0}}><strong>Preferred Lanes:</strong> {formData.preferredLanes || '-'}</p>
      </section>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Uploaded Documents</h4>
          <button type="button" onClick={() => onEdit(4)} style={{color:'#3b82f6',background:'none',border:'none',cursor:'pointer',fontSize:12}}>Edit</button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          {docs.map(d => (
            <div key={d.key} style={{padding:8,border:'1px solid #f1f5f9',borderRadius:8}}>
              <div style={{fontWeight:700}}>{d.label}</div>
              {uploads?.[d.key] ? (
                <div style={{color:'#22c55e', display:'flex', alignItems:'center', gap:4}}>
                  <i className="fa-solid fa-check-circle" aria-hidden="true" />
                  {uploads[d.key].file.name}
                </div>
              ) : (
                <div style={{color:'#f59e0b'}}>Not uploaded</div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
