import React from 'react';
import '../../styles/super_admin/MarketingPromotion.css';
import '../../styles/admin/Tasks.css';
import { downloadCsv } from '../../utils/fileDownload';

export default function MarketingPromotion(){

  const _rows = [
    { title: 'Verify carrier documents', module: 'Compliance', assigned: 'Lisa', priority: 'High', due: 'Oct 14', status: 'In Progress' },
    { title: 'Send broker reminder', module: 'Messages', assigned: 'Ahmed', priority: 'Medium', due: 'Oct 13', status: 'Overdue' },
    { title: 'Update campaign copy', module: 'Marketing', assigned: 'Farhia', priority: 'Low', due: 'Oct 18', status: 'Done' },
    { title: 'Review onboarding docs', module: 'Hiring', assigned: 'You', priority: 'Medium', due: 'Oct 20', status: 'In Progress' }
  ];

  const campaigns = [
    { campaign: 'Partner Spotlight', type: 'Internal', channel: 'Banner', audience: 'Carriers', status: 'Active', performance: '22K views' },
    { campaign: 'FreightPower Newsletter', type: 'External', channel: 'Email', audience: 'All Users', status: 'Scheduled', performance: '—' },
    { campaign: 'Provider Discount', type: 'Internal', channel: 'Popup', audience: 'Providers', status: 'Draft', performance: '—' },
    { campaign: 'Safety Tips', type: 'External', channel: 'SMS', audience: 'Drivers', status: 'Ended', performance: '58% open' },
  ];

  const handleExport = () => {
    downloadCsv('marketing_campaigns', campaigns, ['campaign', 'type', 'channel', 'audience', 'status', 'performance']);
  };
    
  return (
    <div className="mp-root">
        <header className="fp-header">
        <div className="fp-header-titles">
          <h2>Marketing & Promotions</h2>
        </div>
      </header>

      <div className="action-bar">
        <div className="action-left" style={{width: '100%'}}>         
          <div className="search-wrapper mp-search-wrapper" style={{width: '100%'}}>
            <i className="fa-solid fa-magnifying-glass" />
            <input type="text" placeholder="Search" style={{width: '100%'}}/>
          </div>
        </div>

        <div className="action-right fp-filters">
            <select className="sb-carrier-filter-select" aria-label="Type">
                <option value="">Type</option>
                <option value="internal">Internal</option>
                <option value="external">External</option>
              </select>

              <select className="sb-carrier-filter-select" aria-label="Status">
                <option value="">Status</option>
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="scheduled">Scheduled</option>
                <option value="draft">Draft</option>
                <option value="ended">Ended</option>
              </select>

              <select className="sb-carrier-filter-select" aria-label="Date Range">
                <option value="">Date Range</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="custom">Custom Range</option>
              </select>
        </div>
      </div>

      <section className="mp-stats">
        <div className="mp-stat card"><div className="mp-num">4</div><div className="mp-label">Active</div></div>
        <div className="mp-stat card"><div className="mp-num">2</div><div className="mp-label">Drafts</div></div>
        <div className="mp-stat card"><div className="mp-num">24K</div><div className="mp-label">Reach</div></div>
        <div className="mp-stat card"><div className="mp-num">12.4%</div><div className="mp-label">Avg CTR</div></div>
        <div className="mp-stat card"><div className="mp-num">3</div><div className="mp-label">Tasks</div></div>
      </section>

      <div className="mp-actions-inline" style={{marginBottom: '10px'}}>
            <button className="btn small-cd">+ New Campaign</button>
            <button className="btn small ghost-cd">Bulk</button>
            <button className="btn small ghost-cd">AI Suggest</button>
        <button className="btn small ghost-cd" type="button" onClick={handleExport}>Export</button>
        </div>

        <div className="ai-summary" style={{marginBottom: '20px'}}>
              <div className="ai-summary-left">
                <span className="aai-icon"><i className="fa fa-info-circle" aria-hidden="true"></i></span>
                <div className="aai-text"><strong>AI Summary:</strong>4 active campaigns, 2 pending approval. Internal banners outperform email by 2.4x CTR. AI suggests a "Verified Partner Week" — highlight this Friday.</div>
              </div>
              <div className="aai-actions">
                <button className="btn small ghost-cd"><i className="fa fa-check" aria-hidden="true"></i> Accept</button>
                <button className="btn small ghost-cd"> Generate Idea</button>
                <button className="btn small ghost-cd"> Schedule</button>
              </div>
            </div>

      <div className="mp-content">
        <main className="mp-main">
          <div className="mp-table-toolbar">
            <div className="left">Active Campaigns</div>
          </div>

          <div className="tasks-main" style={{marginTop: '20px'}}>
        <div className="tasks-table-wrap">
          <table className="tasks-table">
            <thead>
                  <tr>
                    <th style={{width:32}}><input type="checkbox"/></th>
                    <th>Campaign</th>
                    <th>Type</th>
                    <th>Channel</th>
                    <th>Audience</th>
                    <th>Status</th>
                    <th>Performance</th>
                    <th>Actions</th>
                  </tr>
                </thead>
            <tbody>
                  <tr>
                    <td><input type="checkbox"/></td>
                    <td>Partner Spotlight</td>
                    <td>Internal</td>
                    <td>Banner</td>
                    <td>Carriers</td>
                    <td><span className="int-status-badge success">Active</span></td>
                    <td>22K views</td>
                    <td><i className="fa fa-ellipsis-h" aria-hidden="true"></i></td>
                  </tr>

                  <tr>
                    <td><input type="checkbox"/></td>
                    <td>FreightPower Newsletter</td>
                    <td>External</td>
                    <td>Email</td>
                    <td>All Users</td>
                    <td><span className="int-status-badge scheduled">Scheduled</span></td>
                    <td>—</td>
                    <td><i className="fa fa-ellipsis-h" aria-hidden="true"></i></td>
                  </tr>

                  <tr>
                    <td><input type="checkbox"/></td>
                    <td>Provider Discount</td>
                    <td>Internal</td>
                    <td>Popup</td>
                    <td>Providers</td>
                    <td><span className="int-status-badge draft">Draft</span></td>
                    <td>—</td>
                    <td><i className="fa fa-ellipsis-h" aria-hidden="true"></i></td>
                  </tr>

                  <tr>
                    <td><input type="checkbox"/></td>
                    <td>Safety Tips</td>
                    <td>External</td>
                    <td>SMS</td>
                    <td>Drivers</td>
                    <td><span className="int-status-badge ended">Ended</span></td>
                    <td>58% open</td>
                    <td><i className="fa fa-ellipsis-h" aria-hidden="true"></i></td>
                  </tr>
                </tbody>
          </table>
        </div>

        <aside className="tasks-right">
          <div className="team-performance">
            <div className="field-row"><label>Name:</label><div className="muted">Partner Spotlight</div></div>
            <div className="field-row"><label>Start Date:</label><div className="muted">2025-09-01</div></div>
            <div className="field-row"><label>End Date:</label><div className="muted">2025-09-30</div></div>
            <div className="field-row"><label>Budget:</label><div className="muted">$420.00</div></div>
            <div className="field-row"><label>Goal:</label><div className="muted">Increase provider reach</div></div>

            <div style={{marginTop:12}}>
              <textarea className='text-area-mp' rows={4} placeholder="Notes..." style={{width:'100%'}} />
            </div>

            <div style={{display:'flex',gap:8,marginTop:12}}>
              <button className="btn small-cd">Save</button>
              <button className="btn small ghost-cd">Notify</button>
            </div></div>
        </aside>
      </div>

          <section className="mp-analytics-cards">
            <div className="analytic-card"><div className="num">8,247</div><div className="label">Emails Sent</div></div>
            <div className="analytic-card"><div className="num">7,891</div><div className="label">Delivered</div></div>
            <div className="analytic-card"><div className="num">4,156</div><div className="label">Opened</div></div>
            <div className="analytic-card"><div className="num">1,023</div><div className="label">Clicked</div></div>
          </section>

          <div className="mp-footer-note">Messages to verified carriers saw +18% engagement vs average. Next optimal send window: <strong>Tue 9 AM CST</strong>.</div>
        </main>
      </div>

      <div className="mp-last-line">
        <div className="muted">Last updated: Oct 15, 2024 at 2:34 PM</div>
        <div className="muted">Auto-refresh in 25s</div>
      </div>
    </div>
  );
}
