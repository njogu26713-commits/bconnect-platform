(function () {
  'use strict';

  var API_BASE = window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : window.location.protocol + '//' + window.location.host;

  var _profile = null;

  function getToken() {
    return localStorage.getItem('token') || localStorage.getItem('authToken') ||
      localStorage.getItem('auth_token') || localStorage.getItem('landlordToken');
  }

  function getUser() {
    try {
      var u = localStorage.getItem('user') || localStorage.getItem('userProfile');
      return u ? JSON.parse(u) : null;
    } catch (e) { return null; }
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  function fetchProfile() {
    if (window.__bcProfileCache) return Promise.resolve(window.__bcProfileCache);
    var token = getToken();
    if (!token) return Promise.resolve(null);
    return fetch(API_BASE + '/api/profile', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d ? (d.profile || null) : null; })
      .catch(function () { return null; });
  }

  /* ── CSS ── */
  function injectCSS() {
    if (document.getElementById('bc-pw-css')) return;
    var s = document.createElement('style');
    s.id = 'bc-pw-css';
    s.textContent = [
      '.bc-pw-wrap{position:relative;display:inline-flex;align-items:center}',
      '.bc-pw-btn{display:flex;align-items:center;gap:7px;cursor:pointer;background:none;border:none;padding:0}',
      '.bc-pw-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:.78rem;font-weight:800;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;border:2px solid rgba(99,102,241,.25);box-shadow:0 2px 8px rgba(99,102,241,.22);transition:transform .2s,box-shadow .2s;cursor:pointer}',
      '.bc-pw-avatar:hover{transform:scale(1.08);box-shadow:0 4px 14px rgba(99,102,241,.38)}',
      '.bc-pw-avatar img{width:100%;height:100%;object-fit:cover;display:block}',

      '.bc-pw-drop{display:none;position:absolute;top:calc(100% + 10px);right:0;width:236px;background:#fff;border-radius:16px;box-shadow:0 14px 52px rgba(0,0,0,.18);border:1px solid #e5e7eb;z-index:99999;overflow:hidden;font-family:Inter,system-ui,sans-serif}',
      '.bc-pw-drop.open{display:block}',
      '.bc-pw-dhead{padding:15px 16px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;gap:10px}',
      '.bc-pw-dbig{width:40px;height:40px;border-radius:50%;flex-shrink:0;background:rgba(255,255,255,.28);display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:800;color:#fff;overflow:hidden;border:2px solid rgba(255,255,255,.4)}',
      '.bc-pw-dbig img{width:100%;height:100%;object-fit:cover;display:block}',
      '.bc-pw-dname{font-size:.88rem;font-weight:800;color:#fff;line-height:1.2;word-break:break-word}',
      '.bc-pw-drole{font-size:.7rem;color:rgba(255,255,255,.78);text-transform:capitalize;margin-top:1px}',

      '.bc-pw-ditem{display:flex;align-items:center;gap:10px;padding:11px 16px;font-size:.85rem;font-weight:600;color:#374151;cursor:pointer;transition:background .12s;border:none;background:none;width:100%;text-align:left;font-family:inherit;text-decoration:none}',
      '.bc-pw-ditem:hover{background:#f3f4f6;color:#111827}',
      '.bc-pw-ditem svg{flex-shrink:0;opacity:.6}',
      '.bc-pw-ddiv{height:1px;background:#f1f5f9;margin:3px 0}',
      '.bc-pw-dout{color:#dc2626}.bc-pw-dout svg{opacity:.85}',
      '.bc-pw-dout:hover{background:#fef2f2;color:#b91c1c}',

      /* modal */
      '.bc-pw-overlay{display:none;position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.48);align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif}',
      '.bc-pw-overlay.open{display:flex}',
      '.bc-pw-modal{background:#fff;border-radius:20px;width:100%;max-width:430px;margin:16px;box-shadow:0 24px 80px rgba(0,0,0,.25);overflow:hidden;max-height:92vh;overflow-y:auto}',
      '.bc-pw-mhead{padding:18px 22px 14px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between}',
      '.bc-pw-mhead h3{font-size:1.02rem;font-weight:800;color:#111827;margin:0}',
      '.bc-pw-mclose{width:28px;height:28px;border-radius:50%;border:none;background:#f3f4f6;cursor:pointer;font-size:1rem;color:#6b7280;display:flex;align-items:center;justify-content:center;transition:background .15s}',
      '.bc-pw-mclose:hover{background:#e5e7eb}',
      '.bc-pw-mbody{padding:18px 22px 22px}',
      '.bc-pw-avrow{display:flex;align-items:center;gap:13px;margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid #f8f9fa}',
      '.bc-pw-avbig{width:58px;height:58px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:1.2rem;font-weight:800;color:#fff;overflow:hidden;border:3px solid #e0e7ff}',
      '.bc-pw-avbig img{width:100%;height:100%;object-fit:cover;display:block}',
      '.bc-pw-avinfo strong{font-size:.9rem;font-weight:800;color:#111827;display:block}',
      '.bc-pw-avinfo small{font-size:.75rem;color:#9ca3af;text-transform:capitalize}',
      '.bc-pw-field{margin-bottom:12px}',
      '.bc-pw-label{display:block;font-size:.76rem;font-weight:700;color:#374151;margin-bottom:4px;letter-spacing:.02em}',
      '.bc-pw-input{width:100%;padding:9px 11px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:.86rem;color:#111827;font-family:inherit;background:#fafafa;transition:border-color .15s,box-shadow .15s;box-sizing:border-box}',
      '.bc-pw-input:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1);background:#fff}',
      '.bc-pw-actions{display:flex;gap:9px;margin-top:18px}',
      '.bc-pw-save{flex:1;padding:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:11px;font-size:.88rem;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity .2s}',
      '.bc-pw-save:hover{opacity:.88}.bc-pw-save:disabled{opacity:.55;cursor:not-allowed}',
      '.bc-pw-cancel{padding:10px 18px;background:#f3f4f6;color:#374151;border:none;border-radius:11px;font-size:.88rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}',
      '.bc-pw-cancel:hover{background:#e5e7eb}',
      '.bc-pw-msg{padding:9px 12px;border-radius:9px;font-size:.82rem;font-weight:600;margin-top:10px;display:none}',
      '.bc-pw-msg.ok{background:#d1fae5;color:#065f46;display:block}',
      '.bc-pw-msg.err{background:#fee2e2;color:#991b1b;display:block}',
      /* login ghost button */
      '.bc-pw-ghost{display:flex;align-items:center;gap:6px;padding:7px 14px;border:1.5px solid #e5e7eb;border-radius:10px;background:#fff;font-size:.84rem;font-weight:700;color:#374151;cursor:pointer;transition:border-color .15s,box-shadow .15s;font-family:inherit}',
      '.bc-pw-ghost:hover{border-color:#6366f1;color:#4f46e5;box-shadow:0 0 0 3px rgba(99,102,241,.08)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── Modal DOM ── */
  function buildModal() {
    if (document.getElementById('bc-pw-overlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'bc-pw-overlay';
    overlay.id = 'bc-pw-overlay';
    overlay.innerHTML =
      '<div class="bc-pw-modal">' +
        '<div class="bc-pw-mhead"><h3>Edit Profile</h3><button class="bc-pw-mclose" id="bc-pw-mclose">\u2715</button></div>' +
        '<div class="bc-pw-mbody">' +
          '<div class="bc-pw-avrow">' +
            '<div class="bc-pw-avbig" id="bc-pw-avprev"></div>' +
            '<div class="bc-pw-avinfo"><strong id="bc-pw-dname"></strong><small id="bc-pw-drole"></small></div>' +
          '</div>' +
          '<div class="bc-pw-field"><label class="bc-pw-label">Full Name</label><input id="bc-pw-name" class="bc-pw-input" type="text" placeholder="Your full name"></div>' +
          '<div class="bc-pw-field"><label class="bc-pw-label">Phone Number</label><input id="bc-pw-phone" class="bc-pw-input" type="tel" placeholder="07XX XXX XXX"></div>' +
          '<div class="bc-pw-field"><label class="bc-pw-label">Location</label><input id="bc-pw-loc" class="bc-pw-input" type="text" placeholder="e.g. Nairobi, Kenya"></div>' +
          '<div class="bc-pw-field"><label class="bc-pw-label">Profile Photo URL <span style="font-weight:400;color:#9ca3af">(optional)</span></label><input id="bc-pw-av" class="bc-pw-input" type="url" placeholder="https://..."></div>' +
          '<div class="bc-pw-actions"><button class="bc-pw-cancel" id="bc-pw-cancel">Cancel</button><button class="bc-pw-save" id="bc-pw-save">Save Changes</button></div>' +
          '<div class="bc-pw-msg" id="bc-pw-msg"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('bc-pw-mclose').addEventListener('click', closeModal);
    document.getElementById('bc-pw-cancel').addEventListener('click', closeModal);
    document.getElementById('bc-pw-save').addEventListener('click', saveProfile);
    document.getElementById('bc-pw-name').addEventListener('input', livePreview);
    document.getElementById('bc-pw-av').addEventListener('input', livePreview);
  }

  function livePreview() {
    var name = document.getElementById('bc-pw-name').value;
    var av   = document.getElementById('bc-pw-av').value;
    var prev = document.getElementById('bc-pw-avprev');
    var dn   = document.getElementById('bc-pw-dname');
    if (dn) dn.textContent = name || 'Your Name';
    if (prev) {
      if (av) {
        prev.innerHTML = '<img src="' + av + '" onerror="this.style.display=\'none\'">';
      } else {
        prev.textContent = getInitials(name);
      }
    }
  }

  function openModal() {
    document.querySelectorAll('.bc-pw-drop').forEach(function (d) { d.classList.remove('open'); });
    var overlay = document.getElementById('bc-pw-overlay');
    if (!overlay) return;
    var user    = getUser();
    var profile = _profile || {};
    var name    = profile.name || (user && (user.name || user.full_name)) || '';
    var phone   = profile.phone || (user && user.phone) || '';
    var loc     = profile.location || '';
    var av      = profile.avatar_url || (user && user.avatar_url) || '';
    var role    = profile.role || (user && user.role) || '';

    document.getElementById('bc-pw-name').value  = name;
    document.getElementById('bc-pw-phone').value = phone;
    document.getElementById('bc-pw-loc').value   = loc;
    document.getElementById('bc-pw-av').value    = av;
    document.getElementById('bc-pw-drole').textContent = role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member';
    document.getElementById('bc-pw-msg').className = 'bc-pw-msg';
    document.getElementById('bc-pw-msg').textContent = '';

    livePreview();
    overlay.classList.add('open');
  }

  function closeModal() {
    var overlay = document.getElementById('bc-pw-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function saveProfile() {
    var saveBtn = document.getElementById('bc-pw-save');
    var msg     = document.getElementById('bc-pw-msg');
    var token   = getToken();
    if (!token) {
      msg.textContent = 'You must be logged in.';
      msg.className = 'bc-pw-msg err';
      return;
    }
    var name  = document.getElementById('bc-pw-name').value.trim();
    var phone = document.getElementById('bc-pw-phone').value.trim();
    var loc   = document.getElementById('bc-pw-loc').value.trim();
    var av    = document.getElementById('bc-pw-av').value.trim();
    if (!name) { msg.textContent = 'Name cannot be empty.'; msg.className = 'bc-pw-msg err'; return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    fetch(API_BASE + '/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: name, phone: phone, location: loc, avatar_url: av })
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success) throw new Error(data.error || 'Update failed');
      _profile = data.profile;
      var user = getUser();
      if (user) { user.name = name; if (av) user.avatar_url = av; localStorage.setItem('user', JSON.stringify(user)); }
      refreshAvatars();
      msg.textContent = 'Profile updated!';
      msg.className = 'bc-pw-msg ok';
      saveBtn.textContent = 'Saved \u2713';
      setTimeout(function () { closeModal(); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }, 1400);
    })
    .catch(function (err) {
      msg.textContent = err.message || 'Failed to save.';
      msg.className = 'bc-pw-msg err';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    });
  }

  function avatarInnerHTML(name, av) {
    if (av) return '<img src="' + av + '" alt="' + name + '" onerror="this.style.display=\'none\'">';
    return getInitials(name);
  }

  function refreshAvatars() {
    var user = getUser();
    var p    = _profile || {};
    var name = p.name || (user && (user.name || user.full_name)) || '';
    var av   = p.avatar_url || (user && user.avatar_url) || '';
    var html = avatarInnerHTML(name, av);
    document.querySelectorAll('.bc-pw-avatar,.bc-pw-dbig,.bc-pw-avbig').forEach(function (el) { el.innerHTML = html; });
    document.querySelectorAll('.bc-pw-dname').forEach(function (el) { el.textContent = name; });
  }

  /* ── Widget DOM (logged-in) ── */
  function buildWidget(name, role, av) {
    var wrap = document.createElement('div');
    wrap.className = 'bc-pw-wrap';
    wrap.id = 'bc-profile-widget';
    var avHtml = avatarInnerHTML(name, av);
    wrap.innerHTML =
      '<button class="bc-pw-btn" id="bc-pw-toggle" title="My Profile" aria-label="Profile menu">' +
        '<div class="bc-pw-avatar">' + avHtml + '</div>' +
      '</button>' +
      '<div class="bc-pw-drop" id="bc-pw-drop">' +
        '<div class="bc-pw-dhead">' +
          '<div class="bc-pw-dbig">' + avHtml + '</div>' +
          '<div>' +
            '<div class="bc-pw-dname">' + (name || 'My Account') + '</div>' +
            '<div class="bc-pw-drole">' + (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member') + '</div>' +
          '</div>' +
        '</div>' +
        '<button class="bc-pw-ditem" id="bc-pw-edit">' +
          svgIcon('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z') +
          ' Edit Profile' +
        '</button>' +
        '<a class="bc-pw-ditem" href="orders.html">' +
          svgIcon('M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2|rect x=9 y=3 w=6 h=4 rx=1|M9 12h6M9 16h4') +
          ' My Orders' +
        '</a>' +
        '<a class="bc-pw-ditem" href="support.html">' +
          svgIcon('circle cx=12 cy=12 r=10|M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3|M12 17h.01') +
          ' Help &amp; Support' +
        '</a>' +
        '<div class="bc-pw-ddiv"></div>' +
        '<button class="bc-pw-ditem bc-pw-dout" id="bc-pw-out">' +
          svgIcon('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9') +
          ' Sign Out' +
        '</button>' +
      '</div>';

    wrap.querySelector('#bc-pw-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      wrap.querySelector('#bc-pw-drop').classList.toggle('open');
    });
    wrap.querySelector('#bc-pw-edit').addEventListener('click', function() {
      window.location.href = '/settings';
    });
    wrap.querySelector('#bc-pw-out').addEventListener('click', function () {
      if (confirm('Sign out of BConnect?')) {
        ['token','authToken','auth_token','userId','user','userProfile',
         'landlordToken','landlordId','landlordName','landlordEmail',
         'tenantToken','tenant_token','tenantId','tenantName','tenant_data'].forEach(function (k) { localStorage.removeItem(k); });
        window.location.href = 'website.html';
      }
    });
    document.addEventListener('click', function () {
      var d = wrap.querySelector('#bc-pw-drop');
      if (d) d.classList.remove('open');
    });
    return wrap;
  }

  function buildGuestButton() {
    var btn = document.createElement('a');
    btn.id = 'bc-profile-widget';
    btn.href = 'login.html';
    btn.setAttribute('style',
      'display:inline-flex;align-items:center;gap:6px;' +
      'padding:9px 20px;border-radius:10px;' +
      'background:#1e3a8a;color:#fff;' +
      'font-size:.9rem;font-weight:700;' +
      'text-decoration:none;cursor:pointer;' +
      'transition:background .2s;white-space:nowrap;' +
      'font-family:Inter,system-ui,sans-serif;' +
      'border:none;box-shadow:0 2px 8px rgba(30,58,138,.25)'
    );
    btn.innerHTML =
      svgIcon('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|circle cx=12 cy=7 r=4') +
      '<span>Sign In</span>';
    btn.addEventListener('mouseenter', function () { this.style.background = '#1e40af'; });
    btn.addEventListener('mouseleave', function () { this.style.background = '#1e3a8a'; });
    return btn;
  }

  function svgIcon(d) {
    var parts = d.split('|');
    var paths = parts.map(function (p) {
      if (p.startsWith('circle')) {
        var m = p.match(/cx=([\d.]+) cy=([\d.]+) r=([\d.]+)/);
        if (m) return '<circle cx="' + m[1] + '" cy="' + m[2] + '" r="' + m[3] + '"/>';
      }
      if (p.startsWith('rect')) {
        var m2 = p.match(/x=([\d.]+) y=([\d.]+) w=([\d.]+) h=([\d.]+)(?: rx=([\d.]+))?/);
        if (m2) return '<rect x="' + m2[1] + '" y="' + m2[2] + '" width="' + m2[3] + '" height="' + m2[4] + '"' + (m2[5] ? ' rx="' + m2[5] + '"' : '') + '/>';
      }
      return '<path d="' + p + '"/>';
    }).join('');
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  /* ── Replace all slots ── */
  function installWidget(el) {
    var token = getToken();
    if (!token) {
      // Not logged in — ensure the Sign In button in the header is visible
      var btn = document.getElementById('bc-signin-btn');
      if (btn) btn.style.display = 'inline-flex';
      return;
    }
    // Logged in — hide Sign In button and show profile widget
    var btn = document.getElementById('bc-signin-btn');
    if (btn) btn.style.display = 'none';
    var user  = getUser();
    var p     = _profile || {};
    var name  = p.name || (user && (user.name || user.full_name)) || '';
    var role  = p.role || (user && user.role) || '';
    var av    = p.avatar_url || (user && user.avatar_url) || '';
    el.replaceWith(buildWidget(name, role, av));
  }

  /* ── Main entry ── */
  function init() {
    injectCSS();
    buildModal();
    var token = getToken();

    var run = function () {
      /* 1. Named slots */
      document.querySelectorAll('#bc-profile-slot, .bc-profile-slot').forEach(installWidget);

      /* 2. website.html static avatar div */
      var staticAv = document.querySelector('.avatar');
      if (staticAv && !staticAv.closest('#bc-profile-widget') && !staticAv.id) {
        installWidget(staticAv);
      }

      /* 3. products/services/housing Account icon-btn */
      document.querySelectorAll('.nav-icons .icon-btn[title="Account"]').forEach(installWidget);

      /* 4. shared-layout logout button */
      var logoutBtn = document.querySelector('#bc-header button');
      if (logoutBtn && logoutBtn.textContent.trim() === 'Logout') {
        if (token) installWidget(logoutBtn);
      }
    };

    if (token) {
      fetchProfile().then(function (p) {
        _profile = p;
        if (!p) {
          // Token is invalid/expired — clear stale auth data so Sign In button shows
          ['token','authToken','auth_token','userId','user','userProfile',
           'landlordToken','landlordId','tenantToken','tenant_token','tenantId'].forEach(function(k) {
            try { localStorage.removeItem(k); } catch(e) {}
          });
          try { sessionStorage.removeItem('auth_token'); } catch(e) {}
        }
        run();
      });
    } else {
      run();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); });
  } else {
    setTimeout(init, 0);
  }

  /* Re-run after shared-layout may have injected its header */
  window.addEventListener('load', function () {
    var hasWidget = document.getElementById('bc-profile-widget');
    var hasSlot   = document.getElementById('bc-profile-slot');
    var hasSignin = document.getElementById('bc-signin-default');
    if (!hasWidget && !hasSignin && hasSlot) { init(); }
  });

})();
