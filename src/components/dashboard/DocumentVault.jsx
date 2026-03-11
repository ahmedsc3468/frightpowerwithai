import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { API_URL } from '../../config';
import DocumentScanner from './DocumentScanner';

export default function DocumentVault() {
  const { currentUser } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [_error, _setError] = useState('');

  // 1. Fetch REAL Documents from Backend on Load
  useEffect(() => {
    if (currentUser) {
      fetchDocuments();
    }
  }, [currentUser]);

  const fetchDocuments = async () => {
    try {
      const token = await currentUser.getIdToken();
      // Assuming you have a GET /documents endpoint (standard REST practice)
      // If not, we can simulate the list for now or you can add `store.list_documents()` to main.py
      const response = await fetch(`${API_URL}/documents`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        // Assuming backend returns { documents: [...] } or a list
        setDocuments(Array.isArray(data) ? data : data.documents || []);
      }
    } catch (err) {
      console.error("Failed to fetch docs:", err);
      // Don't show error to user immediately, just log it
    } finally {
      setLoading(false);
    }
  };

  // 2. Handle New Scan Result (Real AI Data)
  const handleScanComplete = (scanResult) => {
    // The backend returns the full analysis. We create a UI object from it.
    const newDoc = {
      id: scanResult.document_id, // Real UUID from backend
      name: `Scanned_${scanResult.doc_type}_${new Date().getTime()}.pdf`, // Or use original filename if returned
      type: scanResult.doc_type,
      status: scanResult.validation?.status || 'Pending',
      score: scanResult.score?.total || 0,
      date: new Date().toLocaleDateString()
    };
    
    // Add to top of list locally and refresh from backend for consistency
    setDocuments((prev) => [newDoc, ...prev]);
    fetchDocuments();
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800">Document Vault</h2>
        <span className="text-sm text-gray-500">{documents.length} Documents stored</span>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* LEFT: The AI Scanner */}
        <div className="lg:col-span-1">
          <DocumentScanner onScanComplete={handleScanComplete} />
        </div>

        {/* RIGHT: Real Document List */}
        <div className="lg:col-span-2">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 min-h-[400px]">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
              <span>🗂️</span> Stored Documents
            </h3>
            
            {loading ? (
              <div className="text-center py-12 text-gray-400">Loading documents...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b text-gray-500 text-xs uppercase tracking-wider">
                      <th className="py-3 px-2">Type</th>
                      <th className="py-3 px-2">Score</th>
                      <th className="py-3 px-2">Status</th>
                      <th className="py-3 px-2">Date</th>
                      <th className="py-3 px-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.length > 0 ? (
                      documents.map((doc) => (
                        <tr key={doc.id} className="border-b hover:bg-gray-50 transition-colors">
                          <td className="py-3 px-2 font-bold text-slate-700">{doc.type || 'Unknown'}</td>
                          <td className="py-3 px-2">
                            {doc.score ? (
                              <span className={`font-semibold ${doc.score >= 80 ? 'text-green-600' : 'text-amber-600'}`}>
                                {doc.score}/100
                              </span>
                            ) : '-'}
                          </td>
                          <td className="py-3 px-2">
                            <span className={`px-2 py-1 rounded text-xs font-semibold ${
                              doc.status === 'Verified' || doc.status === 'Valid' ? 'bg-green-100 text-green-700' :
                              doc.status === 'Expired' ? 'bg-red-100 text-red-700' :
                              'bg-yellow-100 text-yellow-700'
                            }`}>
                              {doc.status}
                            </span>
                          </td>
                          <td className="py-3 px-2 text-sm text-gray-500">{doc.date}</td>
                          <td className="py-3 px-2 text-right">
                            <button className="text-blue-600 hover:text-blue-800 text-sm font-medium">View</button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="5" className="text-center py-12 text-gray-400">
                          No documents found. Use the scanner to upload your first one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}