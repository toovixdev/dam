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

export default function Classification() {
  const { data: inventoryData, loading, refetch } = useApiData('/classification/columns');
  const { data: objectsData, refetch: refetchObjects } = useApiData('/classification/objects');
  const { data: detectorsData, refetch: refetchDetectors } = useApiData('/classification/detectors');
  const { data: coverageData, refetch: refetchCoverage } = useApiData('/classification/coverage');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('objects');

  const handleRefresh = () => {
    refetch();
    refetchObjects();
    refetchDetectors();
    refetchCoverage();
    setLastRefresh(new Date());
  };

  const inventory = Array.isArray(inventoryData) ? inventoryData : [];
  const objects = Array.isArray(objectsData) ? objectsData : [];
  const detectors = Array.isArray(detectorsData?.detectors) ? detectorsData.detectors : [];
  const coverage = Array.isArray(coverageData?.databases) ? coverageData.databases : [];

  const runScan = async () => {
    const res = await apiPost('/classification/scan');
    if (res && res.ok) {
      toast('Scan requested — the agent will introspect & classify on its next poll (~15s)…', 'ok');
      // The agent/collector picks up the request on its poll (~12s) then scans; refresh a
      // couple of times so the new results land without a manual reload.
      setTimeout(handleRefresh, 16000);
      setTimeout(handleRefresh, 28000);
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
  const classifiedObjects = objects.length;
  const sensitiveCount = inventory.length;                       // every classified column is a PII/PCI hit
  const detectorsActive = detectorsData?.active ?? 0;            // real: detectors that ran on the last scan
  const avgCoverage = coverageData?.coverage_pct ?? 0;           // real: % of databases classification-scanned

  const tabs = [
    { id: 'objects', label: 'Objects', count: objects.length || '-' },
    { id: 'inventory', label: 'Columns', count: inventory.length || '-' },
    { id: 'rules', label: 'Detection Rules', count: detectors.length || '-' },
    { id: 'coverage', label: 'Coverage', count: coverage.length || '-' },
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
    { key: 'objects', label: 'Objects', align: 'right', render: (v) => (v || 0).toLocaleString() },
    { key: 'total_columns', label: 'Columns Scanned', align: 'right', render: (v) => (v || 0).toLocaleString() },
    { key: 'sensitive', label: 'Sensitive', align: 'right', render: (v) => <span style={{ fontWeight: 600, color: v > 0 ? 'var(--amber)' : 'var(--muted)' }}>{(v || 0).toLocaleString()}</span> },
    { key: 'coverage_pct', label: 'Coverage', align: 'right', render: (v, row) => {
      const color = v >= 90 ? 'var(--green)' : v >= 70 ? 'var(--amber)' : 'var(--danger)';
      return <span style={{ fontWeight: 600, color }}>{row.scanned ? `${v}%` : 'not scanned'}</span>;
    }},
    { key: 'last_scan', label: 'Last Scan', render: (v) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—' },
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
        meta={[`${classifiedObjects} classified objects`, `${detectorsActive} detectors active`]}
      >
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
        <button className="btn-secondary" onClick={onExport}>⤓ Export</button>
        <button className="btn-primary" onClick={runScan}>⟳ Run Scan</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◧" label="Classified Objects" value={classifiedObjects} detail="tables / collections with sensitive data" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Sensitive Columns" value={sensitiveCount} detail="PII/PCI columns found" detailType={sensitiveCount > 0 ? 'down' : undefined} />
        <KpiCard icon="◎" iconBg="var(--green-soft)" iconColor="var(--green)" label="Detectors Active" value={detectorsActive} detail={`of ${detectors.length} in catalog`} detailType={detectorsActive > 0 ? 'up' : undefined} />
        <KpiCard icon="◉" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg Coverage" value={`${avgCoverage}%`} detail={`${coverageData?.scanned ?? 0}/${coverageData?.total ?? 0} databases scanned`} detailType={avgCoverage >= 85 ? 'up' : 'down'} />
      </section>

      <TabNav tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'rules' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Detection Rules</span>
            <span className="card-sub">{detectors.length} detectors · hits from live scans</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={ruleColumns} data={detectors} emptyMessage="Detector catalog unavailable" />
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

      {activeTab === 'coverage' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Classification Coverage by Database</span>
            <span className="card-sub">{coverageData?.scanned ?? 0}/{coverageData?.total ?? 0} databases scanned</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={coverageColumns} data={coverage} emptyMessage="No databases registered yet. Register an instance and deploy an agent with classification enabled." />
          </div>
        </div>
      )}
    </Layout>
  );
}
