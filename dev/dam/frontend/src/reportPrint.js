// Renders a report into a standalone, print-optimized, branded document in a new window,
// then triggers the browser's print dialog (from which the user can "Save as PDF").
// Header shows the tenant's custom logo when one is set (Settings → branding); otherwise
// it falls back to the TooVix mark.

import { getBranding } from './branding';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function printReport(report, { tenantName = '', generatedBy = '' } = {}) {
  const brand = getBranding();
  const hasLogo = !!brand.logo;
  const companyName = brand.custom ? brand.name : 'TooVix DAM';
  const logoHtml = hasLogo
    ? `<img class="logo-img" src="${esc(brand.logo)}" alt="${esc(companyName)} logo" />`
    : `<span class="logo-mark">T</span>`;

  const genDate = new Date(report.generated_at || Date.now());
  const genStr = genDate.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const reportId = `${String(report.type || 'RPT').toUpperCase()}-${genDate.getTime().toString(36).toUpperCase()}`;
  const docTitle = `${companyName} - ${report.title} - ${genDate.toLocaleDateString('en-GB')}`;

  const kpis = (report.kpis || []).map((k) => `
    <div class="kpi">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value">${esc(k.value)}</div>
      ${k.sub ? `<div class="kpi-sub">${esc(k.sub)}</div>` : ''}
    </div>`).join('');

  const tables = (report.tables || []).map((t) => `
    <section class="tbl-block">
      <h3>${esc(t.title)} <span class="rows">${t.rows.length} row${t.rows.length === 1 ? '' : 's'}</span></h3>
      ${t.rows.length === 0 ? `<div class="empty">No data for this period.</div>` : `
      <table>
        <thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`}
    </section>`).join('');

  const doc = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(docTitle)}</title>
<style>
  :root{--indigo:#4f46e5;--ink:#111827;--body:#374151;--muted:#6b7280;--line:#e5e7eb;--soft:#eef2ff;}
  *{box-sizing:border-box}
  @page{size:A4;margin:16mm 14mm 20mm;}
  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--body);font-size:12.5px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}
  .page{max-width:820px;margin:0 auto;padding:24px 26px 40px}

  /* Header */
  .rpt-header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:14px;border-bottom:3px solid var(--indigo)}
  .brand{display:flex;align-items:center;gap:12px}
  .logo-img{max-height:52px;max-width:200px;object-fit:contain;display:block}
  .logo-mark{width:46px;height:46px;border-radius:11px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:24px}
  .brand .co{font-size:17px;font-weight:800;color:var(--ink);line-height:1.15}
  .brand .co small{display:block;font-weight:500;color:var(--muted);font-size:11px}
  .hdr-right{text-align:right;font-size:10.5px;color:var(--muted)}
  .confidential{display:inline-block;border:1px solid #fca5a5;background:#fef2f2;color:#b91c1c;font-weight:800;letter-spacing:.08em;font-size:9.5px;padding:3px 8px;border-radius:5px;text-transform:uppercase}
  .hdr-right .rid{margin-top:6px;font-family:ui-monospace,Menlo,monospace}

  /* Title block */
  .title-block{margin:20px 0 18px}
  .title-block h1{font-size:24px;color:var(--ink);margin:0 0 10px;font-weight:800}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 22px;font-size:11.5px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:10px 0}
  .meta div span{display:block;color:var(--muted);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:1px}
  .meta div b{color:var(--ink);font-weight:600}

  .note{background:#fffbeb;border:1px solid #fde68a;color:#78350f;border-radius:8px;padding:10px 13px;font-size:11.5px;margin:16px 0}

  /* Section headings */
  h2.sec{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--indigo);margin:22px 0 10px;font-weight:800;border-bottom:1px solid var(--soft);padding-bottom:5px}

  /* KPI grid */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
  .kpi{border:1px solid var(--line);border-radius:9px;padding:11px 13px;background:#fafbff;break-inside:avoid}
  .kpi-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
  .kpi-value{font-size:22px;font-weight:800;color:var(--ink);margin-top:3px;line-height:1.1}
  .kpi-sub{font-size:10.5px;color:var(--muted);margin-top:2px}

  /* Tables */
  .tbl-block{margin-top:18px;break-inside:auto}
  .tbl-block h3{font-size:13px;color:var(--ink);margin:0 0 6px;font-weight:700;display:flex;align-items:baseline;gap:8px}
  .tbl-block h3 .rows{font-size:10px;color:var(--muted);font-weight:500}
  table{width:100%;border-collapse:collapse;font-size:11px}
  thead{display:table-header-group}
  th{background:#f3f4f6;color:var(--ink);text-align:left;font-weight:700;padding:7px 9px;border-bottom:2px solid var(--line);font-size:10px;text-transform:uppercase;letter-spacing:.03em}
  td{padding:6px 9px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--body)}
  tbody tr{break-inside:avoid}
  tbody tr:nth-child(even) td{background:#fafafa}
  .empty{color:var(--muted);font-style:italic;padding:10px 2px;font-size:11px}

  /* Footer (repeats each printed page via fixed positioning within @page margins) */
  .rpt-footer{position:fixed;bottom:6mm;left:14mm;right:14mm;display:flex;justify-content:space-between;font-size:9px;color:var(--muted);border-top:1px solid var(--line);padding-top:4px}

  /* Screen-only toolbar */
  .toolbar{position:fixed;top:14px;right:16px;display:flex;gap:8px;z-index:10}
  .toolbar button{font:600 13px/1 inherit;font-family:inherit;padding:9px 15px;border-radius:8px;border:1px solid var(--indigo);background:var(--indigo);color:#fff;cursor:pointer}
  .toolbar button.ghost{background:#fff;color:var(--indigo)}
  @media print{ .toolbar{display:none} }
</style></head>
<body>
  <div class="toolbar no-print">
    <button onclick="window.print()">🖨 Download / Print PDF</button>
    <button class="ghost" onclick="window.close()">Close</button>
  </div>

  <div class="page">
    <header class="rpt-header">
      <div class="brand">
        ${logoHtml}
        <div class="co">${esc(companyName)}${brand.custom ? '<small>Powered by TooVix DAM</small>' : '<small>Database Activity Monitoring</small>'}</div>
      </div>
      <div class="hdr-right">
        <span class="confidential">Confidential</span>
        <div class="rid">${esc(reportId)}</div>
      </div>
    </header>

    <div class="title-block">
      <h1>${esc(report.title)}</h1>
      <div class="meta">
        <div><span>Prepared for</span><b>${esc(tenantName || companyName)}</b></div>
        <div><span>Reporting period</span><b>${esc(report.period || '—')}</b></div>
        <div><span>Generated</span><b>${esc(genStr)}</b></div>
        <div><span>Generated by</span><b>${esc(generatedBy || '—')}</b></div>
      </div>
    </div>

    ${report.note ? `<div class="note">${esc(report.note)}</div>` : ''}

    ${kpis ? `<h2 class="sec">Executive summary</h2><div class="kpis">${kpis}</div>` : ''}

    ${tables ? `<h2 class="sec">Details</h2>${tables}` : ''}
  </div>

  <footer class="rpt-footer">
    <span>${esc(companyName)} · ${esc(report.title)}</span>
    <span>Confidential — generated ${esc(genStr)}</span>
  </footer>

  <script>
    // Auto-open the print dialog once the (data-URL) logo has painted.
    window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 300); });
  </script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return false; // popup blocked
  w.document.open();
  w.document.write(doc);
  w.document.close();
  return true;
}
