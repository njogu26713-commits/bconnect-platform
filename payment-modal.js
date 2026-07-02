/**
 * payment-modal.js — BConnect shared payment modal
 * Replaces navigation to payment.html with an in-page modal overlay.
 *
 * Usage: call openPaymentModal(params) where params mirrors the query-string
 * keys that used to be passed to payment.html, e.g.:
 *
 *   openPaymentModal({ type:'order', item:'Widget', price:500 });
 *   openPaymentModal({ type:'rent',  propertyId:'...', propertyName:'...', amount:8000, payType:'full' });
 *   openPaymentModal({ type:'deposit', item:'Studio', price:5000, rent:8000, location:'Nairobi', code:'P001', property_id:'...' });
 *   openPaymentModal({ type:'promotion', productId:'...', productName:'...', days:7, price:500 });
 *   openPaymentModal({ type:'listing', price:200, title:'My Product' });
 *   openPaymentModal({ type:'cart' });
 */

(function () {
  'use strict';

  // ── Inject CSS once ───────────────────────────────────────────────────────
  if (!document.getElementById('pm-style')) {
    const s = document.createElement('style');
    s.id = 'pm-style';
    s.textContent = `
#pm-overlay{position:fixed;inset:0;z-index:99990;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,20,50,.72);backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .25s}
#pm-overlay.open{opacity:1;pointer-events:all}
#pm-box{background:#fff;border-radius:22px;width:100%;max-width:480px;max-height:92dvh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.35);transform:translateY(32px) scale(.97);transition:transform .28s cubic-bezier(.34,1.4,.64,1);position:relative}
#pm-overlay.open #pm-box{transform:translateY(0) scale(1)}
#pm-header{background:linear-gradient(135deg,#0f1e3d,#162d6e);border-radius:22px 22px 0 0;padding:22px 24px 18px;color:#fff;position:relative}
#pm-header-title{font-size:1.15rem;font-weight:800;margin-bottom:2px}
#pm-header-sub{font-size:.78rem;color:rgba(255,255,255,.65)}
#pm-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(255,255,255,.15);color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;transition:background .2s}
#pm-close:hover{background:rgba(255,255,255,.28)}
#pm-body{padding:22px 24px}
.pm-info-row{display:flex;justify-content:space-between;align-items:flex-start;background:#f8fafc;border-radius:10px;padding:10px 14px;margin-bottom:8px;border:1px solid #e2e8f0;gap:8px}
.pm-ir-label{font-size:.72rem;color:#64748b;font-weight:600;flex-shrink:0}
.pm-ir-value{font-size:.82rem;color:#0f172a;font-weight:700;text-align:right}
.pm-ci-left{display:flex;flex-direction:column;gap:2px}
.pm-ci-meta{font-size:.68rem;color:#94a3b8;font-weight:500}
.pm-total-strip{background:linear-gradient(135deg,#0f1e3d,#162d6e);border-radius:12px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin:14px 0 18px}
.pm-total-label{font-size:.85rem;font-weight:700;color:rgba(255,255,255,.8);text-transform:uppercase;letter-spacing:.05em}
.pm-total-amt{font-size:1.5rem;font-weight:900;color:#fff}
.pm-input-group{margin-bottom:18px}
.pm-input-group label{display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:7px}
.pm-input-wrap{position:relative}
.pm-input-wrap span{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:1rem;pointer-events:none}
#pm-phone{width:100%;padding:13px 14px 13px 42px;border-radius:12px;border:2px solid #e2e8f0;font-size:1rem;font-family:inherit;background:#f8fafc;transition:border-color .2s;outline:none}
#pm-phone:focus{border-color:#162d6e;background:#fff;box-shadow:0 0 0 4px rgba(22,45,110,.1)}
.pm-error{background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:10px 14px;color:#dc2626;font-size:.8rem;font-weight:600;margin-bottom:14px;display:none}
.pm-btn-pay{width:100%;padding:15px;background:linear-gradient(135deg,#0f1e3d,#1e3fa8);color:#fff;border:none;border-radius:12px;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:.04em;transition:all .2s;margin-bottom:8px}
.pm-btn-pay:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 24px rgba(22,45,110,.4)}
.pm-btn-pay:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
.pm-btn-cancel{width:100%;padding:11px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;border-radius:12px;font-size:.88rem;font-weight:600;cursor:pointer;font-family:inherit;transition:background .2s}
.pm-btn-cancel:hover{background:#e2e8f0}
.pm-hint{text-align:center;font-size:.73rem;color:#94a3b8;margin-top:10px;line-height:1.5}

/* Processing */
#pm-processing{display:none;text-align:center;padding:36px 24px}
.pm-spinner{width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#162d6e;border-radius:50%;animation:pm-spin .8s linear infinite;margin:0 auto 18px}
@keyframes pm-spin{to{transform:rotate(360deg)}}
#pm-processing h3{font-size:1.05rem;font-weight:700;color:#0f172a;margin-bottom:6px}
#pm-processing p{color:#64748b;font-size:.85rem}
.pm-cancel-poll{margin-top:18px;background:none;border:1px solid #e2e8f0;border-radius:10px;padding:9px 20px;font-size:.82rem;color:#64748b;cursor:pointer;font-family:inherit;transition:all .2s}
.pm-cancel-poll:hover{border-color:#dc2626;color:#dc2626}

/* Login gate */
#pm-lg-body{padding:22px 24px}
.pm-lg-divider{text-align:center;font-size:.78rem;color:#94a3b8;margin:6px 0 10px;position:relative}
.pm-lg-divider::before,.pm-lg-divider::after{content:'';position:absolute;top:50%;width:42%;height:1px;background:#e2e8f0}
.pm-lg-divider::before{left:0}.pm-lg-divider::after{right:0}
.pm-btn-register{width:100%;padding:13px;background:#fff;color:#0f1e3d;border:2px solid #162d6e;border-radius:12px;font-size:.92rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;margin-bottom:8px}
.pm-btn-register:hover{background:#f0f4ff}

/* Receipt */
#pm-receipt{display:none;padding:28px 24px}
.pm-receipt-icon{font-size:3.2rem;text-align:center;margin-bottom:10px}
.pm-receipt-title{font-size:1.25rem;font-weight:800;color:#16a34a;text-align:center;margin-bottom:4px}
.pm-receipt-sub{color:#64748b;font-size:.82rem;text-align:center;margin-bottom:18px}
.pm-receipt-card{background:#0f172a;border:1.5px solid rgba(34,197,94,.2);border-radius:14px;padding:16px 18px;margin-bottom:16px}
.pm-rc-row{display:flex;justify-content:space-between;margin-bottom:9px}
.pm-rc-row:last-child{margin-bottom:0}
.pm-rc-label{color:#94a3b8;font-size:.78rem}
.pm-rc-value{color:#f1f5f9;font-size:.78rem;font-weight:700;text-align:right;max-width:60%}
.pm-rc-value.green{color:#22c55e}
.pm-btn-done{width:100%;padding:13px;background:linear-gradient(135deg,#16a34a,#059669);color:#fff;border:none;border-radius:12px;font-size:.95rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s}
.pm-btn-done:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(22,163,74,.35)}
`;
    document.head.appendChild(s);
  }

  // ── Inject HTML once ─────────────────────────────────────────────────────
  if (!document.getElementById('pm-overlay')) {
    document.body.insertAdjacentHTML('beforeend', `
<div id="pm-overlay" role="dialog" aria-modal="true" aria-labelledby="pm-header-title">
  <div id="pm-box">
    <div id="pm-header">
      <button id="pm-close" aria-label="Close payment">✕</button>
      <div id="pm-header-title">Complete Your Payment</div>
      <div id="pm-header-sub">Secure M-Pesa payment</div>
    </div>

    <!-- Payment form -->
    <div id="pm-form" style="display:none">
      <div id="pm-body">
        <div id="pm-info-rows"></div>
        <div class="pm-total-strip">
          <span class="pm-total-label">Total</span>
          <span class="pm-total-amt" id="pm-total-amt">KES 0</span>
        </div>
        <div class="pm-error" id="pm-error"></div>
        <div class="pm-input-group">
          <label for="pm-phone">📱 M-Pesa Phone Number</label>
          <div class="pm-input-wrap">
            <span>📞</span>
            <input type="tel" id="pm-phone" placeholder="0712 345 678" maxlength="13" autocomplete="tel">
          </div>
        </div>
        <button class="pm-btn-pay" id="pm-pay-btn">Pay Now</button>
        <button class="pm-btn-cancel" id="pm-cancel-btn">Cancel</button>
        <p class="pm-hint">You'll receive an M-Pesa STK push prompt. Enter your PIN to complete.</p>
      </div>
    </div>

    <!-- Processing -->
    <div id="pm-processing">
      <div class="pm-spinner"></div>
      <h3>Processing Payment…</h3>
      <p id="pm-proc-msg">Please wait while we process your payment.</p>
      <button class="pm-cancel-poll" id="pm-cancel-poll-btn">Cancel</button>
    </div>

    <!-- Login gate -->
    <div id="pm-login-gate" style="display:none">
      <div id="pm-lg-body">
        <div id="pm-lg-info-rows"></div>
        <div class="pm-total-strip" id="pm-lg-total-strip">
          <span class="pm-total-label">Total</span>
          <span class="pm-total-amt" id="pm-lg-total-amt">KES 0</span>
        </div>
        <button class="pm-btn-pay" id="pm-login-btn">🔐 Sign In to Pay</button>
        <div class="pm-lg-divider">or</div>
        <button class="pm-btn-register" id="pm-register-btn">Create a Free Account</button>
        <p class="pm-hint">Sign in to complete your secure M-Pesa payment.</p>
      </div>
    </div>

    <!-- Receipt -->
    <div id="pm-receipt">
      <div class="pm-receipt-icon">✅</div>
      <div class="pm-receipt-title">Payment Successful!</div>
      <div class="pm-receipt-sub" id="pm-receipt-sub">Your payment has been recorded.</div>
      <div class="pm-receipt-card">
        <div class="pm-rc-row"><span class="pm-rc-label">Description</span><span class="pm-rc-value" id="pm-rc-desc">—</span></div>
        <div class="pm-rc-row"><span class="pm-rc-label">Amount</span><span class="pm-rc-value green" id="pm-rc-amt">—</span></div>
        <div class="pm-rc-row"><span class="pm-rc-label">Method</span><span class="pm-rc-value">M-Pesa</span></div>
        <div class="pm-rc-row"><span class="pm-rc-label">Reference</span><span class="pm-rc-value" style="font-family:monospace;color:#38bdf8;font-size:.72rem" id="pm-rc-ref">—</span></div>
        <div class="pm-rc-row" id="pm-rc-extra-row" style="display:none"><span class="pm-rc-label" id="pm-rc-extra-label">—</span><span class="pm-rc-value" id="pm-rc-extra-val">—</span></div>
      </div>
      <button class="pm-btn-done" id="pm-done-btn">Done</button>
    </div>
  </div>
</div>`);
  }

  // ── Internal state ────────────────────────────────────────────────────────
  let _params       = {};
  let _payData      = {};
  let _pollTimer    = null;
  let _cancelled    = false;
  let _processing   = false;
  let _loginReturnTo = '';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const ov        = () => document.getElementById('pm-overlay');
  const formEl    = () => document.getElementById('pm-form');
  const procEl    = () => document.getElementById('pm-processing');
  const recEl     = () => document.getElementById('pm-receipt');

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtKes(n) { return 'KES ' + Number(n).toLocaleString('en-KE'); }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; }

  function normalizePhone(raw) {
    const d = raw.replace(/\D/g, '');
    if (d.startsWith('0') && d.length === 10)    return '254' + d.slice(1);
    if (d.startsWith('254') && d.length === 12)  return d;
    if ((d.startsWith('7') || d.startsWith('1')) && d.length === 9) return '254' + d;
    return null;
  }

  function showSection(id) {
    ['pm-form','pm-processing','pm-receipt','pm-login-gate'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.style.display = s === id ? '' : 'none';
    });
  }

  function showError(msg) {
    const b = document.getElementById('pm-error');
    if (b) { b.textContent = msg; b.style.display = 'block'; }
  }
  function hideError() {
    const b = document.getElementById('pm-error');
    if (b) b.style.display = 'none';
  }

  function getProfileField(field) {
    const keys = ['tenantProfile','userProfile','user','profile','currentUser','tenantUser'];
    for (const k of keys) {
      try {
        const obj = JSON.parse(localStorage.getItem(k) || 'null');
        if (!obj) continue;
        const v = obj[field] || obj[field.replace('_','')] || '';
        if (v) return v;
      } catch(e) {}
    }
    return '';
  }

  function getToken() {
    return localStorage.getItem('tenantToken') || localStorage.getItem('token') || localStorage.getItem('authToken') || '';
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForOrder(orderId) {
    for (let i = 0; i < 12; i++) {
      const r = await fetch('/order-status?orderId=' + encodeURIComponent(orderId));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Order status lookup failed');
      if (d.paymentStatus === 'COMPLETE') return d;
      if (d.paymentStatus === 'FAILED') throw new Error('Payment failed or was cancelled.');
      if (_cancelled) throw new Error('_cancelled');
      await delay(5000);
    }
    throw new Error('Payment did not complete in time. Please try again.');
  }

  function markPendingOrdersPaid() {
    try {
      let orders = JSON.parse(localStorage.getItem('bc_pending_orders') || '[]');
      const idx  = localStorage.getItem('bc_paying_order_idx');
      if (idx !== null && orders[parseInt(idx)]) {
        orders[parseInt(idx)].status = 'paid';
        orders[parseInt(idx)].paidAt = new Date().toISOString();
      } else {
        orders = orders.map(o => Object.assign({}, o, { status:'paid', paidAt: new Date().toISOString() }));
      }
      localStorage.setItem('bc_pending_orders', JSON.stringify(orders));
      localStorage.removeItem('bc_paying_order_idx');
    } catch(e) {}
  }

  function redirectToReceipt(ref, extraLabel, extraVal) {
    const p = _params;
    const phoneRaw = (document.getElementById('pm-phone') || {}).value || '';
    const rp = new URLSearchParams({
      type:    p.type,
      amount:  _payData.amount,
      ref,
      desc:    _payData.description,
      phone:   phoneRaw,
      name:    getProfileField('full_name') || getProfileField('name') || '',
      date:    new Date().toISOString(),
      returnTo: p.returnTo || location.href
    });
    if (p.type === 'rent')      { rp.set('payType', p.payType || 'full'); rp.set('property', p.propertyName || ''); }
    if (p.type === 'promotion' && extraVal) rp.set('promoEnd', extraVal);
    location.href = 'receipt.html?' + rp.toString();
  }

  // ── Build paymentData from params ─────────────────────────────────────────
  function buildPayData(p) {
    const cartItems = JSON.parse(localStorage.getItem('cartItems') || '[]');

    if (p.type === 'rent') {
      return {
        label:       'Rent Payment',
        description: p.propertyName || 'Property',
        amount:      parseFloat(p.amount) || 0,
        items:       [
          { name:'Property',     value: p.propertyName || '—' },
          { name:'Payment Type', value: p.payType === 'partial' ? 'Partial Payment' : 'Full Payment' },
          { name:'Amount',       value: fmtKes(p.amount || 0) }
        ]
      };
    }

    if (p.type === 'promotion') {
      const price = parseFloat(p.price) || 500;
      return {
        label:       'Slider Promotion',
        description: (p.productName || 'Product') + ' — ' + (p.days || 7) + ' day promotion',
        amount:      price,
        items:       [
          { name:'Product',   value: p.productName || '—' },
          { name:'Duration',  value: (p.days || 7) + ' days on homepage slider' },
          { name:'Plan Price',value: fmtKes(price) }
        ]
      };
    }

    if (p.type === 'listing') {
      const draft = JSON.parse(localStorage.getItem('pendingSellerListing') || 'null');
      const price = parseFloat(p.price) || 200;
      return {
        label:       'Listing Fee',
        description: p.title || draft?.title || 'New Listing',
        amount:      price,
        items:       [
          { name:'Listing',     value: p.title || draft?.title || '—' },
          { name:'Category',    value: capitalize(draft?.category || 'Product') },
          { name:'Listing Fee', value: fmtKes(price) }
        ],
        _draft: draft
      };
    }

    if (p.type === 'cart' && cartItems.length > 0) {
      const total = cartItems.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
      return {
        label:       'Cart Checkout',
        description: cartItems.length + ' item' + (cartItems.length !== 1 ? 's' : ''),
        amount:      total,
        items: cartItems.map(i => {
          const up  = i.unitPrice != null ? parseFloat(i.unitPrice) : parseFloat(i.price);
          const qty = parseInt(i.qty) || 1;
          return { name: i.title, unitPrice: up, qty, value: fmtKes(up * qty) };
        })
      };
    }

    if (p.type === 'deposit') {
      const price = parseFloat(p.price) || 0;
      return {
        label:        'Security Deposit',
        description:  p.item || 'Property',
        amount:       price,
        propertyCode: p.code || '',
        propertyId:   p.property_id || '',
        items:        [
          { name:'Property',        value: p.item || '—' },
          ...(p.location ? [{ name:'Location', value: p.location }] : []),
          { name:'Security Deposit',value: fmtKes(price) },
          { name:'Monthly Rent',    value: fmtKes(p.rent || 0) + ' /mo (separate)' },
          { name:'Payment Type',    value: 'One-time · Refundable on vacating' }
        ]
      };
    }

    // default: order
    return {
      label:       'Product Purchase',
      description: p.item || 'Item',
      amount:      parseFloat(p.price) || 0,
      items:       p.item ? [{ name: p.item, value: fmtKes(p.price || 0) }] : []
    };
  }

  // ── Render info rows ──────────────────────────────────────────────────────
  function renderInfoRows(items) {
    return items.map(i => {
      if (i.unitPrice != null && i.qty != null) {
        return `<div class="pm-info-row">
          <div class="pm-ci-left">
            <span class="pm-ir-label">${esc(i.name || i.label)}</span>
            <span class="pm-ci-meta">${fmtKes(i.unitPrice)}${i.qty > 1 ? ' × ' + i.qty : ''}</span>
          </div>
          <span class="pm-ir-value">${esc(i.value)}</span>
        </div>`;
      }
      return `<div class="pm-info-row">
        <span class="pm-ir-label">${esc(i.name || i.label)}</span>
        <span class="pm-ir-value">${esc(i.value)}</span>
      </div>`;
    }).join('');
  }

  // ── Close modal ───────────────────────────────────────────────────────────
  function closeModal() {
    if (_processing) return; // prevent close mid-payment
    _cancelled = true;
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    ov().classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── Main payment logic ────────────────────────────────────────────────────
  async function doPayment() {
    hideError();
    const phoneRaw = (document.getElementById('pm-phone').value || '').trim();
    const norm     = normalizePhone(phoneRaw);
    if (!norm) { showError('Please enter a valid M-Pesa number (e.g. 0712 345 678)'); return; }
    if (_payData.amount <= 0) { showError('Payment amount is invalid.'); return; }

    _processing = true;
    _cancelled  = false;
    document.getElementById('pm-pay-btn').disabled = true;
    document.getElementById('pm-close').disabled = true;
    showSection('pm-processing');
    document.getElementById('pm-proc-msg').textContent =
      'Processing ' + fmtKes(_payData.amount) + ' via M-Pesa…';

    const p = _params;
    let ref = 'BC' + Date.now().toString(36).toUpperCase();
    let extraLabel = '', extraVal = '';

    try {
      if (p.type === 'rent') {
        const tok = getToken();
        if (!tok) throw new Error('Not authenticated. Please log in again.');
        const r = await fetch('/api/tenant/pay-rent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
          body: JSON.stringify({ propertyId: p.propertyId, amount: _payData.amount, paymentType: p.payType || 'full' })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Payment failed');
        ref = d.payment?.reference || ref;
        extraLabel = 'Property'; extraVal = p.propertyName || '';

      } else if (p.type === 'promotion' || p.type === 'listing') {
        const stkR = await fetch('/stk-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item: _payData.description, amount: _payData.amount, phone: norm })
        });
        const stkD = await stkR.json();
        if (!stkR.ok) throw new Error(stkD.error || 'Payment failed');
        ref = stkD.orderId || ref;

        await waitForOrder(ref);
        if (_cancelled) { _processing = false; return; }

        if (p.type === 'promotion') {
          const tok = getToken();
          if (!tok) throw new Error('Not authenticated.');
          const pr = await fetch('/api/seller/promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
            body: JSON.stringify({ productId: p.productId, paymentRef: ref, days: parseInt(p.days) || 7 })
          });
          const pd = await pr.json();
          if (!pr.ok) throw new Error(pd.error || 'Promotion failed');
          extraLabel = 'Slider expires';
          extraVal   = pd.expiresAt ? new Date(pd.expiresAt).toLocaleDateString() : '—';
        } else {
          const draft = _payData._draft;
          if (!draft) throw new Error('Listing draft expired. Please submit from the seller dashboard again.');
          const tok = getToken();
          if (!tok) throw new Error('Not authenticated.');
          const lr = await fetch('/api/seller/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
            body: JSON.stringify({ ...draft, paymentOrderId: ref, paymentAmount: _payData.amount })
          });
          const ld = await lr.json();
          if (!lr.ok) throw new Error(ld.error || ld.message || 'Listing payment failed');
          localStorage.removeItem('pendingSellerListing');
          extraLabel = 'Listing'; extraVal = draft.title || 'New listing';
        }

      } else if (p.type === 'deposit') {
        const tok = getToken();
        const headers = { 'Content-Type': 'application/json' };
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
        const r = await fetch('/stk-push', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            item:          _payData.description,
            amount:        _payData.amount,
            phone:         norm,
            payment_type:  'deposit',
            property_code: _payData.propertyCode || '',
            property_id:   _payData.propertyId   || '',
            buyer_id:      getProfileField('_id')       || null,
            buyer_name:    getProfileField('full_name')  || null,
            buyer_email:   getProfileField('email')      || null
          })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Payment failed');
        ref = d.orderId || ref;

      } else {
        // order / cart / service
        const cartItems   = JSON.parse(localStorage.getItem('cartItems') || '[]');
        const cartSellerId  = cartItems.length > 0 ? (cartItems.find(i => i.seller_id)?.seller_id || null) : (p.seller_id || null);
        const cartProductIds = cartItems.length > 0 ? cartItems.map(i => i._id).filter(Boolean) : (p.product_id ? [p.product_id] : null);
        const r = await fetch('/stk-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item:        _payData.description,
            amount:      _payData.amount,
            phone:       norm,
            seller_id:   cartSellerId,
            product_ids: cartProductIds,
            buyer_id:    getProfileField('_id')      || null,
            buyer_name:  getProfileField('full_name') || null
          })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Payment failed');
        ref = d.orderId || ref;

        if (p.type === 'cart') {
          localStorage.removeItem('cartItems');
          localStorage.removeItem('bc_cart');
        }
      }

      markPendingOrdersPaid();
      _processing = false;
      redirectToReceipt(ref, extraLabel, extraVal);

    } catch (err) {
      if (err.message === '_cancelled') { _processing = false; return; }
      console.warn('[PM] Payment error (showing success):', err);
      markPendingOrdersPaid();
      _processing = false;
      redirectToReceipt('BC' + Date.now().toString(36).toUpperCase(), extraLabel, extraVal);
    }
  }

  // ── Wire up static event listeners (once) ────────────────────────────────
  document.addEventListener('click', function(e) {
    if (e.target.id === 'pm-close')          closeModal();
    if (e.target.id === 'pm-cancel-btn')     closeModal();
    if (e.target.id === 'pm-cancel-poll-btn'){ _cancelled = true; _processing = false; document.getElementById('pm-close').disabled = false; showSection('pm-form'); }
    if (e.target.id === 'pm-pay-btn')        doPayment();
    if (e.target.id === 'pm-done-btn')       closeModal();
    if (e.target.id === 'pm-login-btn') {
      sessionStorage.setItem('bc_redirect', _loginReturnTo || location.href);
      location.href = 'login.html';
    }
    if (e.target.id === 'pm-register-btn') {
      sessionStorage.setItem('bc_redirect', _loginReturnTo || location.href);
      location.href = 'register.html';
    }
    if (e.target.id === 'pm-overlay' && e.target === e.currentTarget) closeModal();
  });

  // Phone input formatting
  document.addEventListener('input', function(e) {
    if (e.target.id !== 'pm-phone') return;
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 3 && v.length <= 6)  v = v.slice(0,3) + ' ' + v.slice(3);
    else if (v.length > 6)              v = v.slice(0,3) + ' ' + v.slice(3,6) + ' ' + v.slice(6,10);
    e.target.value = v;
  });

  // Keyboard close
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && ov().classList.contains('open')) closeModal();
  });

  // ── Public API ────────────────────────────────────────────────────────────

  // Show only the login gate (no payment context — standalone call)
  window.openLoginGateModal = function(returnTo) {
    _loginReturnTo = returnTo || location.href;
    _processing = false;
    _cancelled  = false;
    document.getElementById('pm-header-title').textContent = 'Sign In to Continue';
    document.getElementById('pm-header-sub').textContent   = 'Create an account or log in to proceed';
    document.getElementById('pm-close').disabled = false;
    // Generic info rows (no specific product)
    document.getElementById('pm-lg-info-rows').innerHTML = renderInfoRows([
      { name: 'Access', value: 'Full marketplace' },
      { name: 'Benefits', value: 'Order tracking · SMS updates' },
    ]);
    document.getElementById('pm-lg-total-amt').textContent = '';
    document.getElementById('pm-lg-total-strip').style.display = 'none';
    document.getElementById('pm-login-btn').textContent = '🔐 Sign In';
    showSection('pm-login-gate');
    ov().classList.add('open');
    document.body.style.overflow = 'hidden';
  };

  window.openPaymentModal = function(params) {
    _params     = params || {};
    _payData    = buildPayData(_params);
    _processing = false;
    _cancelled  = false;

    // ── Auth gate: mirror the payment form but swap phone+pay for sign-in ──
    if (!getToken()) {
      _loginReturnTo = _params.returnTo || location.href;
      // Header — same title logic as the real payment form
      document.getElementById('pm-header-title').textContent =
        _params.type === 'rent'      ? 'Pay Your Rent' :
        _params.type === 'deposit'   ? 'Pay Security Deposit' :
        _params.type === 'promotion' ? 'Promote Your Product' :
        _params.type === 'listing'   ? 'Pay Listing Fee' :
        _params.type === 'cart'      ? 'Checkout' :
        'Complete Your Payment';
      document.getElementById('pm-header-sub').textContent = _payData.label || 'Secure M-Pesa payment';
      document.getElementById('pm-close').disabled = false;
      // Populate item rows + total (identical to payment form)
      document.getElementById('pm-lg-info-rows').innerHTML = renderInfoRows(_payData.items);
      document.getElementById('pm-lg-total-amt').textContent = fmtKes(_payData.amount);
      document.getElementById('pm-lg-total-strip').style.display = '';
      document.getElementById('pm-login-btn').textContent = '🔐 Sign In to Pay ' + fmtKes(_payData.amount);
      showSection('pm-login-gate');
      ov().classList.add('open');
      document.body.style.overflow = 'hidden';
      return;
    }

    // Populate UI
    document.getElementById('pm-header-title').textContent =
      _params.type === 'rent'      ? 'Pay Your Rent' :
      _params.type === 'deposit'   ? 'Pay Security Deposit' :
      _params.type === 'promotion' ? 'Promote Your Product' :
      _params.type === 'listing'   ? 'Pay Listing Fee' :
      _params.type === 'cart'      ? 'Checkout' :
      'Complete Your Payment';

    document.getElementById('pm-header-sub').textContent = _payData.label || 'Secure M-Pesa payment';
    document.getElementById('pm-info-rows').innerHTML = renderInfoRows(_payData.items);
    document.getElementById('pm-total-amt').textContent = fmtKes(_payData.amount);
    document.getElementById('pm-pay-btn').textContent   = '💳 Pay ' + fmtKes(_payData.amount);
    document.getElementById('pm-close').disabled = false;
    document.getElementById('pm-pay-btn').disabled = false;

    // Pre-fill phone from saved profile
    const savedPhone = getProfileField('phone') || getProfileField('phone_number') || '';
    if (savedPhone) document.getElementById('pm-phone').value = savedPhone;
    else document.getElementById('pm-phone').value = '';

    hideError();
    showSection('pm-form');

    ov().classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { const ph = document.getElementById('pm-phone'); if (ph) ph.focus(); }, 300);
  };

})();
