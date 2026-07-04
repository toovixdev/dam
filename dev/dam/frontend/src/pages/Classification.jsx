import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import DataTable from '../components/shared/DataTable';
import { TagBadge, StatusBadge } from '../components/shared/Badge';
import useApiData from '../hooks/useApiData';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';
import { apiPost } from '../api/client';

const DEMO_RULES = [
  { id: 1, name: 'SSN Detector', pattern: '\\d{3}-\\d{2}-\\d{4}', type: 'regex', category: 'PII', status: 'enabled', hits: 14320 },
  { id: 2, name: 'Credit Card (Luhn)', pattern: 'Luhn check on 13-19 digit numbers', type: 'algorithm', category: 'PCI', status: 'enabled', hits: 8741 },
  { id: 3, name: 'Email Address', pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+', type: 'regex', category: 'PII', status: 'enabled', hits: 45210 },
  { id: 4, name: 'Aadhaar Number', pattern: '\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}', type: 'regex', category: 'PII', status: 'enabled', hits: 2103 },
  { id: 5, name: 'Phone Number (IN)', pattern: '(\\+91|0)?[6-9]\\d{9}', type: 'regex', category: 'PII', status: 'enabled', hits: 11540 },
  { id: 6, name: 'Date of Birth', pattern: 'NER date-of-birth model', type: 'ml', category: 'PII', status: 'enabled', hits: 9280 },
  { id: 7, name: 'Medical Record ID', pattern: 'MRN-\\d{6,10}', type: 'regex', category: 'PHI', status: 'enabled', hits: 3211 },
  { id: 8, name: 'IP Address', pattern: '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}', type: 'regex', category: 'PII', status: 'disabled', hits: 0 },
];

const DEMO_CUSTOM = [
  { id: 1, name: 'Employee ID', pattern: 'EMP-[A-Z]{2}\\d{5}', type: 'regex', category: 'Internal', status: 'enabled', hits: 1820 },
  { id: 2, name: 'Account Number', pattern: 'ACC\\d{10}', type: 'regex', category: 'Financial', status: 'enabled', hits: 5410 },
  { id: 3, name: 'Policy Number', pattern: 'POL-\\d{8}', type: 'regex', category: 'Insurance', status: 'monitor', hits: 310 },
];

const DEMO_COVERAGE = [
  { id: 1, database: 'finance-prod-01', total_columns: 342, classified: 298, coverage_pct: 87, last_scan: '2025-06-26T14:00:00Z' },
  { id: 2, database: 'hr-prod', total_columns: 186, classified: 186, coverage_pct: 100, last_scan: '2025-06-26T14:00:00Z' },
  { id: 3, database: 'crm-replica', total_columns: 528, classified: 412, coverage_pct: 78, last_scan: '2025-06-25T22:00:00Z' },
  { id: 4, database: 'analytics-dw', total_columns: 1024, classified: 890, coverage_pct: 87, last_scan: '2025-06-26T08:00:00Z' },
  { id: 5, database: 'customer-db', total_columns: 210, classified: 195, coverage_pct: 93, last_scan: '2025-06-26T12:00:00Z' },
];

export default function Classification() {
  const { data: inventoryData, loading, refetch } = useApiData('/classification/columns');
  const { data: objectsData, refetch: refetchObjects } = useApiData('/classification/objects');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('rules');

  const handleRefresh = () => {
    refetch();
    refetchObjects();
    setLastRefresh(new Date());
  };

  const inventory = Array.isArray(inventoryData) ? inventoryData : [];
  const objects = Array.isArray(objectsData) ? objectsData : [];

  const runScan = async () => {
    const res = await apiPost('/classification/scan');
    if (res && res.ok) {
      toast('Scan requested — introspecting & classifying live schemas…', 'ok');
      setTimeout(() => { refetch(); refetchObjects(); setLastRefresh(new Date()); }, 13000);
    } else { toast('Could not start scan', 'err'); }
  };

  const onExport = () => {
    if (activeTab === 'objects') {
      exportCsv('toovix-classified-objects.csv',
        ['Database', 'Schema', 'Object', 'Type', 'Columns', 'Rows', 'Sensitivity', 'Owner'],
        objects.map((o) => [o.database_name, o.schema_name, o.object_name, o.object_type, o.column_count, o.row_count, o.sensitivity, o.owner]));
      toast(`Exported ${objects.length} objects`, 'ok');
    } else {
      exportCsv('toovix-classified-columns.csv',
        ['Database', 'Schema', 'Table', 'Column', 'Classification', 'Sensitivity', 'Detector', 'Masked'],
        inventory.map((c) => [c.database_name, c.schema_name, c.table_name, c.column_name, c.tag, c.sensitivity, c.detector, c.is_masked]));
      toast(`Exported ${inventory.length} columns`, 'ok');
    }
  };
  const totalClassified = inventory.length || DEMO_COVERAGE.reduce((s, d) => s + d.classified, 0);
  const sensitiveCount = inventory.filter(c => c.sensitivity === 'high' || c.sensitivity === 'critical').length || 142;
  const detectorsActive = DEMO_RULES.filter(r => r.status === 'enabled').length;
  const avgCoverage = DEMO_COVERAGE.length > 0 ? Math.round(DEMO_COVERAGE.reduce((s, d) => s + d.coverage_pct, 0) / DEMO_COVERAGE.length) : 0;

  const tabs = [
    { id: 'rules', label: 'Detection Rules', count: DEMO_RULES.length },
    { id: 'objects', label: 'Objects', count: objects.length || '-' },
    { id: 'inventory', label: 'Columns', count: inventory.length || '-' },
    { id: 'custom', label: 'Custom Rules', count: DEMO_CUSTOM.length },
    { id: 'coverage', label: 'Coverage', count: DEMO_COVERAGE.length },
  ];

  const objectColumns = [
    { key: 'database_name', label: 'Database' },
    { key: 'schema_name', label: 'Schema' },
    { key: 'object_name', label: 'Object' },
    { key: 'object_type', label: 'Type', render: (v) => <span className="badge">{v}</span> },
    { key: 'column_count', label: 'Columns', align: 'right' },
    { key: 'row_count', label: 'Rows', align: 'right', render: (v) => (v || 0).toLocaleString() },
    { key: 'sensitivity', label: 'Sensitivity', render: (v) => {
      const colors = { critical: 'var(--danger)', high: 'var(--amber)', medium: 'var(--info)', low: 'var(--green)' };
      return <span style={{ fontWeight: 600, color: colors[v] || 'var(--muted)' }}>{v || '-'}</span>;
    }},
    { key: 'owner', label: 'Owner' },
  ];

  const ruleColumns = [
    { key: 'name', label: 'Rule Name' },
    { key: 'type', label: 'Type', render: (v) => <span style={{ textTransform: 'capitalize' }}>{v}</span> },
    { key: 'category', label: 'Category', render: (v) => <TagBadge tag={v?.toLowerCase() || ''} /> },
    { key: 'pattern', label: 'Pattern', render: (v) => <code style={{ fontSize: 11 }}>{v}</code> },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v} /> },
    { key: 'hits', label: 'Hits', align: 'right', render: (v) => (v || 0).toLocaleString() },
  ];

  const inventoryColumns = [
    { key: 'database_name', label: 'Database' },
    { key: 'schema_name', label: 'Schema' },
    { key: 'table_name', label: 'Table' },
    { key: 'column_name', label: 'Column' },
    { key: 'tag', label: 'Classification', render: (v) => <TagBadge tag={v || 'unknown'} /> },
    { key: 'sensitivity', label: 'Sensitivity', render: (v) => {
      const colors = { critical: 'var(--danger)', high: 'var(--amber)', medium: 'var(--info)', low: 'var(--green)' };
      return <span style={{ fontWeight: 600, color: colors[v] || 'var(--muted)' }}>{v || '-'}</span>;
    }},
    { key: 'detector', label: 'Detector' },
  ];

  const coverageColumns = [
    { key: 'database', label: 'Database' },
    { key: 'total_columns', label: 'Total Columns', align: 'right' },
    { key: 'classified', label: 'Classified', align: 'right' },
    { key: 'coverage_pct', label: 'Coverage', align: 'right', render: (v) => {
      const color = v >= 90 ? 'var(--green)' : v >= 70 ? 'var(--amber)' : 'var(--danger)';
      return <span style={{ fontWeight: 600, color }}>{v}%</span>;
    }},
    { key: 'last_scan', label: 'Last Scan', render: (v) => v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '-' },
  ];

  if (loading && activeTab === 'inventory') {
    return (
      <Layout activePage="classification">
        <div className="loading-screen"><div className="loading-spinner" /><p>Loading classification data...</p></div>
      </Layout>
    );
  }

  return (
    <Layout activePage="classification" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader
        title="Data Classification"
        meta={[`${totalClassified} classified objects`, `${detectorsActive} detectors active`]}
      >
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
        <button className="btn-secondary" onClick={onExport}>⤓ Export</button>
        <button className="btn-primary" onClick={runScan}>⟳ Run Scan</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◧" label="Classified Objects" value={totalClassified} detail="columns and fields" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Sensitive Columns" value={sensitiveCount} detail="high/critical sensitivity" detailType="down" />
        <KpiCard icon="◎" iconBg="var(--green-soft)" iconColor="var(--green)" label="Detectors Active" value={detectorsActive} detail="rules running" detailType="up" />
        <KpiCard icon="◉" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg Coverage" value={`${avgCoverage}%`} detail="across all databases" detailType={avgCoverage >= 85 ? 'up' : 'down'} />
      </section>

      <TabNav tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'rules' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Detection Rules</span>
            <span className="card-sub">{DEMO_RULES.length} rules</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={ruleColumns} data={DEMO_RULES} emptyMessage="No detection rules configured" />
          </div>
        </div>
      )}

      {activeTab === 'objects' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Classified Objects</span>
            <span className="card-sub">{objects.length} tables / collections</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={objectColumns} data={objects} emptyMessage="No classified objects found. Run a scan to discover sensitive data." />
          </div>
        </div>
      )}

      {activeTab === 'inventory' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Sensitive Data Inventory</span>
            <span className="card-sub">{inventory.length} columns</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={inventoryColumns} data={inventory} emptyMessage="No classified columns found. Run a scan to discover sensitive data." />
          </div>
        </div>
      )}

      {activeTab === 'custom' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Custom Rules</span>
            <span className="card-sub">{DEMO_CUSTOM.length} rules</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={ruleColumns} data={DEMO_CUSTOM} emptyMessage="No custom rules defined" />
          </div>
        </div>
      )}

      {activeTab === 'coverage' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Classification Coverage by Database</span>
            <span className="card-sub">{DEMO_COVERAGE.length} databases</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={coverageColumns} data={DEMO_COVERAGE} emptyMessage="No coverage data available" />
          </div>
        </div>
      )}
    </Layout>
  );
}
