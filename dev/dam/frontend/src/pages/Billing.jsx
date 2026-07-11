import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import useApiData from '../hooks/useApiData';
import { apiPost, getToken } from '../api/client';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';

// Lazily load the Razorpay Checkout widget once, on demand.
let _rzpPromise = null;
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(true);
  if (_rzpPromise) return _rzpPromise;
  _rzpPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
  return _rzpPromise;
}

const RATES = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.5, CAD: 1.36, SGD: 1.34, JPY: 157.2 };
const SYM = { USD: '$', EUR: '€', GBP: '£', INR: '₹', CAD: 'C$', SGD: 'S$', JPY: '¥' };
function fmtBytes(gb) {
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(gb * 1024).toFixed(1)} MB`;
}
function fmtEvents(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
function barColor(pct) { return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--amber)' : 'var(--green)'; }

function UsageBar({ label, used, limitText, pct, note, color }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}><span className="muted">{label}</span><b>{used}{limitText ? ` / ${limitText}` : ''}</b></div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden', marginTop: 6 }}>
        <div style={{ height: '100%', borderRadius: 4, width: `${pct}%`, background: color || barColor(pct), transition: 'width .3s' }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{note}</div>
    </div>
  );
}

export default function Billing() {
  const navigate = useNavigate();
  const goToPayments = () => navigate('/settings?tab=pay'); // real credentials live in Settings → Payments
  const { data, loading, error, refetch } = useApiData('/billing');
  const { data: payCfg } = useApiData('/billing/payment-config', { poll: 0 });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [currency, setCurrency] = useState('USD');
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Handle the redirect back from PayU's hosted page (?payu=success|failed|invalid).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('payu');
    if (!r) return;
    if (r === 'success') { toast('✓ Payment successful via PayU', 'ok'); refetch(); }
    else if (r === 'invalid') toast('PayU response failed verification', 'err');
    else toast('PayU payment was not completed', 'err');
    window.history.replaceState({}, '', window.location.pathname);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };
  const conv = (usd) => usd * (RATES[currency] || 1);
  const money = (usd) => `${SYM[currency] || '$'}${conv(usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (loading) return <Layout activePage="billing"><div className="loading-screen"><div className="loading-spinner" /><p>Loading billing…</p></div></Layout>;
  if (error || !data) return <Layout activePage="billing"><div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error loading billing: {error || 'no data'}</div></Layout>;

  const { plan, account, usage, currentInvoice, balance, invoices } = data;
  const items = currentInvoice?.items || [];
  // A "payment method" = a gateway THIS workspace configured with real credentials
  // in Settings → Payments (payment-config.configured === true). No credential-less rows.
  const gateways = [
    payCfg?.razorpay?.configured && { key: 'razorpay', name: 'Razorpay', detail: `India · UPI, cards, net banking · ${payCfg.razorpay.mode === 'live' ? 'Live' : 'Test'} keys` },
    payCfg?.payu?.configured && { key: 'payu', name: 'PayU', detail: `India · UPI, cards, EMI · ${payCfg.payu.mode === 'live' ? 'Live' : 'Test'} keys` },
  ].filter(Boolean);
  const hasPaymentMethod = gateways.length > 0;

  // Download a single invoice as a PDF (auth-gated, so fetch as a blob then save).
  const downloadInvoice = async (ref) => {
    try {
      const res = await fetch(`/api/billing/invoices/${ref}/pdf?currency=${currency}&rate=${RATES[currency] || 1}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return toast('Could not generate invoice PDF', 'err');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${ref}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast(`Downloaded ${ref}.pdf`, 'ok');
    } catch { toast('Could not download invoice', 'err'); }
  };

  // Razorpay — open the in-page Checkout widget. Live mode uses a server order +
  // signature verification; demo mode (no own key) opens the same UI with the
  // public test key and confirms on success (test cards only).
  const payWithRazorpay = async () => {
    setBusy(true);
    const ord = await apiPost('/billing/razorpay/order', { reference: currentInvoice?.reference });
    if (!ord?.ok) { setBusy(false); return toast(ord?.data?.error || 'Could not start Razorpay', 'err'); }
    const o = ord.data;
    const loaded = await loadRazorpay();
    setBusy(false);
    if (!loaded) return toast('Could not load Razorpay checkout', 'err');
    const opts = {
      key: o.keyId, amount: o.amount, currency: o.currency,
      name: 'TooVix DAM', description: `Invoice ${o.reference}${o.mode === 'demo' ? ' (test)' : ''}`,
      prefill: { email: o.email }, theme: { color: '#6366f1' },
      handler: async (r) => {
        const endpoint = o.orderId ? '/billing/razorpay/verify' : '/billing/razorpay/demo-confirm';
        const payload = o.orderId
          ? { razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature, reference: o.reference }
          : { razorpay_payment_id: r.razorpay_payment_id, reference: o.reference };
        const v = await apiPost(endpoint, payload);
        if (v?.ok && v.data?.ok) { toast(`✓ Paid via Razorpay · ${v.data.txn}`, 'ok'); setPayOpen(false); refetch(); }
        else toast(v?.data?.error || 'Verification failed', 'err');
      },
      modal: { ondismiss: () => toast('Payment cancelled', 'err') },
      // Surface UPI as a prioritised block (then show the rest). UPI must also be
      // enabled on the Razorpay account; in test mode pay with VPA success@razorpay.
      config: {
        display: {
          blocks: {
            upi: { name: 'Pay using UPI', instruments: [{ method: 'upi' }] },
          },
          sequence: ['block.upi'],
          preferences: { show_default_blocks: true },
        },
      },
    };
    if (o.orderId) opts.order_id = o.orderId; // omit in demo (no-order checkout)
    const rzp = new window.Razorpay(opts);
    rzp.on('payment.failed', (resp) => toast(resp?.error?.description || 'Payment failed', 'err'));
    rzp.open();
  };

  // PayU — get the signed params, then auto-submit a form to PayU's hosted page.
  const payWithPayU = async () => {
    setBusy(true);
    const init = await apiPost('/billing/payu/initiate', { reference: currentInvoice?.reference });
    setBusy(false);
    if (!init?.ok) return toast(init?.data?.error || 'Could not start PayU', 'err');
    const { action, params } = init.data;
    const form = document.createElement('form');
    form.method = 'POST'; form.action = action;
    Object.entries(params).forEach(([k, v]) => {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i);
    });
    document.body.appendChild(form);
    form.submit(); // leaves the app → returns to /billing?payu=... via the callback
  };
  const downloadAll = () => {
    exportCsv('toovix-invoices.csv', ['Reference', 'Period', 'Amount (USD)', 'Status', 'Due'], invoices.map((i) => [i.reference, i.period, Number(i.amount).toFixed(2), i.status, (i.due_date || '').slice(0, 10)]));
    toast(`Exported ${invoices.length} invoices`, 'ok');
  };

  return (
    <Layout activePage="billing" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Billing & Usage" meta={[`${plan.name} plan`, `billing cycle: ${plan.cycle}`]}>
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ minWidth: 110 }}>
          {Object.keys(RATES).map((c) => <option key={c} value={c}>{c} ({SYM[c]})</option>)}
        </select>
        <button className="btn-secondary" onClick={downloadAll}>⤓ Download all invoices</button>
        {hasPaymentMethod && balance.outstanding > 0 && (
          <button
            className="btn-primary"
            onClick={() => setPayOpen(true)}
          >⚑ Make a payment</button>
        )}
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="$" iconBg="var(--green-soft)" iconColor="var(--green)" label="Current period" value={money(currentInvoice?.total || 0)} detail={`${currentInvoice?.period || '—'} · due ${(account.nextDue || '').slice(0, 10)}`} />
        <KpiCard icon="▦" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Databases" value={`${usage.databases.used} / ${usage.databases.limit}`} detail={`${usage.databases.pct}% of limit`} detailType="up" />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)" label="Events/day" value={`${fmtEvents(usage.eventsPerDay.used)} / ${fmtEvents(usage.eventsPerDay.limit)}`} detail={`${usage.eventsPerDay.pct}% of limit`} detailType="up" />
        <KpiCard icon="▤" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Hot storage" value={`${fmtBytes(usage.hotStorageGB.used)} / ${fmtBytes(usage.hotStorageGB.limit)}`} detail={`${usage.hotStorageGB.pct}% of limit`} />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Usage this period</span><span className="card-sub">{currentInvoice?.period}</span></div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
            <UsageBar label="Databases" used={usage.databases.used} limitText={usage.databases.limit} pct={usage.databases.pct} note={`${usage.databases.limit - usage.databases.used} remaining`} />
            <UsageBar label="Events/day (avg)" used={fmtEvents(usage.eventsPerDay.used)} limitText={fmtEvents(usage.eventsPerDay.limit)} pct={usage.eventsPerDay.pct} note={usage.eventsPerDay.pct >= 100 ? 'overage applies' : 'no overage this period'} />
            <UsageBar label="Hot storage" used={fmtBytes(usage.hotStorageGB.used)} limitText={fmtBytes(usage.hotStorageGB.limit)} pct={usage.hotStorageGB.pct} note={`${fmtBytes(Math.max(0, usage.hotStorageGB.limit - usage.hotStorageGB.used))} remaining`} />
            <UsageBar label="Cold storage (WORM)" used={fmtBytes(usage.coldStorageGB.used)} pct={Math.min(100, usage.coldStorageGB.used)} note={`${usage.coldStorageGB.objects} objects · $0.01/GB/mo`} color="var(--info)" />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Current invoice breakdown</span><span className="card-sub">{currentInvoice?.reference} · {currentInvoice?.period}</span></div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Line item</th><th>Description</th><th className="num">Quantity</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td><b>{it.item}</b></td>
                  <td className="muted">{it.desc}</td>
                  <td className="num">{it.qty}</td>
                  <td className="num">{typeof it.rate === 'number' ? money(it.rate) : it.rate}</td>
                  <td className="num"><b>{money(Number(it.amount))}</b></td>
                </tr>
              ))}
              <tr style={{ borderTop: '2px solid var(--line)', fontSize: 15 }}>
                <td colSpan={4} style={{ textAlign: 'right' }}><b>Total</b></td>
                <td className="num"><b style={{ color: 'var(--primary)', fontSize: 16 }}>{money(currentInvoice?.total || 0)}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Payment methods</span><button className="card-link" onClick={goToPayments} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>⚙ Manage in Settings</button></div>
          <div className="card-body">
            {!hasPaymentMethod ? (
              <div style={{ textAlign: 'center', padding: '20px 16px', background: 'var(--surface-2)', border: '1px dashed var(--line)', borderRadius: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>💳</div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>No payment method configured</div>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 auto 12px', maxWidth: 380, lineHeight: 1.6, textAlign: 'left' }}>
                  A payment method is a gateway your workspace connects with its own API credentials. To set one up:
                </p>
                <ol style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 auto 14px', maxWidth: 380, textAlign: 'left', paddingLeft: 18, lineHeight: 1.7 }}>
                  <li>Open <b>Settings → Payments</b>.</li>
                  <li>Pick a gateway — <b>Razorpay</b> or <b>PayU</b>.</li>
                  <li>Enter its <b>API key &amp; secret</b> (from the gateway dashboard) and save.</li>
                </ol>
                <button className="btn-primary" onClick={goToPayments}>Go to Settings → Payments</button>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12 }}><b>No card data stored</b> — credentials stay server-side; card/bank data stays with the gateway (PCI DSS Level 1).</div>
              </div>
            ) : (
              <>
                {gateways.map((g) => (
                  <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 10 }}>
                    <span style={{ fontSize: 18, width: 32, textAlign: 'center' }}>⚑</span>
                    <div style={{ flex: 1 }}><b style={{ fontSize: 13 }}>{g.name}</b><div className="muted" style={{ fontSize: 12 }}>{g.detail}</div></div>
                    <span className="badge status-green dot" style={{ fontSize: 10 }}>Configured</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <b>Payment terms:</b> {account.terms} · Auto-pay {account.autopay ? 'enabled' : 'off'} · invoices to {account.email}<br />
                  Manage credentials in <button className="card-link" onClick={goToPayments} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary)' }}>Settings → Payments</button>. <b>No card data stored.</b>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Account balance</span></div>
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
              <div>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Outstanding</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: balance.outstanding > 0 ? 'var(--amber)' : 'var(--green)' }}>{money(balance.outstanding)}</div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Next due</div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{(account.nextDue || '').slice(0, 10)}</div>
                <div className="muted" style={{ fontSize: 12 }}>{money(currentInvoice?.total || 0)} (estimated)</div>
              </div>
            </div>
            <div style={{ background: balance.outstanding > 0 ? 'var(--amber-soft)' : 'var(--green-soft)', borderRadius: 8, padding: '10px 14px', fontSize: 12.5 }}>
              {balance.outstanding > 0
                ? <><b style={{ color: 'var(--amber)' }}>Payment due</b> — {money(balance.outstanding)} outstanding. Auto-pay will process on {(account.nextDue || '').slice(0, 10)}.</>
                : <><b style={{ color: 'var(--green)' }}>✓ All payments current</b> — no overdue invoices.</>}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Invoice history</span><span className="card-sub">{invoices.length} invoices</span></div>
        <div className="card-body no-pad">
          {invoices.map((inv) => (
            <div key={inv.reference} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
              <span className="muted" style={{ minWidth: 90 }}>{inv.period}</span>
              <b className="mono" style={{ minWidth: 130, fontSize: 12 }}>{inv.reference}</b>
              <span style={{ flex: 1 }} className="muted">Monthly subscription + add-ons</span>
              <b style={{ minWidth: 90, textAlign: 'right' }}>{money(Number(inv.amount))}</b>
              <span className={`badge ${inv.status === 'paid' ? 'status-green' : 'sev-high'}`} style={{ minWidth: 56, textAlign: 'center' }}>{inv.status}</span>
              <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => downloadInvoice(inv.reference)}>⤓ PDF</button>
            </div>
          ))}
        </div>
      </div>

      {/* Make a payment */}
      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Make a payment" width={520}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>
          <span>Amount due · {currentInvoice?.reference}</span>
          <div style={{ textAlign: 'right' }}>
            <b style={{ fontSize: 16, color: 'var(--primary)' }}>{money(currentInvoice?.total || 0)}</b>
            {payCfg?.usdToInr && <div className="muted" style={{ fontSize: 11 }}>≈ ₹{((currentInvoice?.total || 0) * payCfg.usdToInr).toLocaleString('en-IN', { maximumFractionDigits: 2 })} charged</div>}
          </div>
        </div>

        {/* Your configured gateways (real checkout UI) */}
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 8 }}>Pay now</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {payCfg?.razorpay?.configured && (
            <button className="btn-primary" disabled={busy || !currentInvoice} onClick={payWithRazorpay} style={{ justifyContent: 'space-between', background: '#0c2451' }}>
              <span>Pay with <b>Razorpay</b></span>
              <span style={{ fontSize: 12, opacity: .85 }}>UPI · Cards · Net Banking</span>
            </button>
          )}
          {payCfg?.payu?.configured && (
            <button className="btn-primary" disabled={busy || !currentInvoice} onClick={payWithPayU} style={{ justifyContent: 'space-between', background: '#01bd9b' }}>
              <span>Pay with <b>PayU</b></span>
              <span style={{ fontSize: 12, opacity: .85 }}>UPI · Cards · EMI</span>
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={() => setPayOpen(false)}>Cancel</button>
        </div>
      </Modal>
    </Layout>
  );
}
