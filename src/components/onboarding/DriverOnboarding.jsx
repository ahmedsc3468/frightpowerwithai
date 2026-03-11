import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { API_URL } from '../../config'
import carrier_ob_1 from '../../assets/carrier_ob_1.png'
import carrier_ob_2 from '../../assets/carrier_ob_2.jpg'
import carrier_ob_3 from '../../assets/carrier_ob_3.jpg'
import './Onboarding.css'
import Chatbot from '../../components/landing_page/Chatbot'
import verification from '../../assets/verification_bg.svg'
import botpic from '../../assets/chatbot.svg'

export default function DriverOnboarding(){
  const navigate = useNavigate()
  const { currentUser } = useAuth()
  const images = [carrier_ob_1, carrier_ob_2, carrier_ob_3]
  const [_currentImg, setCurrentImg] = useState(0)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // File upload refs
  const cdlRef = useRef()
  const mvrRef = useRef()
  const medicalRef = useRef()
  const drugTestRef = useRef()
  const clearinghouseRef = useRef()

  // File upload state
  const [uploads, setUploads] = useState({
    cdl: null,
    mvr: null,
    medical: null,
    drugTest: null,
    clearinghouse: null
  })
  const [uploading, setUploading] = useState({})
  const [uploadError, setUploadError] = useState('')
  const [uploadSuccess, setUploadSuccess] = useState('')

  // Form state
  const [formData, setFormData] = useState({
    fullName: '',
    phone: '',
    email: '',
    password: '',
    cdlNumber: '',
    issuingState: '',
    cdlClass: '',
    endorsements: '',
    preferredRegions: '',
    availableStartDate: '',
    vehicleType: '',
    equipmentExperience: '',
  })

  const updateField = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

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
        const expiryMsg = result.expiry_date ? ` Expiry: ${result.expiry_date}` : ''
        setUploadSuccess(`${file.name} uploaded successfully!${expiryMsg}`)
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
    const t = setInterval(()=> setCurrentImg(p => (p+1)%images.length), 3000)
    return ()=> clearInterval(t)
  },[])

  const steps = ['Personal Info','CDL Details','Availability','Compliance Documents','Final Review']

  function handleNext(){
    setCurrentStep(s => Math.min(5, s+1))
  }
  function handleBack(){
    setCurrentStep(s => Math.max(1, s-1))
  }

  const handleFinish = async () => {
    if (!currentUser) {
      navigate('/driver-dashboard')
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
          role: 'driver',
          data: formData
        })
      })

      if (response.ok) {
        navigate('/driver-dashboard')
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
            <p className="muted">Please Provide your CDL Details</p>
          ) : currentStep === 3 ? (
            <p className="muted">Please Provide your Availability</p>
          ) : currentStep === 4 ? (
            <p className="muted">Please Provide your Compliance Documents</p>
          ) : currentStep === 5 ? (
            <p className="muted">Please review the information you provided before submitting.</p>
          ) : (
            <p className="muted">Follow the steps to complete your driver profile</p>
          )}

          {saveError && (
            <div style={{padding:'12px',background:'#fee2e2',color:'#dc2626',borderRadius:'8px',marginBottom:'16px'}}>
              {saveError}
            </div>
          )}

          <form className="onboarding-form" onSubmit={(e)=>e.preventDefault()}>
            {currentStep === 1 && (
              <>
                <label>Full Name</label>
                <input placeholder="Full name" value={formData.fullName} onChange={(e) => updateField('fullName', e.target.value)} />

                <div style={{display:'flex',gap:12}}>
                  <div style={{flex:1}}>
                    <label>Phone Number</label>
                    <input placeholder="+1 (555) 555-5555" value={formData.phone} onChange={(e) => updateField('phone', e.target.value)} />
                  </div>
                  <div style={{flex:1}}>
                    <label>Email Address</label>
                    <input placeholder="email@company.com" value={formData.email} onChange={(e) => updateField('email', e.target.value)} />
                  </div>
                </div>

                <label>Password</label>
                <input type="password" placeholder="Password" value={formData.password} onChange={(e) => updateField('password', e.target.value)} />
              </>
            )}

            {currentStep === 2 && (
              <>
                <label>CDL License Number</label>
                <input placeholder="CDL Number" value={formData.cdlNumber} onChange={(e) => updateField('cdlNumber', e.target.value)} />

                <label>Issuing State</label>
                <input placeholder="Issuing State" value={formData.issuingState} onChange={(e) => updateField('issuingState', e.target.value)} />

                <label>CDL Class</label>
                <select value={formData.cdlClass} onChange={(e) => updateField('cdlClass', e.target.value)} required>
                  <option value="">CDL Class</option>
                  <option value="A">Class A</option>
                  <option value="B">Class B</option>
                  <option value="C">Class C</option>
                </select>

                <label>Endorsements</label>
                <select value={formData.endorsements} onChange={(e) => updateField('endorsements', e.target.value)} required>
                  <option value="">Endorsements</option>
                  <option value="tanker">Tanker</option>
                  <option value="haz">Hazardous</option>
                  <option value="pass">Passenger</option>
                  <option value="school">School Bus</option>
                </select>

                <label>Upload CDL License</label>
                <input type="file" ref={cdlRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('cdl', 'cdl', e)} />
                <div
                  className="upload-box"
                  style={{minHeight:120, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, cursor:'pointer'}}
                  onClick={() => cdlRef.current?.click()}
                  onDrop={(e) => handleFileDrop('cdl', 'cdl', e)}
                  onDragOver={preventDefault}
                  onDragEnter={preventDefault}
                >
                  {uploading.cdl ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.cdl ? (
                    <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:22, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700}}>{uploads.cdl.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : (
                    <>
                      <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:22, color:'grey'}} aria-hidden="true" />
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small>PDF, JPG or PNG (max. 25MB)</small>
                    </>
                  )}
                </div>

                <div className="divider-line" />
              </>
            )}

            {currentStep === 3 && (
              <>
                <label>Preferred Driving Regions</label>
                <input placeholder="Preferred Driving Regions" value={formData.preferredRegions} onChange={(e) => updateField('preferredRegions', e.target.value)} />

                <label>Available Start Date</label>
                <input type="date" placeholder="Available Start Date" value={formData.availableStartDate} onChange={(e) => updateField('availableStartDate', e.target.value)} />

                <label>Vehicle Type Currently Using</label>
                <select value={formData.vehicleType} onChange={(e) => updateField('vehicleType', e.target.value)} required>
                  <option value="">Select vehicle type</option>
                  <option value="power_unit">Power Unit</option>
                  <option value="dry_van">Dry Van</option>
                  <option value="reefer">Reefer</option>
                </select>

                <label>Equipment Type Experience</label>
                <select value={formData.equipmentExperience} onChange={(e) => updateField('equipmentExperience', e.target.value)} required>
                  <option value="">Equipment Type Experience</option>
                  <option value="dry">Dry Van</option>
                  <option value="reefer">Reefer</option>
                  <option value="flat">Flatbed</option>
                </select>

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

                <label>Upload MVR (Motor Vehicle Report)</label>
                <input type="file" ref={mvrRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('mvr', 'mvr', e)} />
                <div
                  className="upload-box"
                  style={{minHeight:110, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, cursor:'pointer'}}
                  onClick={() => mvrRef.current?.click()}
                  onDrop={(e) => handleFileDrop('mvr', 'mvr', e)}
                  onDragOver={preventDefault}
                  onDragEnter={preventDefault}
                >
                  {uploading.mvr ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.mvr ? (
                    <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700, fontSize:14}}>{uploads.mvr.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : (
                    <>
                      <div style={{width:36,height:36,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:8,background:'#fff'}}>
                        <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:16,color:'grey'}} aria-hidden="true" />
                      </div>
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small>PDF, JPG or PNG (max. 25MB)</small>
                    </>
                  )}
                </div>

                <label>Upload Medical Certificate</label>
                <input type="file" ref={medicalRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('medical', 'medical_card', e)} />
                <div
                  className="upload-box"
                  style={{minHeight:110, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, cursor:'pointer'}}
                  onClick={() => medicalRef.current?.click()}
                  onDrop={(e) => handleFileDrop('medical', 'medical_card', e)}
                  onDragOver={preventDefault}
                  onDragEnter={preventDefault}
                >
                  {uploading.medical ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.medical ? (
                    <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700, fontSize:14}}>{uploads.medical.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : (
                    <>
                      <div style={{width:36,height:36,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:8,background:'#fff'}}>
                        <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:16,color:'grey'}} aria-hidden="true" />
                      </div>
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small>PDF, JPG or PNG (max. 25MB)</small>
                    </>
                  )}
                </div>

                <label>Drug Test Result (if available)</label>
                <input type="file" ref={drugTestRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('drugTest', 'drug_test', e)} />
                <div
                  className="upload-box"
                  style={{minHeight:110, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, cursor:'pointer'}}
                  onClick={() => drugTestRef.current?.click()}
                  onDrop={(e) => handleFileDrop('drugTest', 'drug_test', e)}
                  onDragOver={preventDefault}
                  onDragEnter={preventDefault}
                >
                  {uploading.drugTest ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.drugTest ? (
                    <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700, fontSize:14}}>{uploads.drugTest.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : (
                    <>
                      <div style={{width:36,height:36,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:8,background:'#fff'}}>
                        <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:16,color:'grey'}} aria-hidden="true" />
                      </div>
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small>PDF, JPG or PNG (max. 25MB)</small>
                    </>
                  )}
                </div>

                <label>FMCSA Clearinghouse Consent</label>
                <input type="file" ref={clearinghouseRef} style={{display:'none'}} accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => handleFileInput('clearinghouse', 'consent', e)} />
                <div
                  className="upload-box"
                  style={{minHeight:110, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, cursor:'pointer'}}
                  onClick={() => clearinghouseRef.current?.click()}
                  onDrop={(e) => handleFileDrop('clearinghouse', 'consent', e)}
                  onDragOver={preventDefault}
                  onDragEnter={preventDefault}
                >
                  {uploading.clearinghouse ? (
                    <div style={{color:'#2563eb'}}>Uploading...</div>
                  ) : uploads.clearinghouse ? (
                    <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                      <i className="fa-solid fa-check-circle" style={{fontSize:18, color:'#22c55e'}} aria-hidden="true" />
                      <div style={{color:'#22c55e', fontWeight:700, fontSize:14}}>{uploads.clearinghouse.file.name}</div>
                      <small style={{color:'#6b7280'}}>Click to replace</small>
                    </div>
                  ) : (
                    <>
                      <div style={{width:36,height:36,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:8,background:'#fff'}}>
                        <i className="fa-solid fa-cloud-arrow-up" style={{fontSize:16,color:'grey'}} aria-hidden="true" />
                      </div>
                      <div style={{color:'grey', fontWeight:700}}>Click to upload or drag and drop</div>
                      <small>PDF, JPG or PNG (max. 25MB)</small>
                    </>
                  )}
                </div>

                <div className="divider-line" />
              </>
            )}

            {currentStep === 5 && (
              <DriverFinalReview formData={formData} uploads={uploads} onEdit={(s) => setCurrentStep(s)} />
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

function DriverFinalReview({ formData, uploads, onEdit }){
  const docs = [
    {k:'mvr', label:'MVR (Motor Vehicle Report)'},
    {k:'medical', label:'Medical Certificate'},
    {k:'drugTest', label:'Drug Test Result'},
    {k:'clearinghouse', label:'FMCSA Clearinghouse Consent'}
  ];

  return (
    <div style={{border:'1px solid #eef2f7',borderRadius:8,padding:16,display:'flex',flexDirection:'column',gap:12}}>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Personal Information</h4>
          <button type="button" onClick={() => onEdit(1)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer'}}>Edit</button>
        </div>
        <p style={{margin:0}}><strong>Name:</strong> {formData.fullName || '—'}</p>
        <p style={{margin:0}}><strong>Phone:</strong> {formData.phone || '—'}</p>
        <p style={{margin:0}}><strong>Email:</strong> {formData.email || '—'}</p>
      </section>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>CDL Details</h4>
          <button type="button" onClick={() => onEdit(2)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer'}}>Edit</button>
        </div>
        <p style={{margin:0}}><strong>CDL Number:</strong> {formData.cdlNumber || '—'}</p>
        <p style={{margin:0}}><strong>Issuing State:</strong> {formData.issuingState || '—'}</p>
        <p style={{margin:0}}><strong>CDL Class:</strong> {formData.cdlClass || '—'}</p>
        <p style={{margin:0}}><strong>Endorsements:</strong> {formData.endorsements || '—'}</p>
      </section>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Availability</h4>
          <button type="button" onClick={() => onEdit(3)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer'}}>Edit</button>
        </div>
        <p style={{margin:0}}><strong>Preferred Regions:</strong> {formData.preferredRegions || '—'}</p>
        <p style={{margin:0}}><strong>Available Start Date:</strong> {formData.availableStartDate || '—'}</p>
        <p style={{margin:0}}><strong>Equipment Experience:</strong> {formData.equipmentExperience || '—'}</p>
      </section>

      <section>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <h4 style={{margin:'8px 0'}}>Uploaded Documents</h4>
          <button type="button" onClick={() => onEdit(4)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer'}}>Edit</button>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          {docs.map(d => (
            <div key={d.k} style={{padding:8,border:'1px solid #f1f5f9',borderRadius:8}}>
              <div style={{fontWeight:700}}>{d.label}</div>
              {uploads?.[d.k] ? (
                <div style={{color:'#22c55e', display:'flex', alignItems:'center', gap:4}}>
                  <i className="fa-solid fa-check-circle" aria-hidden="true" />
                  {uploads[d.k].file.name}
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
