import { useState } from 'react';
import { Link } from 'react-router-dom';
import useDashboard from '../hooks/useDashboard';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import EventsChart from '../components/EventsChart';
import SeverityDonut from '../components/SeverityDonut';
import AlertFeed from '../components/AlertFeed';
import RiskyDatabases from '../components/RiskyDatabases';
import EventsByDatabase from '../components/EventsByDatabase';
import SensitiveAccessChart from '../components/SensitiveAccessChart';
import CompliancePosture from '../components/CompliancePosture';
import CoverageDonut from '../components/CoverageDonut';

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatCurrency(n) {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n;
}

export default function Dashboard() {
  const { kpis, eventsTimeline, riskyDbs, recentAlerts, alertSeverity, eventsByDb, sensitiveAccess, sensitiveDaily, compliance, coverage, loading, lastRefresh, refresh } = useDashboard(30000);
  const [showRiskDetail, setShowRiskDetail] = useState(false);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Loading dashboard...</p>
      </div>
    );
  }

  const sensitiveReads = kpis?.sensitiveReads ?? sensitiveAccess.reduce((s, r) => s + parseInt(r.cnt || 0), 0);
  const fleetRisk = kpis?.fleetRisk ?? 0;
  const riskFactors = kpis?.fleetRiskFactors;
  const complianceAvg = compliance.length > 0 ? Math.round(compliance.reduce((s, c) => s + c.score, 0) / compliance.length) : 0;
  const quarantined = kpis?.quarantined ?? 0;

  return (
    <Layout activePage="dashboard" lastRefresh={lastRefresh} onRefresh={refresh}>
      <div className="page-header">
        <div>
          <h1>Security Dashboard</h1>
          <div className="page-meta">
            <span>📅 {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
            <span>🏢 Meridian Financial Group</span>
            <span>◉ {kpis?.databases?.total ?? 0} databases · {kpis?.agents?.total ?? 0} agents</span>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => alert('Export coming soon')}>⭳ Export</button>
          <Link className="btn-primary" to="/alerts">⚠ Triage alerts</Link>
        </div>
      </div>

      <main className="dashboard-content">
        {/* KPI Row 1 — same as mockup */}
        <section className="kpi-grid">
          <KpiCard
            icon="▥" label="Monitored DBs"
            value={kpis?.databases?.monitored ?? '-'}
            detail={`▲ ${kpis?.databases?.total ?? 0} total registered`}
            detailType="up"
          />
          <KpiCard
            icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)"
            label="Open Alerts"
            value={kpis?.alerts?.total ?? 0}
            detail={`${kpis?.alerts?.critical ?? 0} critical · ${kpis?.alerts?.high ?? 0} high`}
            detailType={kpis?.alerts?.total > 0 ? 'down' : 'up'}
          />
          <div style={{position:'relative'}}>
            <KpiCard
              icon="◎" iconBg="var(--danger-soft)" iconColor="var(--danger)"
              label="Fleet Risk"
              value={<>{fleetRisk}<span style={{fontSize:13,fontWeight:600,color:'var(--muted)'}}>/100</span></>}
              detail={fleetRisk >= 70 ? 'High risk · click for breakdown' : fleetRisk >= 40 ? 'Medium risk · click for breakdown' : 'Low risk'}
              detailType={fleetRisk >= 60 ? 'down' : 'up'}
              onClick={() => setShowRiskDetail(!showRiskDetail)}
            />
            {showRiskDetail && riskFactors && (
              <div className="risk-detail-popup">
                <div className="risk-detail-header"><b>Fleet Risk Breakdown</b><span>{fleetRisk}/100</span></div>
                {Object.entries(riskFactors).map(([key, f]) => (
                  <div key={key} className="risk-factor">
                    <div className="risk-factor-head">
                      <span>{f.detail}</span>
                      <span className="risk-factor-weight">{f.weight}</span>
                    </div>
                    <div className="risk-factor-bar">
                      <div className="risk-factor-fill" style={{width: `${f.value}%`, background: f.value >= 70 ? 'var(--danger)' : f.value >= 40 ? 'var(--amber)' : 'var(--green)'}} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <KpiCard
            icon="⚖" iconBg="var(--green-soft)" iconColor="var(--green)"
            label="Compliance Posture"
            value={<>{complianceAvg}<span style={{fontSize:13,fontWeight:600,color:'var(--muted)'}}>%</span></>}
            detail={`${compliance.filter(c => c.score < 85).length} gaps open`}
            detailType={complianceAvg >= 85 ? 'up' : 'down'}
          />
        </section>

        {/* KPI Row 2 — same as mockup */}
        <section className="kpi-grid">
          <KpiCard
            icon="≋" iconBg="var(--info-soft)" iconColor="var(--info)"
            label="Events Today"
            value={formatNumber(kpis?.eventsToday ?? 0)}
            detail="from all monitored databases"
            detailType="up"
          />
          <KpiCard
            icon="◧" iconBg="var(--amber-soft)" iconColor="var(--amber)"
            label="Sensitive Reads"
            value={formatNumber(sensitiveReads)}
            detail={sensitiveAccess.map(s => s.tag.toUpperCase()).slice(0, 5).join(' · ') || 'PII · PCI · PHI'}
          />
          <KpiCard
            icon="⊡" iconBg="var(--green-soft)" iconColor="var(--green)"
            label="Agents Online"
            value={<>{kpis?.agents?.online ?? 0}<span style={{fontSize:13,fontWeight:600,color:'var(--muted)'}}>/{kpis?.agents?.total ?? 0}</span></>}
            detail={(kpis?.agents?.total ?? 0) - (kpis?.agents?.online ?? 0) > 0
              ? `${kpis.agents.total - kpis.agents.online} offline`
              : 'all healthy'}
            detailType={(kpis?.agents?.total ?? 0) - (kpis?.agents?.online ?? 0) > 0 ? 'down' : 'up'}
          />
          <KpiCard
            icon="⛔" label="Quarantined"
            value={quarantined}
            detail="sessions held · pending review"
          />
        </section>

        {/* Events + Severity */}
        <section className="charts-row">
          <div className="card">
            <div className="card-header">
              <span className="card-title">Events ingested · last 12h (all regions)</span>
              <span className="card-sub">live from ClickHouse</span>
            </div>
            <div className="card-body">
              <EventsChart data={eventsTimeline} />
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Open alerts by severity</span>
            </div>
            <div className="card-body">
              <SeverityDonut counts={alertSeverity} />
            </div>
          </div>
        </section>

        {/* Risky DBs + Alert Feed */}
        <section className="charts-row">
          <div className="card">
            <div className="card-header">
              <span className="card-title">Top risky databases</span>
              <Link className="card-link" to="/databases">View all →</Link>
            </div>
            <div className="card-body no-pad">
              <RiskyDatabases databases={riskyDbs} />
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Live alert feed</span>
              <Link className="card-link" to="/alerts">Triage →</Link>
            </div>
            <div className="card-body">
              <AlertFeed alerts={recentAlerts} />
            </div>
          </div>
        </section>

        {/* Financial Impact Row */}
        <section className="kpi-grid">
          <KpiCard
            icon="⚡" iconBg="var(--danger-soft)" iconColor="var(--danger)"
            label="Breach Exposure"
            value={formatCurrency((kpis?.databases?.total ?? 1) * 22000 * (fleetRisk / 100 + 0.5))}
            detail="estimated if top-risk DB breached"
            detailType="down"
          />
          <KpiCard
            icon="⚖" iconBg="var(--amber-soft)" iconColor="var(--amber)"
            label="Compliance Fines Risk"
            value={formatCurrency(compliance.filter(c => c.score < 90).length * 400000)}
            detail={`${compliance.filter(c => c.score < 90).length} frameworks below 90%`}
          />
          <KpiCard
            icon="⊘" iconBg="var(--green-soft)" iconColor="var(--green)"
            label="SIEM Cost Saved"
            value={formatCurrency(Math.round((kpis?.eventsToday ?? 0) * 0.00033))}
            detail="filtered low-value events"
            detailType="up"
          />
          <KpiCard
            icon="◈" iconBg="var(--info-soft)" iconColor="var(--info)"
            label="Monthly Platform Cost"
            value={formatCurrency((kpis?.databases?.total ?? 0) * 100 + (kpis?.agents?.total ?? 0) * 50)}
            detail={`${kpis?.databases?.total ?? 0} DBs · ${kpis?.agents?.total ?? 0} agents`}
          />
        </section>

        {/* Bottom Row — 3 columns */}
        <section className="charts-row three">
          <div className="card">
            <div className="card-header">
              <span className="card-title">Sensitive-data access · 7 days</span>
            </div>
            <div className="card-body">
              <SensitiveAccessChart data={sensitiveDaily} />
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Compliance posture</span>
            </div>
            <div className="card-body">
              <CompliancePosture data={compliance} />
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Capture coverage by region</span>
            </div>
            <div className="card-body">
              <CoverageDonut data={coverage} />
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
