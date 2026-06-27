/* Perfast mockup shared UI kit — dependency-free.
 * Provides: toast, CSV/print export, theme-aware SVG charts (bar/line/donut/spark/progress),
 * inline form validation, and a per-screen AI-help card.  Use via the global `pf`.
 * Charts use CSS vars (var(--primary) …) so they re-colour automatically with the theme. */
(function () {
  const pf = window.pf = window.pf || {};
  const PAL = ['var(--primary)', 'var(--info)', 'var(--green)', 'var(--amber)', 'var(--danger)', '#8b5cf6', '#0ea5e9', '#ec4899'];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = sel => typeof sel === 'string' ? document.querySelector(sel) : sel;

  // ---------- toast ----------
  pf.toast = function (msg, type) {
    let host = document.getElementById('pfToasts');
    if (!host) { host = document.createElement('div'); host.id = 'pfToasts'; host.className = 'pf-toasts'; document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = 'pf-toast' + (type ? ' ' + type : '');
    t.innerHTML = (type === 'err' ? '⚠ ' : type === 'ok' ? '✓ ' : '') + esc(msg);
    host.appendChild(t);
    setTimeout(() => t.classList.add('in'), 10);
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 250); }, 3200);
  };

  pf.money = function (n, ccy) { return (ccy || '€') + Number(n || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  // ---------- export ----------
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  const csvCell = v => { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  pf.exportCSV = function (filename, headers, rows) {
    const lines = [headers.map(csvCell).join(',')].concat(rows.map(r => r.map(csvCell).join(',')));
    download(filename, lines.join('\r\n'));
    pf.toast('Exported ' + filename, 'ok');
  };
  // export an existing <table> (skips elements with .no-export)
  pf.tableToCSV = function (table, filename) {
    table = el(table); if (!table) return;
    const grab = tr => [...tr.children].filter(c => !c.classList.contains('no-export')).map(c => c.innerText);
    const head = [...table.querySelectorAll('thead tr')].map(grab)[0] || grab(table.querySelector('tr'));
    const body = [...table.querySelectorAll('tbody tr')].map(grab);
    pf.exportCSV(filename || 'export.csv', head, body.length ? body : [...table.querySelectorAll('tr')].slice(1).map(grab));
  };
  pf.print = function () { window.print(); };

  // ---------- charts (SVG, responsive via viewBox, theme-aware via CSS vars) ----------
  function svg(w, h, inner, cls) {
    return `<svg class="pf-chart ${cls || ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
  }
  // data: [{label, value, color?}]
  pf.bar = function (target, data, opts) {
    opts = opts || {}; const W = 520, H = opts.height || 220, pl = 34, pb = 26, pt = 12, pr = 8;
    const max = opts.max || Math.max(1, ...data.map(d => d.value));
    const iw = W - pl - pr, ih = H - pb - pt, bw = iw / data.length, gap = Math.min(18, bw * 0.34);
    let g = '';
    for (let i = 0; i <= 4; i++) { const y = pt + ih - ih * i / 4; const v = Math.round(max * i / 4); g += `<line x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}" class="pf-grid"/><text x="${pl - 6}" y="${y + 3}" class="pf-axt" text-anchor="end">${v}</text>`; }
    data.forEach((d, i) => {
      const bh = Math.max(0, ih * d.value / max), x = pl + bw * i + gap / 2, y = pt + ih - bh, w = bw - gap;
      g += `<rect x="${x}" y="${y}" width="${w}" height="${bh}" rx="4" fill="${d.color || 'var(--primary)'}"><title>${esc(d.label)}: ${esc(d.value)}</title></rect>`;
      if (opts.values) g += `<text x="${x + w / 2}" y="${y - 4}" class="pf-axt" text-anchor="middle">${esc(d.value)}</text>`;
      g += `<text x="${x + w / 2}" y="${H - 8}" class="pf-axt" text-anchor="middle">${esc(d.label)}</text>`;
    });
    el(target).innerHTML = svg(W, H, g, 'bar');
  };
  // series: {labels:[], lines:[{name,color,points:[]}]}
  pf.line = function (target, series, opts) {
    opts = opts || {}; const W = 520, H = opts.height || 220, pl = 34, pb = 26, pt = 12, pr = 8;
    const all = series.lines.flatMap(l => l.points); const max = opts.max || Math.max(1, ...all), min = opts.min || 0;
    const iw = W - pl - pr, ih = H - pb - pt, n = series.labels.length;
    const X = i => pl + (n <= 1 ? iw / 2 : iw * i / (n - 1)), Y = v => pt + ih - ih * (v - min) / (max - min || 1);
    let g = '';
    for (let i = 0; i <= 4; i++) { const y = pt + ih - ih * i / 4; g += `<line x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}" class="pf-grid"/><text x="${pl - 6}" y="${y + 3}" class="pf-axt" text-anchor="end">${Math.round((min + (max - min) * i / 4))}</text>`; }
    series.labels.forEach((lb, i) => g += `<text x="${X(i)}" y="${H - 8}" class="pf-axt" text-anchor="middle">${esc(lb)}</text>`);
    series.lines.forEach(l => {
      const pts = l.points.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
      if (opts.area) g += `<polygon points="${pl},${pt + ih} ${pts} ${pl + iw},${pt + ih}" fill="${l.color || 'var(--primary)'}" opacity=".10"/>`;
      g += `<polyline points="${pts}" fill="none" stroke="${l.color || 'var(--primary)'}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      l.points.forEach((v, i) => g += `<circle cx="${X(i)}" cy="${Y(v)}" r="3.2" fill="${l.color || 'var(--primary)'}"><title>${esc(l.name || '')} ${esc(series.labels[i])}: ${esc(v)}</title></circle>`);
    });
    if (opts.threshold != null) { const y = Y(opts.threshold); g += `<line x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}" class="pf-thr"/><text x="${W - pr}" y="${y - 4}" class="pf-axt" text-anchor="end" fill="var(--danger)">${esc(opts.thresholdLabel || opts.threshold)}</text>`; }
    el(target).innerHTML = svg(W, H, g, 'line');
  };
  // data: [{label,value,color?}]
  pf.donut = function (target, data, opts) {
    opts = opts || {}; const S = 180, r = 66, ir = 42, cx = S / 2, cy = S / 2;
    const total = data.reduce((a, d) => a + d.value, 0) || 1; let a0 = -Math.PI / 2, g = '';
    data.forEach((d, i) => {
      const a1 = a0 + 2 * Math.PI * d.value / total, big = (a1 - a0) > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const xi0 = cx + ir * Math.cos(a1), yi0 = cy + ir * Math.sin(a1), xi1 = cx + ir * Math.cos(a0), yi1 = cy + ir * Math.sin(a0);
      const col = d.color || PAL[i % PAL.length];
      g += `<path d="M${x0} ${y0} A${r} ${r} 0 ${big} 1 ${x1} ${y1} L${xi0} ${yi0} A${ir} ${ir} 0 ${big} 0 ${xi1} ${yi1} Z" fill="${col}"><title>${esc(d.label)}: ${esc(d.value)}</title></path>`;
      a0 = a1;
    });
    const cap = opts.center != null ? opts.center : (opts.centerHide ? '' : total);
    if (cap !== '') g += `<text x="${cx}" y="${cy - 2}" class="pf-dc" text-anchor="middle">${esc(cap)}</text>` + (opts.centerSub ? `<text x="${cx}" y="${cy + 15}" class="pf-axt" text-anchor="middle">${esc(opts.centerSub)}</text>` : '');
    const leg = opts.legend === false ? '' : `<div class="pf-legend">${data.map((d, i) => `<span><i style="background:${d.color || PAL[i % PAL.length]}"></i>${esc(d.label)} <b>${esc(d.value)}</b></span>`).join('')}</div>`;
    el(target).innerHTML = `<div class="pf-donutwrap">${svg(S, S, g, 'donut')}${leg}</div>`;
  };
  pf.spark = function (target, vals, opts) {
    opts = opts || {}; const W = 120, H = 32, max = Math.max(1, ...vals), min = Math.min(0, ...vals);
    const pts = vals.map((v, i) => `${W * i / (vals.length - 1)},${H - (H - 4) * (v - min) / (max - min || 1) - 2}`).join(' ');
    el(target).innerHTML = svg(W, H, `<polyline points="${pts}" fill="none" stroke="${opts.color || 'var(--primary)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`, 'spark');
  };
  // simple horizontal progress bar: pct 0-100
  pf.progress = function (pct, color) {
    return `<span class="pf-prog"><span style="width:${Math.max(0, Math.min(100, pct))}%;background:${color || 'var(--primary)'}"></span></span>`;
  };

  // ---------- form validation ----------
  // Mark fields with: required, type=email, [data-rule="hhmm|iban|sort|amount|sortuk|sortie"], [data-min],[data-max]
  const RULES = {
    email: v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || 'Enter a valid email',
    hhmm: v => /^([01]?\d|2[0-9])[0-5]\d$/.test(v) || v === '' || 'Use HHMM (e.g. 0800)',
    amount: v => (Number(v) > 0) || 'Amount must be greater than 0',
    sort: v => /^\d{2}-?\d{2}-?\d{2}$/.test(v) || 'Sort code: 6 digits (UK/IE)',
    iban: v => /^IE\d{2}[A-Z]{4}\d{14}$/.test(v.replace(/\s/g, '')) || 'Irish IBAN: IE + 20 chars',
    phone: v => /^[\d +()-]{7,}$/.test(v) || 'Enter a valid phone number'
  };
  pf.validateField = function (f) {
    const wrap = f.closest('.fld') || f.parentElement;
    let msg = '';
    const v = (f.value || '').trim();
    if ((f.required || f.hasAttribute('required')) && !v) msg = 'Required';
    else if (v && f.dataset.rule && RULES[f.dataset.rule]) { const r = RULES[f.dataset.rule](v); if (r !== true) msg = r; }
    else if (v && f.type === 'email') { const r = RULES.email(v); if (r !== true) msg = r; }
    else if (v && f.dataset.min != null && Number(v) < Number(f.dataset.min)) msg = 'Min ' + f.dataset.min;
    else if (v && f.dataset.max != null && Number(v) > Number(f.dataset.max)) msg = 'Max ' + f.dataset.max;
    f.classList.toggle('invalid', !!msg);
    let e = wrap.querySelector('.err');
    if (msg) { if (!e) { e = document.createElement('div'); e.className = 'err'; wrap.appendChild(e); } e.textContent = msg; }
    else if (e) e.remove();
    return !msg;
  };
  // validate a container; returns true if all ok. Optionally pass extra check fn (els)->errorMsg|null
  pf.validate = function (scope, extra) {
    scope = el(scope) || document;
    const fields = [...scope.querySelectorAll('input,select,textarea')].filter(f => f.required || f.hasAttribute('required') || f.dataset.rule || f.type === 'email' || f.dataset.min != null || f.dataset.max != null);
    let ok = true; fields.forEach(f => { if (!pf.validateField(f)) ok = false; });
    if (ok && typeof extra === 'function') { const m = extra(scope); if (m) { pf.toast(m, 'err'); ok = false; } }
    if (!ok && !(typeof extra === 'function')) pf.toast('Please fix the highlighted fields', 'err');
    return ok;
  };
  // live-clear errors as the user fixes them
  document.addEventListener('input', e => { if (e.target.classList && e.target.classList.contains('invalid')) pf.validateField(e.target); }, true);

  // ---------- per-screen AI-help card ----------
  // pf.aiHelp({mount, title, intro, tips:[...], asks:['question', ...]})
  pf.aiHelp = function (cfg) {
    cfg = cfg || {};
    const card = document.createElement('div'); card.className = 'aihelp';
    card.innerHTML =
      `<div class="aihelp-h"><span class="aihelp-i">✦</span><b>${esc(cfg.title || 'AI on this screen')}</b></div>` +
      (cfg.intro ? `<p>${cfg.intro}</p>` : '') +
      (cfg.tips && cfg.tips.length ? `<ul>${cfg.tips.map(t => `<li>${t}</li>`).join('')}</ul>` : '') +
      `<div class="aihelp-asks">${(cfg.asks || []).map(q => `<button class="aihelp-ask" type="button">${esc(q)}</button>`).join('')}</div>`;
    card.querySelectorAll('.aihelp-ask').forEach(b => b.onclick = () => window.pfAi && window.pfAi.ask(b.textContent));
    const host = cfg.mount ? el(cfg.mount) : document.querySelector('.content');
    if (host) host.appendChild(card);
    return card;
  };
})();
