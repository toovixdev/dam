/* TooVix DAM — Admin Console shell.
 * Two modes: Super Admin (platform ops) and Tenant Admin (advanced tenant config).
 * Reuses the same design system (app.css) as the main product mockups. */
(function () {
  if (!document.querySelector('link[rel="icon"]')) {
    var fav = document.createElement('link');
    fav.rel = 'icon'; fav.type = 'image/svg+xml'; fav.href = 'assets/favicon.svg';
    document.head.appendChild(fav);
  }

  var NAV_SUPER = [
    { sec: 'Platform' },
    { id: 'dashboard',      ic: '▤', label: 'Platform Dashboard',    href: 'index.html',              built: true },
    { id: 'tenants',        ic: '⊞', label: 'Tenants',               href: 'tenants.html',             built: true },
    { id: 'feature-flags',  ic: '⚑', label: 'Feature Flags',         href: 'feature-flags.html',       built: true },
    { id: 'tenant-quotas',  ic: '◫', label: 'Resource Quotas',       href: 'tenant-quotas.html',       built: true },
    { id: 'tenant-health',  ic: '◉', label: 'Tenant Health',         href: 'tenant-health.html',       built: true },

    { sec: 'Infrastructure' },
    { id: 'infra-health',   ic: '⊡', label: 'Infrastructure Health', href: 'infra-health.html',        built: true },
    { id: 'noisy-neighbor',  ic: '⚡', label: 'Noisy Neighbor',       href: 'noisy-neighbor.html',      built: true },
    { id: 'canary-deploy',  ic: '⊹', label: 'Canary Deployments',   href: 'canary-deploy.html',       built: true },
    { id: 'capacity',       ic: '◎', label: 'Capacity Planning',     href: 'capacity-planning.html',   built: true },
    { id: 'runbooks',       ic: '▷', label: 'Runbooks',              href: 'runbooks.html',            built: true },

    { sec: 'Billing & Success' },
    { id: 'billing',        ic: '◈', label: 'Billing & Plans',       href: 'billing.html',             built: true },
    { id: 'trial-conv',     ic: '⊳', label: 'Trial Conversion',      href: 'trial-conversion.html',    built: true },
    { id: 'cust-success',   ic: '♥', label: 'Customer Success',      href: 'customer-success.html',    built: true },

    { sec: 'Security & Ops' },
    { id: 'platform-audit', ic: '⛓', label: 'Platform Audit Log',   href: 'platform-audit.html',      built: true },
    { id: 'impersonation',  ic: '◑', label: 'Impersonation',         href: 'tenant-impersonation.html',built: true },
    { id: 'break-glass',    ic: '⚠', label: 'Break-Glass Access',    href: 'break-glass.html',         built: true },
    { id: 'roles',          ic: '⊕', label: 'Roles & Permissions',  href: 'roles.html',               built: true },
    { id: 'approvals',      ic: '✓', label: 'Approval Requests',    href: 'approvals.html',           built: true },
    { id: 'data-sov',       ic: '🌍', label: 'Data Sovereignty',     href: 'data-sovereignty.html',    built: true },

    { sec: 'Product Config' },
    { id: 'content-packs',  ic: '⭳', label: 'Content Packs',        href: 'content-packs.html',       built: true },
    { id: 'agent-versions', ic: '⊡', label: 'Agent Versions',        href: 'agent-versions.html',      built: true },
    { id: 'platform-cfg',   ic: '⚙', label: 'Platform Config',      href: 'platform-config.html' },
  ];

  var NAV_TENANT = [
    { sec: 'Tenant Admin' },
    { id: 'tenant-dash',   ic: '▤', label: 'Tenant Overview',       href: 'tenant-dashboard.html', built: true },
    { id: 'tenant-users',  ic: '☰', label: 'Users & RBAC',         href: 'tenant-users.html' },
    { id: 'tenant-sso',    ic: '▲', label: 'SSO & SCIM',           href: 'tenant-sso.html',       built: true },

    { sec: 'Agent Management' },
    { id: 'tenant-agents', ic: '⊡', label: 'Agent Fleet',          href: 'tenant-agents.html' },
    { id: 'tenant-upgrade',ic: '⟳', label: 'Rolling Upgrades',     href: 'tenant-upgrades.html' },
    { id: 'tenant-enroll', ic: '⊹', label: 'Enrollment Tokens',    href: 'tenant-enroll.html' },

    { sec: 'Data & Security' },
    { id: 'tenant-kms',    ic: '🔑', label: 'KMS & BYOK',          href: 'tenant-kms.html',       built: true },
    { id: 'tenant-retain', ic: '◷', label: 'Retention & Archive',  href: 'tenant-retention.html' },
    { id: 'tenant-api',    ic: '⇄', label: 'API Keys & Webhooks',  href: 'tenant-api.html' },

    { sec: 'Configuration' },
    { id: 'tenant-notify', ic: '🔔', label: 'Notification Channels',href: 'tenant-notify.html' },
    { id: 'tenant-iac',    ic: '⌘', label: 'Terraform / GitOps',   href: 'tenant-iac.html' },
    { id: 'tenant-cfg',    ic: '⚙', label: 'Tenant Settings',      href: 'tenant-settings.html' },
  ];

  var MODES = {
    super:  { label: 'Super Admin',  user: 'Platform Ops',  initials: 'PO', role: 'TooVix Platform Operations', nav: NAV_SUPER },
    tenant: { label: 'Tenant Admin', user: 'Sarah Chen',    initials: 'SC', role: 'Tenant Admin · Meridian Financial', nav: NAV_TENANT },
  };

  var THEMES = [
    { id: 'dark',     ic: '&#127769;', name: 'Dark',     desc: 'Indigo on slate' },
    { id: 'light',    ic: '&#9728;',   name: 'Light',    desc: 'Indigo on white' },
    { id: 'system',   ic: '&#128421;', name: 'System',   desc: 'Follow OS preference' },
    { id: 'midnight', ic: '&#127761;', name: 'Midnight', desc: 'Pure black, violet glow' },
    { id: 'ocean',    ic: '&#127754;', name: 'Ocean',    desc: 'Cool blue, professional' },
    { id: 'forest',   ic: '&#127794;', name: 'Forest',   desc: 'Sage + emerald, calm' },
    { id: 'saffron',  ic: '&#129684;', name: 'Saffron',  desc: 'Warm tones' },
    { id: 'sunset',   ic: '&#127751;', name: 'Sunset',   desc: 'Cream + coral, cozy' },
    { id: 'mono',     ic: '&#9680;',   name: 'Mono',     desc: 'Grayscale, minimalist' },
  ];

  var $theme = function(){ return localStorage.getItem('nx-theme') || 'dark'; };
  var $mode  = function(){ return localStorage.getItem('adm-mode') || 'super'; };

  function applyTheme(pref) {
    var eff = pref === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-theme', eff);
  }
  applyTheme($theme());

  document.addEventListener('DOMContentLoaded', function () {
    var b = document.body;
    var active = b.dataset.active || '';
    var modeKey = MODES[$mode()] ? $mode() : 'super';
    var M = MODES[modeKey];
    var content = b.innerHTML;

    function buildNavHtml(items) {
      var html = '', pendingSec = null;
      items.forEach(function(n) {
        if (n.sec) { pendingSec = n.sec; return; }
        if (pendingSec) { html += '<div class="nsec">' + pendingSec + '</div>'; pendingSec = null; }
        var cls = 'nav' + (n.id === active ? ' active' : '');
        html += '<a class="' + cls + '" href="' + n.href + '" title="' + n.label + '"><span class="ic">' + n.ic + '</span><span class="lbl">' + n.label + '</span></a>';
      });
      return html;
    }

    var modeOpts = Object.keys(MODES).map(function(k) {
      return '<option value="' + k + '"' + (k === modeKey ? ' selected' : '') + '>' + MODES[k].label + '</option>';
    }).join('');

    b.innerHTML =
    '<div class="app">' +
      '<aside class="side">' +
        '<div class="brand"><span class="dot" style="background:var(--danger)">A</span> <span class="lbl">TooVix <span style="font-weight:500;color:var(--muted);font-size:11px">ADMIN</span></span></div>' +
        '<nav class="navwrap">' + buildNavHtml(M.nav) + '</nav>' +
        '<details class="proto-ctrl">' +
          '<summary>Prototype controls</summary>' +
          '<label class="roleswitch"><span class="lbl">Mode</span><select id="modeSel">' + modeOpts + '</select></label>' +
        '</details>' +
      '</aside>' +
      '<div class="main">' +
        '<div class="top">' +
          '<div class="search"><span style="flex:none">&#128270;</span><input type="text" placeholder="Search tenants, agents, config..." style="border:none;background:transparent;outline:none;font-family:var(--font);font-size:13px;color:var(--ink);flex:1;min-width:0"><span class="kbd">&#8984;K</span></div>' +
          '<div class="tspace"></div>' +
          '<span style="font-size:12px;font-weight:600;background:var(--danger-soft);color:var(--danger);padding:3px 10px;border-radius:6px">' + M.label.toUpperCase() + '</span>' +
          '<button class="tibtn" id="themeBtn" title="Theme">&#127912;</button>' +
          '<button class="tav" id="meBtn" title="Account">' + M.initials + '</button>' +
          '<div class="themepop" id="themePop" hidden>' +
            '<div class="tph"><b>Theme</b><span>9 to choose from</span></div>' +
            '<div class="tpgrid">' + THEMES.map(function(t){ return '<button class="tpc' + (t.id === $theme() ? ' on' : '') + '" data-theme="' + t.id + '">' +
              '<span class="tpprev tpprev-' + t.id + '"><span class="b1"></span><span class="b2"></span><span class="cta">CTA</span></span>' +
              '<span class="tpn">' + t.ic + ' ' + t.name + '</span><span class="tpd">' + t.desc + '</span>' +
              '<span class="tpck">&#10003;</span></button>'; }).join('') + '</div>' +
            '<div class="tpf">Theme affects every screen. Semantic colours (critical / high / medium / info) stay consistent.</div>' +
          '</div>' +
          '<div class="mepop-top" id="mePop" hidden>' +
            '<div class="meph"><span class="av">' + M.initials + '</span><div class="mephinfo"><b>' + M.user + '</b><small>' + M.role + '</small></div></div>' +
            '<a href="index.html" class="mei"><span class="mic">&#9673;</span> Admin home</a>' +
            '<a href="../mockups/dashboard.html" class="mei"><span class="mic">&#9655;</span> Main product</a>' +
            '<a href="../mockups/login.html" class="mei signout"><span class="mic">&#9099;</span> Sign out</a>' +
          '</div>' +
        '</div>' +
        '<div class="content">' + content + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="flag" style="background:var(--danger-soft);color:var(--danger)">&#9679; ADMIN CONSOLE &middot; TooVix DAM &middot; ' + M.label + '</div>';

    // Mode switcher
    var modeSel = document.getElementById('modeSel');
    if (modeSel) modeSel.onchange = function() { localStorage.setItem('adm-mode', modeSel.value); location.reload(); };

    // Theme popover
    var tBtn = document.getElementById('themeBtn'), tPop = document.getElementById('themePop');
    if (tBtn && tPop) {
      tBtn.onclick = function(e) { e.stopPropagation(); tPop.hidden = !tPop.hidden; if (mePop) mePop.hidden = true; };
      tPop.querySelectorAll('.tpc').forEach(function(card) {
        card.onclick = function() {
          var theme = card.dataset.theme;
          localStorage.setItem('nx-theme', theme);
          applyTheme(theme);
          tPop.querySelectorAll('.tpc').forEach(function(c) { c.classList.remove('on'); });
          card.classList.add('on');
          tPop.hidden = true;
        };
      });
      document.addEventListener('click', function(e) { if (!tPop.hidden && !tPop.contains(e.target) && e.target !== tBtn) tPop.hidden = true; });
    }

    // Account popover
    var meBtn = document.getElementById('meBtn'), mePop = document.getElementById('mePop');
    if (meBtn && mePop) {
      meBtn.onclick = function(e) { e.stopPropagation(); mePop.hidden = !mePop.hidden; if (tPop) tPop.hidden = true; };
      document.addEventListener('click', function(e) { if (!mePop.hidden && !mePop.contains(e.target) && !meBtn.contains(e.target)) mePop.hidden = true; });
    }

    // Re-run inline scripts
    document.querySelectorAll('.content script').forEach(function(old) {
      if (old.src) return;
      var s = document.createElement('script'); s.textContent = old.textContent; old.replaceWith(s);
    });
  });
})();
