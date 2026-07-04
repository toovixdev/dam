import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';

// Generic "not built yet" screen so every sidebar entry stays navigable while
// the admin console is built out one screen at a time.
export default function Placeholder({ title }) {
  return (
    <Layout>
      <PageHeader title={title} meta={['Admin console', 'screen not built yet']} />
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🛠️</div>
          <h3 style={{ margin: '0 0 6px' }}>{title}</h3>
          <p className="muted" style={{ maxWidth: 420, margin: '0 auto' }}>
            This admin screen is on the roadmap. The Platform Dashboard is live and wired to the
            backend — more screens are coming next.
          </p>
        </div>
      </div>
    </Layout>
  );
}
