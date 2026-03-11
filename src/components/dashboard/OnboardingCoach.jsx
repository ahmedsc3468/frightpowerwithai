import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../../config';

export default function OnboardingCoach({ documents: _documents = [] }) {
  const { currentUser, userRole: _userRole } = useAuth();
  const navigate = useNavigate();

  const [_coachData, setCoachData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [score, setScore] = useState(0);
  const [status, setStatus] = useState('Red'); // Red, Amber, Green
  const [nextAction, setNextAction] = useState(null);
  const [steps, setSteps] = useState([]);

  // Fetch coach status from API
  useEffect(() => {
    async function fetchCoachStatus() {
      if (!currentUser) {
        setLoading(false);
        return;
      }
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`${API_URL}/onboarding/coach-status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setCoachData(data);
          setScore(data.total_score || 0);
          setStatus(data.status_color || 'Red');
          setSteps(data.steps || []);

          // Set next action from API data
          if (data.next_best_actions && data.next_best_actions.length > 0) {
            const firstAction = data.next_best_actions[0];
            setNextAction({
              type: 'action',
              label: firstAction,
              path: data.current_step === 'documents' ? '/documents' :
                    data.current_step === 'consents' ? '/consents' :
                    data.current_step === 'profile' ? '/settings' : '/dashboard'
            });
          } else {
            setNextAction({ type: 'complete', label: 'All Set! Browse Loads', path: '/marketplace' });
          }
        }
      } catch (err) {
        console.error("Coach Error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchCoachStatus();
  }, [currentUser]);

  if (loading) return <div className="p-4 bg-white rounded-xl shadow animate-pulse h-40"></div>;

  return (
    <div className="bg-white rounded-xl shadow-md border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="bg-slate-900 p-4 text-white flex justify-between items-center">
        <h3 className="font-bold flex items-center gap-2">
          <span>🚀</span> Onboarding Coach
        </h3>
        <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${
          status === 'Green' ? 'bg-green-500 text-white' :
          status === 'Amber' ? 'bg-amber-500 text-white' :
          'bg-red-500 text-white'
        }`}>
          {status} Status
        </span>
      </div>

      <div className="p-6">
        {/* Score Circle */}
        <div className="flex items-center gap-6 mb-6">
          <div className="relative w-20 h-20 flex-shrink-0">
            <svg className="w-full h-full transform -rotate-90">
              <circle cx="40" cy="40" r="36" stroke="#e2e8f0" strokeWidth="8" fill="none" />
              <circle 
                cx="40" cy="40" r="36" 
                stroke={status === 'Green' ? '#22c55e' : status === 'Amber' ? '#f59e0b' : '#ef4444'} 
                strokeWidth="8" 
                fill="none" 
                strokeDasharray="226" 
                strokeDashoffset={226 - (226 * score) / 100} 
                className="transition-all duration-1000 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center font-bold text-xl text-slate-700">
              {score}%
            </div>
          </div>
          
          <div>
            <h4 className="text-lg font-bold text-slate-800">Next Best Action</h4>
            <p className="text-sm text-slate-500 mb-2">To unlock the full marketplace:</p>
            <button 
              onClick={() => navigate(nextAction?.path || '/')}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2"
            >
              {nextAction?.label || "Loading..."} <span>→</span>
            </button>
          </div>
        </div>

        {/* Mini Checklist */}
        <div className="space-y-2 border-t pt-4">
          {steps.length > 0 ? (
            steps.map((step, idx) => (
              <CheckItem key={idx} label={step.title} done={step.completed} />
            ))
          ) : (
            <>
              <CheckItem label="Complete Profile" done={score >= 20} />
              <CheckItem label="Upload Documents" done={score >= 60} />
              <CheckItem label="Sign Agreements" done={score >= 80} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckItem({ label, done }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
        done ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
      }`}>
        {done ? '✓' : '○'}
      </div>
      <span className={done ? 'text-gray-700 font-medium' : 'text-gray-400'}>{label}</span>
    </div>
  );
}