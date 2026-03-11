import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { API_URL } from '../../config'
import carrier_ob_1 from '../../assets/carrier_ob_1.png'
import carrier_ob_2 from '../../assets/carrier_ob_2.jpg'
import carrier_ob_3 from '../../assets/carrier_ob_3.jpg'
import '../../styles/carrier/CarrierSignup.css'
import './Onboarding.css'
import Chatbot from '../../components/landing_page/Chatbot'
import verification from '../../assets/verification_bg.svg'
import botpic from '../../assets/chatbot.svg'

export default function ShipperOnboarding(){
  const navigate = useNavigate()
  const { currentUser } = useAuth()
  const images = [carrier_ob_1, carrier_ob_2, carrier_ob_3]
  const [_currentImg, setCurrentImg] = useState(0)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const steps = ['Business Info','Contact Person','Upload Documents','Preferences','Final Review']

  useEffect(()=>{
    const t = setInterval(()=> setCurrentImg(p => (p+1)%images.length), 2500)
    return ()=> clearInterval(t)
  },[])

  function handleNext(){
    setCurrentStep(s => Math.min(5, s+1))
  }
  function handleBack(){
    setCurrentStep(s => Math.max(1, s-1))
  }

  // File upload state for step 3
  const [uploads, setUploads] = useState({
    w9: null, // required
    proofOfRegistration: null,
    bmc: null,
    coi: null
  })
  const [uploading, setUploading] = useState({})
  const [uploadError, setUploadError] = useState('')
  const [uploadSuccess, setUploadSuccess] = useState('')

  const w9Ref = useRef()
  const proofRef = useRef()
  const bmcRef = useRef()
  const coiRef = useRef()

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

  function handleFileInput(field, documentType, e){
    const f = e.target.files && e.target.files[0]
    if(f) handleFileUpload(field, f, documentType)
  }

  function handleRemove(field){
    setUploads(u => ({ ...u, [field]: null }))
  }

  function handleDrop(field, documentType, e){
    e.preventDefault()
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    if(f) handleFileUpload(field, f, documentType)
  }

  function preventDefault(e){ e.preventDefault(); e.stopPropagation() }

  // Freight preferences state for step 4
  const [preferences, setPreferences] = useState({
    freightType: 'Dry Van',
    preferredEquipment: '',
    avgMonthlyVolume: '',
    regionsOfOperation: ''
  })

  function setPref(key, value){
    setPreferences(p => ({ ...p, [key]: value }))
  }

  // Capture key form fields from steps 1 and 2 so Final Review can show them.
  // We keep inputs visually unchanged but record their values on user input.
  const [shipperData, setShipperData] = useState({
    businessType: 'shipper',
    businessName: '',
    taxId: '',
    businessAddress: '',
    businessPhone: '',
    businessEmail: '',
    website: '',
    contactFullName: '',
    contactTitle: '',
    contactPhone: '',
    contactEmail: ''
  })

  function setShipperField(key, value){
    setShipperData(s => ({ ...s, [key]: value }))
  }

  const handleFinish = async () => {
    if (!currentUser) {
      navigate('/shipper-dashboard')
      return
    }

    setSaving(true)
    setSaveError('')

    try {
      const token = await currentUser.getIdToken()
      const allData = {
        ...shipperData,
        ...preferences,
      }

      const response = await fetch(`${API_URL}/onboarding/save`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          role: 'shipper',
          data: allData
        })
      })

      if (response.ok) {
        navigate('/shipper-dashboard')
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
          {currentStep === 1 ? (
            <p className="muted">Please Provide your Personal Information</p>
          ) : currentStep === 2 ? (
            <p className="muted">Please Provide your Contact Person Details</p>
          ) : currentStep === 3 ? (
            <p className="muted">Add Operating Authority Letter Optional</p>
          ) : currentStep === 4 ? (
            <p className="muted">Please Provide Freight Preferences</p>
          ) : (<p className="muted">Please Provide Freight Preferences</p>)}

          <form className="onboarding-form" onSubmit={(e)=>e.preventDefault()}>
            {currentStep === 1 && (
              <>
                <label>Business Type</label>
                <select value={shipperData.businessType} required onChange={(e)=>setShipperField('businessType', e.target.value)}>
                  <option value="shipper">Shipper</option>
                  <option value="broker">Broker</option>
                </select>

                <label>Business Name</label>
                <input placeholder="Business Name" value={shipperData.businessName} onChange={(e)=>setShipperField('businessName', e.target.value)} />

                <label>Tax ID (EIN)</label>
                <input placeholder="Tax ID (EIN)" value={shipperData.taxId} onChange={(e)=>setShipperField('taxId', e.target.value)} />

                <label>Business Address</label>
                <input placeholder="Business Address" value={shipperData.businessAddress} onChange={(e)=>setShipperField('businessAddress', e.target.value)} />

                <div className="row">
                  <div className="col">
                    <label>Business Phone Number</label>
                    <input placeholder="+1 (555) 555-5555" value={shipperData.businessPhone} onChange={(e)=>setShipperField('businessPhone', e.target.value)} />
                  </div>
                  <div className="col">
                    <label>Business Email Address</label>
                    <input placeholder="Business Email Address" value={shipperData.businessEmail} onChange={(e)=>setShipperField('businessEmail', e.target.value)} />
                  </div>
                </div>

                <label>Website (optional)</label>
                <input placeholder="Website" value={shipperData.website} onChange={(e)=>setShipperField('website', e.target.value)} />
              </>
            )}

            {currentStep === 2 && (
              <>
                <label>Full Name</label>
                <input placeholder="Full Name" value={shipperData.contactFullName} onChange={(e)=>setShipperField('contactFullName', e.target.value)} />

                <label>Title</label>
                <input placeholder="Title" value={shipperData.contactTitle} onChange={(e)=>setShipperField('contactTitle', e.target.value)} />

                <div className="row">
                  <div className="col">
                    <label>Phone Number</label>
                    <input placeholder="+1 (555) 555-5555" value={shipperData.contactPhone} onChange={(e)=>setShipperField('contactPhone', e.target.value)} />
                  </div>
                  <div className="col">
                    <label>Email Address</label>
                    <input placeholder="Email Address" value={shipperData.contactEmail} onChange={(e)=>setShipperField('contactEmail', e.target.value)} />
                  </div>
                </div>
              </>
            )}

            {currentStep === 3 && (
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

                <label>W-9 Form (Required)</label>
                <input ref={w9Ref} type="file" style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e)=>handleFileInput('w9', 'w9', e)} />
                <div className="upload-box" onDrop={(e)=>handleDrop('w9', 'w9', e)} onDragOver={preventDefault} onDragEnter={preventDefault} style={{display:'flex',flexDirection:'column',gap:8,cursor:'pointer'}} onClick={() => !uploads.w9 && w9Ref.current?.click()}>
                  {uploading.w9 ? (
                    <div style={{color:'#2563eb',textAlign:'center'}}>Uploading...</div>
                  ) : uploads.w9 ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                      <div style={{display:'flex',alignItems:'center',gap:12}}>
                        <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                        <div>
                          <div style={{fontWeight:700,color:'#22c55e'}}>{uploads.w9.file.name}</div>
                          <small className="field-note">{Math.round(uploads.w9.file.size/1024)} KB</small>
                        </div>
                      </div>
                      <button type="button" className="btn" onClick={(e) => {e.stopPropagation(); handleRemove('w9')}}>Remove</button>
                    </div>
                  ) : (
                    <div style={{display:'flex',alignItems:'center',flexDirection:'column',gap:8}}>
                      <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22,color:'grey'}} aria-hidden="true" />
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small className="field-note">PDF, PNG, or JPG (max 25MB)</small>
                    </div>
                  )}
                </div>

                <label>Proof of Business Registration (optional)</label>
                <input ref={proofRef} type="file" style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e)=>handleFileInput('proofOfRegistration', 'business_registration', e)} />
                <div className="upload-box" onDrop={(e)=>handleDrop('proofOfRegistration', 'business_registration', e)} onDragOver={preventDefault} onDragEnter={preventDefault} style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:72,cursor:'pointer'}} onClick={() => !uploads.proofOfRegistration && proofRef.current?.click()}>
                  {uploading.proofOfRegistration ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.proofOfRegistration ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%'}}>
                      <div style={{display:'flex',alignItems:'center',gap:12}}>
                        <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                        <div>
                          <div style={{fontWeight:700,color:'#22c55e'}}>{uploads.proofOfRegistration.file.name}</div>
                          <small className="field-note">{Math.round(uploads.proofOfRegistration.file.size/1024)} KB</small>
                        </div>
                      </div>
                      <button type="button" className="btn" onClick={(e) => {e.stopPropagation(); handleRemove('proofOfRegistration')}}>Remove</button>
                    </div>
                  ) : (
                    <div style={{display:'flex',flexDirection:'column',gap:8,alignItems:'center'}}>
                      <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:18,color:'grey'}} aria-hidden="true" />
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small className="field-note">PDF, PNG, or JPG (max 25MB)</small>
                    </div>
                  )}
                </div>

                <label>BMC-84/85 Certificate (Shipper/Broker)</label>
                <input ref={bmcRef} type="file" style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e)=>handleFileInput('bmc', 'bmc_certificate', e)} />
                <div className="upload-box" onDrop={(e)=>handleDrop('bmc', 'bmc_certificate', e)} onDragOver={preventDefault} onDragEnter={preventDefault} style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:72,cursor:'pointer'}} onClick={() => !uploads.bmc && bmcRef.current?.click()}>
                  {uploading.bmc ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.bmc ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%'}}>
                      <div style={{display:'flex',alignItems:'center',gap:12}}>
                        <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                        <div>
                          <div style={{fontWeight:700,color:'#22c55e'}}>{uploads.bmc.file.name}</div>
                          <small className="field-note">{Math.round(uploads.bmc.file.size/1024)} KB</small>
                        </div>
                      </div>
                      <button type="button" className="btn" onClick={(e) => {e.stopPropagation(); handleRemove('bmc')}}>Remove</button>
                    </div>
                  ) : (
                    <div style={{display:'flex',flexDirection:'column',gap:8,alignItems:'center'}}>
                      <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:18,color:'grey'}} aria-hidden="true" />
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small className="field-note">PDF, PNG, or JPG (max 25MB)</small>
                    </div>
                  )}
                </div>

                <label>Certificate of Insurance</label>
                <input ref={coiRef} type="file" style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e)=>handleFileInput('coi', 'coi', e)} />
                <div className="upload-box" onDrop={(e)=>handleDrop('coi', 'coi', e)} onDragOver={preventDefault} onDragEnter={preventDefault} style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:72,cursor:'pointer'}} onClick={() => !uploads.coi && coiRef.current?.click()}>
                  {uploading.coi ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.coi ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%'}}>
                      <div style={{display:'flex',alignItems:'center',gap:12}}>
                        <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                        <div>
                          <div style={{fontWeight:700,color:'#22c55e'}}>{uploads.coi.file.name}</div>
                          <small className="field-note">{Math.round(uploads.coi.file.size/1024)} KB</small>
                        </div>
                      </div>
                      <button type="button" className="btn" onClick={(e) => {e.stopPropagation(); handleRemove('coi')}}>Remove</button>
                    </div>
                  ) : (
                    <div style={{display:'flex',flexDirection:'column',gap:8,alignItems:'center'}}>
                      <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:18,color:'grey'}} aria-hidden="true" />
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small className="field-note">PDF, PNG, or JPG (max 25MB)</small>
                    </div>
                  )}
                </div>
              </>
            )}

            {currentStep === 4 && (
              <>

                <label>Types of Freight</label>
                <select value={preferences.freightType} onChange={(e)=>setPref('freightType', e.target.value)}>
                  <option>Dry Van</option>
                  <option>Reefer</option>
                  <option>Flatbed</option>
                  <option>Conestoga</option>
                </select>

                <label>Preferred Equipment</label>
                <input placeholder="Preferred Equipment" value={preferences.preferredEquipment} onChange={(e)=>setPref('preferredEquipment', e.target.value)} />

                <label>Average Monthly Load Volume</label>
                <input placeholder="Average Monthly Load Volume" value={preferences.avgMonthlyVolume} onChange={(e)=>setPref('avgMonthlyVolume', e.target.value)} />

                <label>Regions of Operation</label>
                <input placeholder="Regions Of Operation" value={preferences.regionsOfOperation} onChange={(e)=>setPref('regionsOfOperation', e.target.value)} />
              </>
            )}

            {currentStep === 5 && (
              <>
                <ShipperFinalReview
                  shipperData={shipperData}
                  preferences={preferences}
                  uploads={uploads}
                  setCurrentStep={setCurrentStep}
                />
              </>
            )}

            <div className="divider-line" />

            {saveError && (
              <div style={{padding:'12px',background:'#fee2e2',color:'#dc2626',borderRadius:'8px',marginBottom:'16px'}}>
                {saveError}
              </div>
            )}

            <div className="onboarding-actions">
              <button type="button" className="btn btn-secondary" onClick={handleBack} disabled={currentStep===1 || saving}>Back</button>
              <button
                type="button"
                className={"btn btn-primary " + (currentStep===5 ? '' : 'enabled')}
                onClick={currentStep===5 ? handleFinish : handleNext}
                disabled={saving}
              >
                {saving ? 'Saving...' : (currentStep===5 ? 'Finish' : 'Next')}
              </button>
            </div>
          </form>
        </div>
      </main>
      <div className="hero-chat-bubble" onClick={() => setIsChatOpen(s => !s)} style={{position: 'fixed', right: 18, bottom: 18, zIndex: 999}}>
        <img src={botpic} alt="AI Assistant" style={{width:42,height:42}} />
      </div>
      <Chatbot isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
    </div>
  )
}

