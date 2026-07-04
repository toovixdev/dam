import { useState, useEffect } from 'react';
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
const GATEWAYS = [
  { id: 'Stripe', desc: 'Global — cards, ACH, SEPA, wire. 135+ currencies.', regions: 'US, EU, UK, CA, AU', fee: '2.9% + $0.30', currency: 'USD' },
  { id: 'Razorpay', desc: 'India — UPI, net banking, cards, wallets.', regions: 'India', fee: '2% domestic', currency: 'INR' },
  { id: 'PayU', desc: 'India — UPI, cards, net banking, EMI.', regions: 'India', fee: '2% domestic', currency: 'INR' },
  { id: 'PayPal', desc: 'Global — PayPal balance, cards, bank. 200+ markets.', regions: '200+ countries', fee: '2.9% + fixed', currency: 'USD' },
  { id: 'Adyen', desc: 'Enterprise — global acquiring, 250+ methods.', regions: 'Global', fee: 'Custom', currency: 'USD' },
];

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
  const { data, loading, error, refetch } = useApiData('/billing');
  const { data: payCfg } = useApiData('/billing/payment-config', { poll: 0 });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [currency, setCurrency] = useState('USD');
  const [payOpen, setPayOpen] = useState(false);
  const [gwOpen, setGwOpen] = useState(false);
  const [gw, setGw] = useState('Stripe');
  const [selGw, setSelGw] = useState(null);
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

  const { plan, account, usage, currentInvoice, balance, paymentMethods, invoices } = data;
  const items = currentInvoice?.items || [];
  // Razorpay & PayU have real-UI buttons, so keep them out of the simulated list.
  const simMethods = paymentMethods.filter((m) => !['Razorpay', 'PayU'].includes(m.provider));

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

  // Simulated fallback (Stripe/PayPal, or any gateway with no live keys).
  const pay = async () => {
    setBusy(true);
    const res = await apiPost('/billing/pay', { reference: currentInvoice?.reference, gateway: gw });
    setBusy(false);
    if (res && res.ok) { toast(`Payment processed via ${res.data.gateway} · ${res.data.txn}`, 'ok'); setPayOpen(false); refetch(); }
    else toast('Payment failed', 'err');
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
  const connectGateway = async () => {
    if (!selGw) return;
    setBusy(true);
    const g = GATEWAYS.find((x) => x.id === selGw);
    const res = await apiPost('/billing/payment-methods', { provider: g.id, label: `${g.id} gateway`, currency: g.currency, role: 'backup' });
    setBusy(false);
    if (res && res.ok) { toast(`${g.id} connected — billing in ${g.currency}`, 'ok'); setGwOpen(false); setSelGw(null); refetch(); }
    else toast('Could not connect gateway', 'err');
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
        <button className="btn-primary" onClick={() => { setGw(simMethods[0]?.provider || 'Stripe'); setPayOpen(true); }}>⚑ Make a payment</button>
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
          <div className="card-header"><span className="card-title">Payment methods</span><button className="card-link" onClick={() => setGwOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>+ Connect</button></div>
          <div className="card-body">
            {paymentMethods.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 18, width: 32, textAlign: 'center' }}>⚑</span>
                <div style={{ flex: 1 }}><b style={{ fontSize: 13 }}>{m.provider}</b><div className="muted" style={{ fontSize: 12 }}>{m.role === 'primary' ? 'Primary' : 'Backup'} · {m.label}</div></div>
                <span className={`badge ${m.role === 'primary' ? 'status-green' : ''} dot`} style={{ fontSize: 10 }}>{m.role === 'primary' ? 'Connected' : 'Backup'}</span>
              </div>
            ))}
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
              <b>Payment terms:</b> {account.terms} · Auto-pay {account.autopay ? 'enabled' : 'off'} · invoices to {account.email}<br />
              <b>No card data stored</b> — all payment info is held by the gateway (PCI DSS Level 1).
            </div>
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

        {/* Live gateways (real checkout UI) */}
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 8 }}>Pay now</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {payCfg?.razorpay?.available && (
            <button className="btn-primary" disabled={busy || !currentInvoice} onClick={payWithRazorpay} style={{ justifyContent: 'space-between', background: '#0c2451' }}>
              <span>Pay with <b>Razorpay</b>{payCfg.razorpay.mode === 'demo' ? <span style={{ fontWeight: 400, opacity: .8 }}> · test mode</span> : ''}</span>
              <span style={{ fontSize: 12, opacity: .85 }}>UPI · Cards · Net Banking</span>
            </button>
          )}
          {payCfg?.payu?.available && (
            <button className="btn-primary" disabled={busy || !currentInvoice} onClick={payWithPayU} style={{ justifyContent: 'space-between', background: '#01bd9b' }}>
              <span>Pay with <b>PayU</b>{payCfg.payu.source === 'demo' ? <span style={{ fontWeight: 400, opacity: .8 }}> · test mode</span> : ''}</span>
              <span style={{ fontSize: 12, opacity: .85 }}>UPI · Cards · EMI</span>
            </button>
          )}
        </div>
        {payCfg?.payu?.source === 'demo' && (
          <div style={{ background: 'var(--info-soft)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            PayU is in <b>test mode</b> (public sandbox credentials — opens the real PayU hosted page on test.payu.in). Add your own merchant key + salt in <b>Settings → Payments</b> to go live.
          </div>
        )}
        {payCfg?.razorpay?.mode === 'demo' && (
          <div style={{ background: 'var(--info-soft)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Razorpay is in <b>test mode</b> (using a demo key — opens the real Razorpay UI, use test card <b>4111 1111 1111 1111</b>). Add your own keys in <b>Settings → Payments</b> to go live.
          </div>
        )}

        {/* Simulated fallback for other (non-real-UI) gateways like Stripe/PayPal */}
        {simMethods.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 8 }}>Other methods (simulated — no real checkout)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {simMethods.map((m) => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, border: `1.5px solid ${gw === m.provider ? 'var(--primary)' : 'var(--line)'}`, background: gw === m.provider ? 'var(--primary-soft)' : 'var(--surface-2)' }}>
                  <input type="radio" name="gw" checked={gw === m.provider} onChange={() => setGw(m.provider)} />
                  <div><b>{m.provider}</b> ({m.role})<div className="muted" style={{ fontSize: 12 }}>{m.label}</div></div>
                </label>
              ))}
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={() => setPayOpen(false)}>Cancel</button>
          {simMethods.length > 0 && (
            <button className="btn-secondary" disabled={busy || !currentInvoice} onClick={pay}>{busy ? 'Processing…' : `Simulate via ${gw}`}</button>
          )}
        </div>
      </Modal>

      {/* Connect gateway */}
      <Modal open={gwOpen} onClose={() => { setGwOpen(false); setSelGw(null); }} title="Connect payment gateway" width={560}>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 0, lineHeight: 1.5 }}>Connect a gateway to process payments. TooVix stores no payment credentials — all card/bank data is held by the gateway (PCI DSS Level 1).</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
          {GATEWAYS.map((g) => (
            <div key={g.id} onClick={() => setSelGw(g.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${selGw === g.id ? 'var(--primary)' : 'var(--line)'}`, background: selGw === g.id ? 'var(--primary-soft)' : 'var(--surface-2)' }}>
              <div style={{ flex: 1 }}><b style={{ fontSize: 13 }}>{g.id}</b><div className="muted" style={{ fontSize: 12 }}>{g.desc}</div></div>
              <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--muted)', minWidth: 90 }}><div>{g.regions.split(',')[0]}</div><div>{g.fee}</div></div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <button className="btn-secondary" onClick={() => { setGwOpen(false); setSelGw(null); }}>Cancel</button>
          <button className="btn-primary" disabled={busy || !selGw} onClick={connectGateway}>{busy ? 'Connecting…' : 'Connect gateway'}</button>
        </div>
      </Modal>
    </Layout>
  );
}
