/* BConnect Custom Dialogs — replaces browser alert / confirm / prompt */
(function () {
  const CSS = `
  #bc-toast-container{position:fixed;top:20px;right:20px;z-index:999999;display:flex;flex-direction:column;gap:10px;max-width:340px;pointer-events:none;}
  .bc-toast{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.45;color:#fff;min-width:240px;pointer-events:all;animation:bc-tin .3s ease;}
  .bc-toast.bc-info   {background:#7c3aed;}
  .bc-toast.bc-success{background:#059669;}
  .bc-toast.bc-error  {background:#dc2626;}
  .bc-toast.bc-warning{background:#d97706;}
  .bc-toast-icon{font-size:18px;flex-shrink:0;margin-top:1px;}
  .bc-toast-msg{flex:1;}
  .bc-toast-x{cursor:pointer;opacity:.75;flex-shrink:0;line-height:1;font-size:16px;}
  .bc-toast-x:hover{opacity:1;}
  @keyframes bc-tin {from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
  @keyframes bc-tout{from{opacity:1;transform:none}to{opacity:0;transform:translateX(40px)}}

  #bc-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999998;display:flex;align-items:center;justify-content:center;padding:16px;animation:bc-fade .2s ease;}
  @keyframes bc-fade{from{opacity:0}to{opacity:1}}
  .bc-modal{background:#fff;border-radius:20px;padding:28px 24px 22px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.25);animation:bc-mscale .25s ease;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  @keyframes bc-mscale{from{opacity:0;transform:scale(.92) translateY(10px)}to{opacity:1;transform:none}}
  .bc-modal-icon{font-size:38px;text-align:center;margin-bottom:12px;}
  .bc-modal-title{font-size:16px;font-weight:700;color:#111;text-align:center;margin-bottom:6px;line-height:1.4;}
  .bc-modal-sub{font-size:13px;color:#6b7280;text-align:center;margin-bottom:20px;line-height:1.5;}
  .bc-modal-input{width:100%;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px 13px;font-size:14px;color:#111;outline:none;margin-bottom:18px;box-sizing:border-box;transition:border-color .2s;}
  .bc-modal-input:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.12);}
  .bc-modal-btns{display:flex;gap:10px;}
  .bc-btn{flex:1;padding:12px;border-radius:12px;border:none;cursor:pointer;font-size:14px;font-weight:700;transition:opacity .15s;}
  .bc-btn:hover{opacity:.85;}
  .bc-btn-cancel {background:#f3f4f6;color:#374151;}
  .bc-btn-ok     {background:#7c3aed;color:#fff;}
  .bc-btn-danger {background:#dc2626;color:#fff;}
  .bc-btn-sign   {background:#ef4444;color:#fff;}
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  /*  Toast  */
  const ICONS = { success:'', error:'', warning:'', info:'' };

  function getContainer() {
    let c = document.getElementById('bc-toast-container');
    if (!c) { c = document.createElement('div'); c.id = 'bc-toast-container'; document.body.appendChild(c); }
    return c;
  }

  window.bAlert = function (msg, type) {
    type = type || 'info';
    const c = getContainer();
    const t = document.createElement('div');
    t.className = 'bc-toast bc-' + type;
    t.innerHTML = `<span class="bc-toast-icon">${ICONS[type] || ''}</span><span class="bc-toast-msg">${msg}</span><span class="bc-toast-x" onclick="this.parentElement.remove()"></span>`;
    c.appendChild(t);
    setTimeout(function () {
      t.style.animation = 'bc-tout .3s ease forwards';
      setTimeout(function () { t.remove(); }, 300);
    }, 3800);
  };

  /*  Close backdrop  */
  function closeBackdrop() {
    const b = document.getElementById('bc-backdrop');
    if (b) b.remove();
  }

  /*  Confirm  */
  window.bConfirm = function (msg, opts) {
    opts = opts || {};
    const icon    = opts.icon    || (opts.danger ? '' : '');
    const title   = opts.title   || '';
    const okLabel = opts.okLabel || (opts.danger ? 'Delete' : 'Confirm');
    const okCls   = opts.danger  ? 'bc-btn-danger' : (opts.sign ? 'bc-btn-sign' : 'bc-btn-ok');

    return new Promise(function (resolve) {
      closeBackdrop();
      const bd = document.createElement('div');
      bd.id = 'bc-backdrop';
      bd.innerHTML = `
        <div class="bc-modal">
          <div class="bc-modal-icon">${icon}</div>
          ${title ? `<div class="bc-modal-title">${title}</div>` : ''}
          <div class="${title ? 'bc-modal-sub' : 'bc-modal-title'}">${msg}</div>
          <div class="bc-modal-btns">
            <button class="bc-btn bc-btn-cancel" id="bc-no">Cancel</button>
            <button class="bc-btn ${okCls}" id="bc-yes">${okLabel}</button>
          </div>
        </div>`;
      document.body.appendChild(bd);
      bd.addEventListener('click', function (e) { if (e.target === bd) { closeBackdrop(); resolve(false); } });
      document.getElementById('bc-no').onclick  = function () { closeBackdrop(); resolve(false); };
      document.getElementById('bc-yes').onclick = function () { closeBackdrop(); resolve(true); };
    });
  };

  /*  Prompt  */
  window.bPrompt = function (msg, defaultVal, placeholder) {
    defaultVal  = defaultVal  || '';
    placeholder = placeholder || 'Type here…';
    return new Promise(function (resolve) {
      closeBackdrop();
      const bd = document.createElement('div');
      bd.id = 'bc-backdrop';
      bd.innerHTML = `
        <div class="bc-modal">
          <div class="bc-modal-icon"></div>
          <div class="bc-modal-title">${msg}</div>
          <input class="bc-modal-input" id="bc-prompt-in" type="text" value="${defaultVal.replace(/"/g,'&quot;')}" placeholder="${placeholder}" />
          <div class="bc-modal-btns">
            <button class="bc-btn bc-btn-cancel" id="bc-no">Cancel</button>
            <button class="bc-btn bc-btn-ok" id="bc-yes">OK</button>
          </div>
        </div>`;
      document.body.appendChild(bd);
      setTimeout(function () { const el = document.getElementById('bc-prompt-in'); if (el) { el.focus(); el.select(); } }, 50);
      bd.addEventListener('click', function (e) { if (e.target === bd) { closeBackdrop(); resolve(null); } });
      document.getElementById('bc-no').onclick  = function () { closeBackdrop(); resolve(null); };
      document.getElementById('bc-yes').onclick = function () { closeBackdrop(); resolve(document.getElementById('bc-prompt-in').value); };
      document.getElementById('bc-prompt-in').addEventListener('keydown', function (e) {
        if (e.key === 'Enter')  { closeBackdrop(); resolve(e.target.value); }
        if (e.key === 'Escape') { closeBackdrop(); resolve(null); }
      });
    });
  };
})();