function ShipperFinalReview({ shipperData, preferences, uploads, setCurrentStep }){
  // Props are now passed directly from parent component
  const data = shipperData || {
    businessType: 'shipper', businessName: '', taxId: '', businessAddress: '', businessPhone: '', businessEmail: '', website: '', contactFullName: '', contactTitle: '', contactPhone: '', contactEmail: ''
  }
  const prefs = preferences || { freightType: 'Dry Van', preferredEquipment: '', avgMonthlyVolume: '', regionsOfOperation: '' }
  const ups = uploads || { w9: null, proofOfRegistration: null, bmc: null, coi: null }
  const _setStep = setCurrentStep || (()=>{})

  return (
    <div style={{border:'1px solid #eef2f7',borderRadius:8,padding:16,display:'flex',flexDirection:'column',gap:12}}>

      <section>
        <h4 style={{margin:'8px 0'}}>Business Information</h4>
        <p style={{margin:0}}><strong>Type:</strong> {data.businessType}</p>
        <p style={{margin:0}}><strong>Name:</strong> {data.businessName || '—'}</p>
        <p style={{margin:0}}><strong>Tax ID:</strong> {data.taxId || '—'}</p>
        <p style={{margin:0}}><strong>Address:</strong> {data.businessAddress || '—'}</p>
        <p style={{margin:0}}><strong>Phone:</strong> {data.businessPhone || '—'}</p>
        <p style={{margin:0}}><strong>Email:</strong> {data.businessEmail || '—'}</p>
        <p style={{margin:0}}><strong>Website:</strong> {data.website || '—'}</p>
      </section>

      <section>
        <h4 style={{margin:'8px 0'}}>Contact Person</h4>
        <p style={{margin:0}}><strong>Name:</strong> {data.contactFullName || '—'}</p>
        <p style={{margin:0}}><strong>Title:</strong> {data.contactTitle || '—'}</p>
        <p style={{margin:0}}><strong>Phone:</strong> {data.contactPhone || '—'}</p>
        <p style={{margin:0}}><strong>Email:</strong> {data.contactEmail || '—'}</p>
      </section>

      <section>
        <h4 style={{margin:'8px 0'}}>Freight Preferences</h4>
        <p style={{margin:0}}><strong>Type:</strong> {prefs.freightType}</p>
        <p style={{margin:0}}><strong>Preferred Equipment:</strong> {prefs.preferredEquipment || '—'}</p>
        <p style={{margin:0}}><strong>Avg Monthly Volume:</strong> {prefs.avgMonthlyVolume || '—'}</p>
        <p style={{margin:0}}><strong>Regions:</strong> {prefs.regionsOfOperation || '—'}</p>
      </section>

      <section>
        <h4 style={{margin:'8px 0'}}>Uploaded Documents</h4>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:8,border:'1px solid #f1f5f9',borderRadius:8}}>
            <div style={{fontWeight:700}}>W-9</div>
            {ups.w9 ? (
              <div style={{color:'#22c55e', display:'flex', alignItems:'center', gap:4}}>
                <i className="fa-solid fa-check-circle" aria-hidden="true" />
                {ups.w9.file?.name || ups.w9.name || 'Uploaded'}
              </div>
            ) : <div style={{color:'#f59e0b'}}>Not uploaded</div>}
          </div>

          <div style={{padding:8,border:'1px solid #f1f5f9',borderRadius:8}}>
            <div style={{fontWeight:700}}>Proof of Registration</div>
            {ups.proofOfRegistration ? (
              <div style={{color:'#22c55e', display:'flex', alignItems:'center', gap:4}}>
                <i className="fa-solid fa-check-circle" aria-hidden="true" />
                {ups.proofOfRegistration.file?.name || ups.proofOfRegistration.name || 'Uploaded'}
              </div>
            ) : <div style={{color:'#f59e0b'}}>Not uploaded</div>}
          </div>

          <div style={{padding:8,border:'1px solid #f1f5f9',borderRadius:8}}>
            <div style={{fontWeight:700}}>BMC-84/85</div>
            {ups.bmc ? (
              <div style={{color:'#22c55e', display:'flex', alignItems:'center', gap:4}}>
                <i className="fa-solid fa-check-circle" aria-hidden="true" />
                {ups.bmc.file?.name || ups.bmc.name || 'Uploaded'}
              </div>
            ) : <div style={{color:'#f59e0b'}}>Not uploaded</div>}
          </div>

          <div style={{padding:8,border:'1px solid #f1f5f9',borderRadius:8}}>
            <div style={{fontWeight:700}}>Certificate of Insurance</div>
            {ups.coi ? (
              <div style={{color:'#22c55e', display:'flex', alignItems:'center', gap:4}}>
                <i className="fa-solid fa-check-circle" aria-hidden="true" />
                {ups.coi.file?.name || ups.coi.name || 'Uploaded'}
              </div>
            ) : <div style={{color:'#f59e0b'}}>Not uploaded</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
