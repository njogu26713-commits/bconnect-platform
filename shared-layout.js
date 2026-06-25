(function () {
  if (window.__bconnectLayoutLoaded) return;
  window.__bconnectLayoutLoaded = true;

  /* ── Flash-of-old-header prevention ──────────────────────────────────
     Injected immediately (synchronously, before DOMContentLoaded) so the
     browser suppresses the original nav/header before first paint.       */
  (function() {
    var s = document.createElement('style');
    s.id = 'bc-pre-hide';
    s.textContent =
      'header:not(#bc-header){visibility:hidden!important;opacity:0!important}' +
      'nav:not(#bc-bottom-nav):not(.mob-nav-bar):not(.mob-nav):not(#bc-header nav){visibility:hidden!important;opacity:0!important}';
    (document.head || document.documentElement).appendChild(s);
  })();

  var NAV_LINKS = [
    { href: 'pre-home.html', label: 'Home', match: ['pre-home.html', 'website.html', 'index.html', '/'] },
    { href: 'products.html', label: 'Marketplace', match: ['products.html'] },
    { href: 'services.html', label: 'Services' },
    { href: 'housing.html', label: 'Housing' },
    { href: 'events.html', label: 'Events & Tickets', match: ['events.html'] },
    { href: '#', label: 'Landlord', match: ['landlord-dashboard.html'], isLandlord: true },
    { href: 'payrent.html', label: 'Pay Rent' },
    { href: 'contact.html', label: 'Contact', match: ['contact.html'] }
  ];

  var STYLE = '\n' +
    '#bc-header,#bc-footer{font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;box-sizing:border-box}\n' +
    '#bc-header *,#bc-footer *{box-sizing:border-box}\n' +
    /* Force header/footer to be full-width blocks regardless of any parent flex/grid layout */
    '#bc-header{display:block!important;width:100%!important;max-width:100%!important;flex:0 0 auto!important;align-self:stretch!important;grid-column:1/-1!important;position:sticky;top:0;z-index:9000;background:#ffffff;border-bottom:1px solid rgba(15,41,114,.08);box-shadow:0 8px 24px rgba(15,41,114,.06)}\n' +
    '#bc-header .bc-inner{width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;flex-wrap:wrap}\n' +
    '#bc-header .bc-left{display:flex;align-items:center;gap:16px;flex:1;min-width:0}\n' +
    '#bc-header .bc-right{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:auto}\n' +
    '#bc-header .bc-brand{display:flex;align-items:center;gap:8px;text-decoration:none;font-family:Inter,system-ui,sans-serif;flex-shrink:0}\n' +
    '#bc-header .bc-brand-img{height:52px;width:auto;display:block}\n' +
    '#bc-header .bc-brand-name{font-size:1.38rem;font-weight:900;color:#0f1e3d;letter-spacing:-.5px}\n' +
    '#bc-header nav.bc-nav{display:flex;flex-wrap:wrap;gap:6px;align-items:center}\n' +
    '#bc-header nav.bc-nav a{color:#475569;text-decoration:none;font-weight:600;font-size:.95rem;padding:8px 12px;border-radius:10px;transition:background .15s,color .15s}\n' +
    '#bc-header nav.bc-nav a:hover{background:#eef2ff;color:#1d4ed8}\n' +
    '#bc-header nav.bc-nav a.active{background:#1d4ed8;color:#fff}\n' +
    '#bc-header .bc-burger{display:none;border:0;background:transparent;font-size:1.6rem;color:#1d4ed8;cursor:pointer;padding:4px 8px}\n' +
    '@media(max-width:880px){\n' +
    '  #bc-header .bc-burger{display:inline-block}\n' +
    '  #bc-header nav.bc-nav{display:none;flex-direction:column;align-items:stretch;width:100%;padding-top:8px}\n' +
    '  #bc-header.bc-open nav.bc-nav{display:flex}\n' +
    '  #bc-header nav.bc-nav a{padding:12px 14px}\n' +
    '}\n' +
    '@media(max-width:640px){\n' +
    '  #bc-header .bc-burger{display:none!important}\n' +
    '  #bc-header nav.bc-nav{display:none!important}\n' +
    '  #bc-header .bc-inner{justify-content:center;padding:10px 16px}\n' +
    '}\n' +
    '#bc-footer{display:block!important;width:100%!important;max-width:100%!important;flex:0 0 auto!important;align-self:stretch!important;grid-column:1/-1!important;margin-top:48px;background:#0f172a;color:#e2e8f0;padding:36px 24px 22px}\n' +
    '#bc-footer .bc-finner{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:28px}\n' +
    '#bc-footer h4{margin:0 0 12px;color:#fff;font-size:1rem}\n' +
    '#bc-footer a{color:#cbd5f5;text-decoration:none;display:block;padding:4px 0;font-size:.92rem}\n' +
    '#bc-footer a:hover{color:#93c5fd}\n' +
    '#bc-footer p{margin:6px 0;font-size:.92rem;color:#cbd5f5;line-height:1.6}\n' +
    '#bc-footer .bc-bottom{max-width:1200px;margin:24px auto 0;padding-top:18px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;color:#94a3b8;font-size:.85rem}\n';

  function currentPage() {
    var p = (window.location.pathname || '').split('/').pop().toLowerCase();
    if (!p || p === '') p = 'pre-home.html';
    return p;
  }

  // Pages that should show the full app nav
  var APP_PAGES = ['website.html', 'index.html', '', 'products.html', 'services.html', 'housing.html', 'events.html', 'orders.html', 'ai-assistant.html', 'tenant.html', 'tenant-dashboard.html', 'tenant-portal.html', 'landlord.html', 'payrent.html'];

  function buildHeader() {
    var page = currentPage();
    var isAppPage = APP_PAGES.indexOf(page) !== -1;

    var header = document.createElement('header');
    header.id = 'bc-header';
    var inner = document.createElement('div');
    inner.className = 'bc-inner';

    var leftGroup = document.createElement('div');
    leftGroup.className = 'bc-left';

    var brand = document.createElement('a');
    brand.className = 'bc-brand';
    brand.href = 'pre-home.html';
    brand.innerHTML = '<img class="bc-brand-img" src="/bconnect-badge-nobg.png" alt="BConnect" onerror="this.src=\'/bconnect-badge-nobg.png\'"><span class="bc-brand-name">BConnect</span>';
    leftGroup.appendChild(brand);

    if (isAppPage) {
      var burger = document.createElement('button');
      burger.className = 'bc-burger';
      burger.setAttribute('aria-label', 'Toggle navigation');
      burger.textContent = '\u2630';
      burger.addEventListener('click', function () { header.classList.toggle('bc-open'); });
      leftGroup.appendChild(burger);

      var nav = document.createElement('nav');
      nav.className = 'bc-nav';
      NAV_LINKS.forEach(function (link) {
        var a = document.createElement('a');
        a.href = link.href;
        a.textContent = link.label;
        var matches = link.match || [link.href];
        if (matches.indexOf(page) !== -1) a.className = 'active';
        if (link.isLandlord) {
          a.href = '#';
          a.addEventListener('click', function(e) {
            e.preventDefault();
            var lt = localStorage.getItem('landlordToken') || localStorage.getItem('token') || localStorage.getItem('authToken');
            if (lt) {
              window.location.href = 'landlord-dashboard.html';
            } else {
              window.location.href = 'landlord-login.html';
            }
          });
        }
        nav.appendChild(a);
      });
      leftGroup.appendChild(nav);
      inner.appendChild(leftGroup);

      var rightGroup = document.createElement('div');
      rightGroup.className = 'bc-right';

      // Notification bell — only visible when logged in
      var token = localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('auth_token') || localStorage.getItem('landlordToken');
      if (token) {
        var bellWrap = document.createElement('div');
        bellWrap.id = 'bc-notif-wrap';
        bellWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center';

        var bellBtn = document.createElement('button');
        bellBtn.id = 'bc-notif-btn';
        bellBtn.setAttribute('aria-label', 'Notifications');
        bellBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
        bellBtn.setAttribute('style', 'position:relative;background:transparent;border:0;cursor:pointer;color:#475569;padding:6px;border-radius:10px;display:flex;align-items:center;transition:background .15s,color .15s');

        var bellBadge = document.createElement('span');
        bellBadge.id = 'bc-notif-badge';
        bellBadge.setAttribute('style', 'display:none;position:absolute;top:1px;right:1px;min-width:17px;height:17px;background:#ef4444;color:#fff;border-radius:99px;font-size:10px;font-weight:800;line-height:17px;text-align:center;padding:0 3px;border:2px solid #fff;box-sizing:border-box');
        bellBtn.appendChild(bellBadge);
        bellWrap.appendChild(bellBtn);

        var bellPanel = document.createElement('div');
        bellPanel.id = 'bc-notif-panel';
        bellPanel.setAttribute('style', 'display:none;position:absolute;top:calc(100% + 10px);right:0;width:340px;max-height:460px;background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.18);border:1px solid #e5e7eb;z-index:9500;flex-direction:column;overflow:hidden;font-family:Inter,system-ui,sans-serif');

        var panelHead = document.createElement('div');
        panelHead.setAttribute('style', 'padding:14px 18px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f1f5f9;flex-shrink:0');
        panelHead.innerHTML = '<span style="font-weight:800;font-size:.95rem;color:#111827">Notifications</span>';

        var markAllBtn = document.createElement('button');
        markAllBtn.id = 'bc-notif-markall';
        markAllBtn.textContent = 'Mark all read';
        markAllBtn.setAttribute('style', 'background:none;border:0;color:#3b82f6;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit;padding:2px 4px;border-radius:6px');
        panelHead.appendChild(markAllBtn);
        bellPanel.appendChild(panelHead);

        var notifList = document.createElement('div');
        notifList.id = 'bc-notif-list';
        notifList.setAttribute('style', 'overflow-y:auto;flex:1;max-height:360px');
        notifList.innerHTML = '<div style="padding:28px 18px;text-align:center;color:#9ca3af;font-size:.85rem">Loading...</div>';
        bellPanel.appendChild(notifList);

        bellWrap.appendChild(bellPanel);
        rightGroup.appendChild(bellWrap);

        var settingsBtn = document.createElement('button');
        settingsBtn.id = 'bc-settings-btn';
        settingsBtn.setAttribute('aria-label', 'Settings');
        settingsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
        settingsBtn.setAttribute('style', 'background:transparent;border:0;cursor:pointer;color:#475569;padding:6px;border-radius:10px;display:flex;align-items:center;transition:background .15s,color .15s');
        settingsBtn.addEventListener('mouseenter', function() { this.style.background = '#f1f5f9'; this.style.color = '#1e293b'; });
        settingsBtn.addEventListener('mouseleave', function() { this.style.background = 'transparent'; this.style.color = '#475569'; });
        settingsBtn.addEventListener('click', function() { window.location.href = '/settings'; });
        rightGroup.appendChild(settingsBtn);
      }

      // Profile avatar slot — always present, replaced by profile-widget.js
      var profileSlot = document.createElement('div');
      profileSlot.id = 'bc-profile-slot';
      rightGroup.appendChild(profileSlot);

      inner.appendChild(rightGroup);
    } else {
      inner.appendChild(leftGroup);
    }

    header.appendChild(inner);
    return header;
  }

  function buildFooter() {
    var footer = document.createElement('footer');
    footer.id = 'bc-footer';
    footer.innerHTML =
      '<div class="bc-finner">' +
        '<div>' +
          '<h4>bConnect</h4>' +
          '<p>Products, services and rentals \u2014 all in one trusted Kenyan marketplace.</p>' +
        '</div>' +
        '<div>' +
          '<h4>Explore</h4>' +
          '<a href="pre-home.html">Home</a>' +
          '<a href="products.html">Marketplace</a>' +
          '<a href="services.html">Services</a>' +
          '<a href="housing.html">Housing &amp; Rentals</a>' +
          '<a href="landlord.html">For Landlords</a>' +
          '<a href="tenant.html">For Tenants</a>' +
        '</div>' +
        '<div>' +
          '<h4>Company</h4>' +
          '<a href="about.html">About</a>' +
          '<a href="features.html">Features</a>' +
          '<a href="solutions.html">Solutions</a>' +
          '<a href="support.html">Support</a>' +
          '<a href="contact.html">Contact</a>' +
        '</div>' +
        '<div>' +
          '<h4>Reach us</h4>' +
          '<a href="https://wa.me/254118234849" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:6px">'+
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.528 5.855L.057 23.882a.5.5 0 0 0 .612.612l6.098-1.457A11.945 11.945 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.9a9.887 9.887 0 0 1-5.031-1.371l-.36-.214-3.724.89.908-3.63-.235-.374A9.9 9.9 0 0 1 2.1 12C2.1 6.534 6.534 2.1 12 2.1S21.9 6.534 21.9 12 17.466 21.9 12 21.9z"/></svg>' +
            'WhatsApp: +254 118 234 849' +
          '</a>' +
          '<a href="mailto:brayan@bconnect.com">Email: brayan@bconnect.com</a>' +
        '</div>' +
      '</div>' +
      '<div class="bc-bottom">' +
        '<span>\u00a9 ' + new Date().getFullYear() + ' bConnect. All rights reserved.</span>' +
        '<span>Built for Kenya \u2022 Powered by Replit</span>' +
      '</div>';
    return footer;
  }

  function injectStyle() {
    if (document.getElementById('bc-shared-style')) return;
    var st = document.createElement('style');
    st.id = 'bc-shared-style';
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  function removeExisting() {
    var sels = [
      'header',
      'nav',
      'footer',
      '.topbar',
      '.top-bar',
      '.navbar',
      '.nav-bar',
      '.site-header',
      '.site-footer',
      '.page-header',
      '.page-footer',
      '.mobile-menu',
      '.hamburger-menu',
      '.menu-bar',
      '.main-menu',
      '.main-nav'
    ];
    sels.forEach(function (sel) {
      var nodes = document.querySelectorAll(sel);
      nodes.forEach(function (n) {
        if (!n) return;
        if (n.id === 'bc-header' || n.id === 'bc-footer') return;
        if (n.closest && (n.closest('#bc-header') || n.closest('#bc-footer'))) return;
        if (n.closest && (n.closest('.sidebar') || n.closest('aside'))) return;
        n.parentNode && n.parentNode.removeChild(n);
      });
    });
  }

  function wrapBodyContent() {
    // Move existing body children into a wrapper so the page's own flex/grid
    // layout (e.g. login's left/right split) is preserved while we add a
    // full-width header above and footer below it.
    if (document.getElementById('bc-page-content')) return;
    var wrapper = document.createElement('div');
    wrapper.id = 'bc-page-content';
    // Try to copy the body's own display style onto the wrapper so layouts
    // that depend on body { display: flex/grid } keep working.
    try {
      var cs = window.getComputedStyle(document.body);
      var disp = cs.display;
      if (disp && disp !== 'block') {
        wrapper.style.display = disp;
        wrapper.style.flexDirection = cs.flexDirection;
        wrapper.style.flexWrap = cs.flexWrap;
        wrapper.style.justifyContent = cs.justifyContent;
        wrapper.style.alignItems = cs.alignItems;
        wrapper.style.gap = cs.gap;
      }
    } catch (e) {}
    while (document.body.firstChild) {
      wrapper.appendChild(document.body.firstChild);
    }
    document.body.appendChild(wrapper);
    // Reset body so header/footer/wrapper stack vertically.
    document.body.style.display = 'block';
    document.body.style.margin = '0';
  }

  //  User Avatar in Nav 
  var AVATAR_STYLE =
    '#bc-user-avatar{display:flex;align-items:center;gap:8px;cursor:pointer;text-decoration:none;padding:4px 10px;border-radius:10px;transition:background .15s}' +
    '#bc-user-avatar:hover{background:#eef2ff}' +
    '#bc-avatar-img{width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid #3b82f6}' +
    '#bc-avatar-initials{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;flex-shrink:0}' +
    '#bc-avatar-name{font-weight:700;font-size:.88rem;color:#1d4ed8;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '@media(max-width:880px){#bc-avatar-name{display:none}}';

  function injectAvatarStyle() {
    if (document.getElementById('bc-avatar-style')) return;
    var st = document.createElement('style');
    st.id = 'bc-avatar-style';
    st.textContent = AVATAR_STYLE;
    document.head.appendChild(st);
  }

  function getAuthToken() {
    try {
      return localStorage.getItem('token') ||
             localStorage.getItem('authToken') ||
             localStorage.getItem('auth_token') ||
             localStorage.getItem('tenantToken') ||
             localStorage.getItem('landlordToken') ||
             sessionStorage.getItem('auth_token') ||
             null;
    } catch(e) { return null; }
  }

  function buildAvatarEl(profile) {
    var a = document.createElement('a');
    a.id = 'bc-user-avatar';
    a.href = 'website.html';
    a.title = 'My Profile';

    var avatarEl;
    if (profile && profile.avatar_url) {
      avatarEl = document.createElement('img');
      avatarEl.id = 'bc-avatar-img';
      avatarEl.src = profile.avatar_url;
      avatarEl.alt = profile.name || 'Me';
      avatarEl.onerror = function() {
        var init = document.createElement('div');
        init.id = 'bc-avatar-initials';
        init.textContent = (profile.name || 'U')[0].toUpperCase();
        a.replaceChild(init, avatarEl);
      };
    } else {
      avatarEl = document.createElement('div');
      avatarEl.id = 'bc-avatar-initials';
      avatarEl.textContent = profile ? (profile.name || profile.full_name || 'U')[0].toUpperCase() : '';
    }
    a.appendChild(avatarEl);

    if (profile && (profile.name || profile.full_name)) {
      var nameEl = document.createElement('span');
      nameEl.id = 'bc-avatar-name';
      nameEl.textContent = (profile.name || profile.full_name).split(' ')[0];
      a.appendChild(nameEl);
    }
    return a;
  }

  function loadUserAvatar() {
    var token = getAuthToken();
    if (!token) return;
    fetch('/api/profile', {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.profile) return;
      var profile = data.profile;
      window.__bcProfileCache = profile;
      injectAvatarStyle();

      // Remove existing avatar if any
      var old = document.getElementById('bc-user-avatar');
      if (old) old.parentNode.removeChild(old);

      // Replace Login link with avatar
      var nav = document.querySelector('#bc-header nav.bc-nav');
      if (!nav) return;
      var loginLink = null;
      nav.querySelectorAll('a').forEach(function(a) {
        if (a.href && a.href.indexOf('login.html') !== -1) loginLink = a;
      });
      var avatarEl = buildAvatarEl(profile);
      if (loginLink) {
        nav.replaceChild(avatarEl, loginLink);
      } else {
        nav.appendChild(avatarEl);
      }

      // Add Seller Dashboard link for sellers
      if (profile.role === 'seller') {
        var existing = document.getElementById('bc-seller-dash-link');
        if (!existing) {
          var dashLink = document.createElement('a');
          dashLink.id = 'bc-seller-dash-link';
          dashLink.href = 'seller-dashboard.html';
          dashLink.textContent = ' My Dashboard';
          dashLink.style.cssText = 'background:#00e676;color:#0a0f1e!important;font-weight:700;border-radius:10px;padding:8px 14px;';
          nav.insertBefore(dashLink, avatarEl);
        }
      }

      // Also update any [data-user-avatar] images on the page
      document.querySelectorAll('[data-user-avatar]').forEach(function(el) {
        if (profile.avatar_url) {
          el.src = profile.avatar_url;
          el.style.display = '';
        }
      });
      document.querySelectorAll('[data-user-name]').forEach(function(el) {
        el.textContent = profile.name || profile.full_name || '';
      });
      document.querySelectorAll('[data-user-initials]').forEach(function(el) {
        el.textContent = (profile.name || profile.full_name || 'U')[0].toUpperCase();
      });
    })
    .catch(function() {});
  }

  // Expose global refresh so profile page can call it after saving
  window.bConnectRefreshAvatar = loadUserAvatar;


  var BOTTOM_NAV_ITEMS = [
    {
      href: 'website.html',
      label: 'Home',
      match: ['website.html', 'index.html', ''],
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'
    },
    {
      href: 'products.html',
      label: 'Market',
      match: ['products.html'],
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>'
    },
    {
      href: 'services.html',
      label: 'Services',
      match: ['services.html'],
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>'
    },
    {
      href: 'housing.html',
      label: 'Housing',
      match: ['housing.html', 'tenant.html', 'tenant-dashboard.html', 'tenant-portal.html', 'landlord.html'],
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>'
    },
    {
      href: 'events.html',
      label: 'Events',
      match: ['events.html'],
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      moreOnly: true
    }
  ];

  var MORE_ITEMS = [
    { href: 'events.html',          label: 'Events & Tickets',  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
    { href: 'orders.html',          label: 'My Orders',         icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>' },
    { href: 'cart.html',            label: 'My Cart',           icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>' },
    { href: 'seller-dashboard.html',label: 'Sell / My Listings',icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
    { href: 'payrent.html',         label: 'Pay Rent',          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>' },
    { href: 'ai-assistant.html',    label: 'AI Assistant',      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
    { href: 'tenant-dashboard.html',label: 'Tenant Dashboard',  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
    { href: 'landlord-dashboard.html', label: 'Landlord Dashboard', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
    { href: 'support.html',         label: 'Support',           icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' },
    { href: 'contact.html',         label: 'Contact Us',        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.84a16 16 0 0 0 8.25 8.25l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>' }
  ];

  var BOTTOM_NAV_STYLE =
    /* ── Nav shell: frosted glass with gradient top border ── */
    '#bc-bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;z-index:9100;' +
      'background:rgba(255,255,255,.92);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);' +
      'border-top:2px solid transparent;' +
      'background-clip:padding-box;' +
      'box-shadow:0 -6px 32px rgba(15,41,114,.12),0 -1px 0 rgba(99,102,241,.15);' +
      'padding-bottom:env(safe-area-inset-bottom,0)}' +
    /* gradient accent line across top */
    '#bc-bottom-nav::before{content:"";position:absolute;top:-2px;left:0;right:0;height:2px;' +
      'background:linear-gradient(90deg,#6366f1,#3b82f6,#06b6d4);border-radius:0}' +
    '#bc-bottom-nav ul{display:flex;margin:0;padding:0 4px;list-style:none;height:64px}' +
    '#bc-bottom-nav ul li{flex:1;display:flex}' +

    /* ── Tap targets ── */
    '#bc-bottom-nav ul li a,#bc-bottom-nav ul li button.bc-more-btn{' +
      'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;' +
      'color:#94a3b8;text-decoration:none;font-family:Inter,system-ui,-apple-system,sans-serif;' +
      'font-size:.6rem;font-weight:700;letter-spacing:.02em;text-transform:uppercase;' +
      'transition:color .2s,transform .15s;-webkit-tap-highlight-color:transparent;' +
      'padding:6px 4px;background:none;border:none;cursor:pointer;width:100%;position:relative}' +

    /* ── Icon wrapper (pill shown when active) ── */
    '#bc-bottom-nav ul li a .bc-nav-icon,#bc-bottom-nav ul li button.bc-more-btn .bc-nav-icon{' +
      'display:flex;align-items:center;justify-content:center;' +
      'width:42px;height:26px;border-radius:13px;' +
      'transition:background .2s,box-shadow .2s;margin-bottom:1px}' +

    '#bc-bottom-nav ul li a svg,#bc-bottom-nav ul li button.bc-more-btn svg{' +
      'transition:stroke .2s,transform .2s;flex-shrink:0}' +

    /* ── Hover ── */
    '#bc-bottom-nav ul li a:hover,#bc-bottom-nav ul li button.bc-more-btn:hover{color:#6366f1}' +
    '#bc-bottom-nav ul li a:hover .bc-nav-icon,#bc-bottom-nav ul li button.bc-more-btn:hover .bc-nav-icon{background:rgba(99,102,241,.1)}' +
    '#bc-bottom-nav ul li a:hover svg,#bc-bottom-nav ul li button.bc-more-btn:hover svg{stroke:#6366f1;transform:translateY(-1px)}' +

    /* ── Active: gradient pill + colored icon + brighter label ── */
    '#bc-bottom-nav ul li a.active,#bc-bottom-nav ul li button.bc-more-btn.active{color:#4f46e5}' +
    '#bc-bottom-nav ul li a.active .bc-nav-icon,#bc-bottom-nav ul li button.bc-more-btn.active .bc-nav-icon{' +
      'background:linear-gradient(135deg,#6366f1,#3b82f6);' +
      'box-shadow:0 4px 12px rgba(99,102,241,.35)}' +
    '#bc-bottom-nav ul li a.active svg,#bc-bottom-nav ul li button.bc-more-btn.active svg{stroke:#fff}' +

    /* ── More overlay + drawer ── */
    '#bc-more-overlay{display:none;position:fixed;inset:0;z-index:9150;background:rgba(15,23,42,.5);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}' +
    '#bc-more-overlay.open{display:block}' +
    '#bc-more-drawer{position:fixed;bottom:0;left:0;right:0;z-index:9200;' +
      'background:#fff;border-radius:24px 24px 0 0;' +
      'padding:0 0 env(safe-area-inset-bottom,20px);' +
      'transform:translateY(100%);transition:transform .35s cubic-bezier(.32,1,.23,1);' +
      'max-height:82vh;overflow-y:auto;' +
      'box-shadow:0 -16px 64px rgba(15,23,42,.2)}' +
    '#bc-more-drawer.open{transform:translateY(0)}' +
    '#bc-more-handle{width:44px;height:5px;background:linear-gradient(90deg,#6366f1,#3b82f6);border-radius:99px;margin:14px auto 6px;opacity:.5}' +
    '#bc-more-title{font-family:Inter,system-ui,sans-serif;font-size:.72rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em;padding:2px 20px 14px}' +
    '#bc-more-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:0 16px 24px}' +

    /* ── More grid items ── */
    '.bc-more-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px 8px 14px;border-radius:18px;' +
      'background:linear-gradient(145deg,#f8fafc,#f1f5f9);' +
      'text-decoration:none;color:#334155;font-family:Inter,system-ui,sans-serif;' +
      'font-size:.68rem;font-weight:700;text-align:center;' +
      '-webkit-tap-highlight-color:transparent;transition:all .18s cubic-bezier(.34,1.56,.64,1);' +
      'border:1.5px solid rgba(99,102,241,.1);box-shadow:0 2px 8px rgba(15,23,42,.06)}' +
    '.bc-more-item:hover,.bc-more-item:active{' +
      'background:linear-gradient(135deg,#eef2ff,#e0e7ff);color:#4f46e5;' +
      'border-color:#a5b4fc;box-shadow:0 6px 20px rgba(99,102,241,.2);transform:translateY(-2px) scale(1.03)}' +
    '.bc-more-item .bc-more-icon{width:44px;height:44px;border-radius:14px;' +
      'background:linear-gradient(135deg,#f0f4ff,#e8edff);' +
      'display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 2px 8px rgba(99,102,241,.12);transition:all .18s}' +
    '.bc-more-item:hover .bc-more-icon,.bc-more-item:active .bc-more-icon{' +
      'background:linear-gradient(135deg,#6366f1,#3b82f6);box-shadow:0 4px 14px rgba(99,102,241,.35)}' +
    '.bc-more-item svg{flex-shrink:0;stroke:#6366f1;transition:stroke .18s}' +
    '.bc-more-item:hover svg,.bc-more-item:active svg{stroke:#fff}' +

    '@media(max-width:640px){#bc-bottom-nav{display:block}body{padding-bottom:64px!important}}' +
    '@media(max-width:640px){#bc-ai-fab{bottom:78px!important;right:14px!important}}' +
    '@media(max-width:480px){#bc-chat-panel{bottom:142px!important}}';

  function buildBottomNav() {
    if (document.getElementById('bc-bottom-nav')) return;

    var token = localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('auth_token') || localStorage.getItem('landlordToken');
    if (!token) return;

    var page = currentPage();

    var styleEl = document.createElement('style');
    styleEl.id = 'bc-bottom-nav-style';
    styleEl.textContent = BOTTOM_NAV_STYLE;
    document.head.appendChild(styleEl);

    var nav = document.createElement('nav');
    nav.id = 'bc-bottom-nav';
    nav.setAttribute('aria-label', 'Main navigation');

    var ul = document.createElement('ul');

    BOTTOM_NAV_ITEMS.filter(function(i) { return !i.moreOnly; }).forEach(function (item) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = item.href;
      var matches = item.match || [item.href];
      if (matches.indexOf(page) !== -1) a.className = 'active';
      a.innerHTML = '<span class="bc-nav-icon">' + item.icon + '</span><span>' + item.label + '</span>';
      li.appendChild(a);
      ul.appendChild(li);
    });

    var moreLi = document.createElement('li');
    var moreBtn = document.createElement('button');
    moreBtn.className = 'bc-more-btn';
    var morePages = MORE_ITEMS.map(function(i) { return i.href; });
    if (morePages.indexOf(page) !== -1) moreBtn.classList.add('active');
    moreBtn.innerHTML =
      '<span class="bc-nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></span>' +
      '<span>More</span>';
    moreLi.appendChild(moreBtn);
    ul.appendChild(moreLi);

    nav.appendChild(ul);
    document.body.appendChild(nav);

    var overlay = document.createElement('div');
    overlay.id = 'bc-more-overlay';
    document.body.appendChild(overlay);

    var drawer = document.createElement('div');
    drawer.id = 'bc-more-drawer';
    drawer.innerHTML = '<div id="bc-more-handle"></div><div id="bc-more-title">More options</div><div id="bc-more-grid"></div>';
    document.body.appendChild(drawer);

    var grid = drawer.querySelector('#bc-more-grid');
    MORE_ITEMS.forEach(function(item) {
      var a = document.createElement('a');
      a.className = 'bc-more-item';
      a.href = item.href;
      a.innerHTML = '<span class="bc-more-icon">' + item.icon + '</span><span>' + item.label + '</span>';
      grid.appendChild(a);
    });

    function openDrawer() {
      overlay.classList.add('open');
      drawer.classList.add('open');
    }
    function closeDrawer() {
      overlay.classList.remove('open');
      drawer.classList.remove('open');
    }

    moreBtn.addEventListener('click', function() {
      drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });
    overlay.addEventListener('click', closeDrawer);
  }

  // ---- Notification system ----
  var NOTIF_ICONS = {
    order:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
    sale:    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    housing: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    message: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    default: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  };

  function timeAgo(dateStr) {
    var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return Math.floor(diff/86400) + 'd ago';
  }

  function renderNotifications(notifications) {
    var list = document.getElementById('bc-notif-list');
    if (!list) return;
    if (!notifications || notifications.length === 0) {
      list.innerHTML = '<div style="padding:28px 18px;text-align:center;color:#9ca3af;font-size:.85rem;line-height:1.6">No notifications yet.<br>You\'ll see order updates, sales, and more here.</div>';
      return;
    }
    list.innerHTML = '';
    notifications.forEach(function(n) {
      var item = document.createElement('div');
      item.setAttribute('data-notif-id', n.id);
      item.setAttribute('style',
        'display:flex;gap:12px;align-items:flex-start;padding:13px 18px;cursor:pointer;border-bottom:1px solid #f8fafc;transition:background .12s;' +
        (n.is_read ? 'background:#fff' : 'background:#eff6ff')
      );
      item.onmouseover = function() { item.style.background = n.is_read ? '#f8fafc' : '#dbeafe'; };
      item.onmouseout  = function() { item.style.background = n.is_read ? '#fff' : '#eff6ff'; };

      var iconBox = document.createElement('div');
      iconBox.setAttribute('style', 'width:34px;height:34px;border-radius:10px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px');
      iconBox.innerHTML = NOTIF_ICONS[n.type] || NOTIF_ICONS['default'];

      var body = document.createElement('div');
      body.setAttribute('style', 'flex:1;min-width:0');
      body.innerHTML =
        '<div style="font-weight:' + (n.is_read ? '600' : '800') + ';font-size:.84rem;color:#111827;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (n.title || '') + '</div>' +
        '<div style="font-size:.78rem;color:#6b7280;line-height:1.45;margin-bottom:4px">' + (n.message || '') + '</div>' +
        '<div style="font-size:.72rem;color:#9ca3af">' + timeAgo(n.created_at) + '</div>';

      if (!n.is_read) {
        var dot = document.createElement('div');
        dot.setAttribute('style', 'width:8px;height:8px;background:#3b82f6;border-radius:50%;flex-shrink:0;margin-top:6px');
        item.appendChild(iconBox);
        item.appendChild(body);
        item.appendChild(dot);
      } else {
        item.appendChild(iconBox);
        item.appendChild(body);
      }

      item.addEventListener('click', function() {
        if (!n.is_read) {
          var authTok = localStorage.getItem('auth_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || localStorage.getItem('landlordToken');
          fetch('/api/notifications/' + n.id + '/read', {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + authTok, 'Content-Type': 'application/json' }
          }).catch(function(){});
          n.is_read = true;
          item.style.background = '#fff';
          var d = item.querySelector('[style*="8px;height:8px"]');
          if (d) d.remove();
          var bodyTitle = item.querySelector('div > div');
          if (bodyTitle) bodyTitle.style.fontWeight = '600';
          // Decrement badge
          var badge = document.getElementById('bc-notif-badge');
          if (badge) {
            var cur = parseInt(badge.textContent, 10) || 0;
            var next = Math.max(0, cur - 1);
            badge.textContent = next > 99 ? '99+' : String(next);
            badge.style.display = next > 0 ? 'block' : 'none';
          }
        }
      });
      list.appendChild(item);
    });
  }

  function fetchNotifications(silent) {
    var authTok = localStorage.getItem('auth_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || localStorage.getItem('landlordToken');
    if (!authTok) return;
    fetch('/api/notifications', {
      headers: { 'Authorization': 'Bearer ' + authTok, 'Content-Type': 'application/json' }
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.success) return;
      // Update badge
      var badge = document.getElementById('bc-notif-badge');
      if (badge) {
        var count = data.unread_count || 0;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = count > 0 ? 'block' : 'none';
      }
      // Re-render list if panel is open, or always cache
      window._bcNotifications = data.notifications;
      var panel = document.getElementById('bc-notif-panel');
      if (panel && panel.style.display === 'flex') {
        renderNotifications(data.notifications);
      }
    })
    .catch(function(){});
  }

  function initNotifications() {
    var bellBtn = document.getElementById('bc-notif-btn');
    var bellPanel = document.getElementById('bc-notif-panel');
    var markAllBtn = document.getElementById('bc-notif-markall');
    if (!bellBtn || !bellPanel) return;

    // Toggle panel
    bellBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = bellPanel.style.display === 'flex';
      if (isOpen) {
        bellPanel.style.display = 'none';
      } else {
        bellPanel.style.display = 'flex';
        renderNotifications(window._bcNotifications || null);
        fetchNotifications(false);
      }
    });

    // Close on outside click
    document.addEventListener('click', function(e) {
      var wrap = document.getElementById('bc-notif-wrap');
      if (wrap && !wrap.contains(e.target)) {
        bellPanel.style.display = 'none';
      }
    });

    // Mark all read
    if (markAllBtn) {
      markAllBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var authTok = localStorage.getItem('auth_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || localStorage.getItem('landlordToken');
        fetch('/api/notifications/mark-all-read', {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + authTok, 'Content-Type': 'application/json' }
        })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function() {
          var badge = document.getElementById('bc-notif-badge');
          if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
          if (window._bcNotifications) {
            window._bcNotifications.forEach(function(n) { n.is_read = true; });
            renderNotifications(window._bcNotifications);
          }
        })
        .catch(function(){});
      });
    }

    // Initial fetch + poll every 30s
    fetchNotifications(true);
    setInterval(function() { fetchNotifications(true); }, 30000);
  }

  // ── Modal swipe gestures ───────────────────────────────────────────────────
  function initModalSwipes() {
    if (document.getElementById('bc-modal-swipe-style')) return;

    var st = document.createElement('style');
    st.id = 'bc-modal-swipe-style';
    st.textContent =
      '@media(max-width:640px){' +
        '.modal-box::before{content:"";display:block;width:44px;height:5px;background:#d1d5db;border-radius:99px;margin:10px auto 4px;flex-shrink:0}' +
        '.modal-close{display:none!important}' +
        '.bc-modal-back{display:flex!important}' +
        '.modal-images,.modal-img-col{position:relative;overflow:hidden;touch-action:pan-y}' +
        '.bc-img-swipe-dots{display:flex;justify-content:center;gap:6px;margin-top:8px}' +
        '.bc-img-swipe-dot{width:7px;height:7px;border-radius:50%;background:rgba(0,0,0,.18);transition:background .2s,transform .2s;cursor:pointer}' +
        '.bc-img-swipe-dot.active{background:#3b82f6;transform:scale(1.25)}' +
      '}' +
      '.bc-modal-back{display:none;align-items:center;gap:8px;width:100%;padding:10px 16px 6px;background:transparent;border:none;border-bottom:1px solid #f1f5f9;cursor:pointer;font-family:Inter,system-ui,sans-serif;font-size:.92rem;font-weight:700;color:#374151;flex-shrink:0}' +
      '.bc-modal-back:active{background:#f9fafb}' +
      '.bc-modal-back svg{flex-shrink:0}';
    document.head.appendChild(st);

    var _swipeBox = null, _swipeBoxStartY = 0, _swipeDY = 0;
    var _swipeImg = null, _swipeImgStartX = 0, _swipeImgStartY = 0;

    document.addEventListener('touchstart', function(e) {
      var imgArea = e.target.closest('.modal-images,.modal-img-col');
      if (imgArea) {
        _swipeImg = imgArea;
        _swipeImgStartX = e.touches[0].clientX;
        _swipeImgStartY = e.touches[0].clientY;
      }

      var box = e.target.closest('.modal-box');
      if (box && !imgArea) {
        _swipeBox = box;
        _swipeBoxStartY = e.touches[0].clientY;
        _swipeDY = 0;
      }
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!_swipeBox) return;
      var dy = e.touches[0].clientY - _swipeBoxStartY;
      if (dy > 0) {
        _swipeDY = dy;
        _swipeBox.style.transform = 'translateY(' + dy + 'px)';
        _swipeBox.style.transition = 'none';
      }
    }, { passive: true });

    document.addEventListener('touchend', function(e) {
      // ── Image horizontal swipe ──────────────────────────────────────────
      if (_swipeImg) {
        var dx = e.changedTouches[0].clientX - _swipeImgStartX;
        var dy2 = e.changedTouches[0].clientY - _swipeImgStartY;
        _swipeImg = null;
        if (Math.abs(dx) > Math.abs(dy2) && Math.abs(dx) > 45) {
          var imgs = window._currentGalleryImages;
          if (imgs && imgs.length > 1) {
            var idx = window._currentGalleryIdx || 0;
            var next = dx < 0 ? Math.min(idx + 1, imgs.length - 1) : Math.max(idx - 1, 0);
            if (next !== idx) {
              var thumb = document.querySelectorAll('.modal-thumb')[next];
              if (thumb) {
                thumb.click();
              } else {
                var mi = document.getElementById('modal-img');
                if (mi) mi.src = imgs[next];
                window._currentGalleryIdx = next;
              }
              // Update dots
              document.querySelectorAll('.bc-img-swipe-dot').forEach(function(d, i) {
                d.classList.toggle('active', i === next);
              });
            }
          }
        }
        return;
      }

      // ── Swipe down to close ─────────────────────────────────────────────
      if (!_swipeBox) return;
      var box = _swipeBox;
      var dy = _swipeDY;
      _swipeBox = null;
      _swipeDY = 0;

      if (dy > 110) {
        box.style.transform = '';
        box.style.transition = '';
        var overlay = box.closest('.modal-overlay');
        if (overlay) {
          var closeBtn = overlay.querySelector('.modal-close');
          if (closeBtn) { closeBtn.click(); }
          else { overlay.classList.remove('open'); document.body.style.overflow = ''; }
        }
      } else {
        box.style.transition = 'transform .28s cubic-bezier(.34,1.56,.64,1)';
        box.style.transform = 'translateY(0)';
        setTimeout(function() { box.style.transform = ''; box.style.transition = ''; }, 300);
      }
    }, { passive: true });

    // Watch for modals opening to inject back button + swipe dots
    var _observer = new MutationObserver(function() {
      var openOverlay = document.querySelector('.modal-overlay.open');
      if (!openOverlay) return;
      var modalBox = openOverlay.querySelector('.modal-box');
      if (!modalBox) return;

      // Inject back button once per open
      if (!modalBox.querySelector('.bc-modal-back')) {
        var backBtn = document.createElement('button');
        backBtn.className = 'bc-modal-back';
        backBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back';
        backBtn.addEventListener('click', function() {
          var closeBtn = openOverlay.querySelector('.modal-close');
          if (closeBtn) { closeBtn.click(); }
          else { openOverlay.classList.remove('open'); document.body.style.overflow = ''; }
        });
        // Insert as first real child (after ::before pseudo-element)
        modalBox.insertBefore(backBtn, modalBox.firstChild);
      }

      // Inject swipe dots for multiple images
      var imgs = window._currentGalleryImages;
      if (!imgs || imgs.length < 2) return;
      var imageArea = openOverlay.querySelector('.modal-images,.modal-img-col');
      if (!imageArea) return;
      if (imageArea.querySelector('.bc-img-swipe-dots')) return;
      var dots = document.createElement('div');
      dots.className = 'bc-img-swipe-dots';
      dots.innerHTML = imgs.map(function(_, i) {
        return '<div class="bc-img-swipe-dot' + (i === 0 ? ' active' : '') + '" onclick="(function(){var t=document.querySelectorAll(\'.modal-thumb\')[' + i + '];if(t){t.click()}else{var mi=document.getElementById(\'modal-img\');if(mi)mi.src=window._currentGalleryImages[' + i + '];window._currentGalleryIdx=' + i + ';}document.querySelectorAll(\'.bc-img-swipe-dot\').forEach(function(d,j){d.classList.toggle(\'active\',j===' + i + ')});})()" ></div>';
      }).join('');
      imageArea.appendChild(dots);
    });
    _observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  function mount() {
    var SKIP_PAGES = ['admin.html', 'organizer-dashboard.html', 'seller-dashboard.html', 'landlord-dashboard.html', 'tenant-dashboard.html'];
    if (SKIP_PAGES.indexOf(currentPage()) !== -1) {
      var preHide = document.getElementById('bc-pre-hide');
      if (preHide) preHide.parentNode.removeChild(preHide);
      return;
    }
    injectStyle();
    removeExisting();
    wrapBodyContent();
    var header = buildHeader();
    var wrap = document.getElementById('bc-page-content');
    document.body.insertBefore(header, wrap);
    // Remove the flash-prevention style now that the new header is in place
    var preHide = document.getElementById('bc-pre-hide');
    if (preHide) preHide.parentNode.removeChild(preHide);
    // Load avatar after DOM is ready
    loadUserAvatar();
    initNotifications();
    buildBottomNav();
    initModalSwipes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
