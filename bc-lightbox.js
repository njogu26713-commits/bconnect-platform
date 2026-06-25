(function () {
  const style = document.createElement('style');
  style.textContent = `
    #bc-lightbox {
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,.93);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      cursor: zoom-out;
      animation: bcLbIn .22s ease both;
      user-select: none;
    }
    @keyframes bcLbIn  { from { opacity:0 } to { opacity:1 } }
    @keyframes bcLbOut { from { opacity:1 } to { opacity:0 } }
    #bc-lightbox.bc-closing { animation: bcLbOut .18s ease both; }

    #bc-lb-img {
      max-width: 92vw;
      max-height: 72vh;
      object-fit: contain;
      border-radius: 14px;
      box-shadow: 0 40px 100px rgba(0,0,0,.85);
      animation: bcLbZoom .28s cubic-bezier(.22,.68,0,1.18) both;
      display: block;
      cursor: default;
      transition: opacity .18s;
    }
    #bc-lb-img.bc-img-fade { opacity: 0; }
    @keyframes bcLbZoom {
      from { transform:scale(.82); opacity:0 }
      to   { transform:scale(1);   opacity:1 }
    }

    /* Nav arrows */
    .bc-lb-nav {
      position: fixed; top: 50%; transform: translateY(-50%);
      width: 48px; height: 48px; border-radius: 50%;
      background: rgba(255,255,255,.13);
      border: 1.5px solid rgba(255,255,255,.22);
      backdrop-filter: blur(10px);
      color: #fff; font-size: 1.4rem;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s, transform .15s;
      z-index: 100001;
      pointer-events: all;
    }
    .bc-lb-nav:hover { background: rgba(255,255,255,.28); }
    #bc-lb-prev { left: 14px; }
    #bc-lb-next { right: 14px; }
    .bc-lb-nav.bc-hidden { opacity: 0; pointer-events: none; }

    /* Dots */
    #bc-lb-dots {
      display: flex; gap: 8px; justify-content: center;
      margin-top: 16px;
      position: relative; z-index: 100001;
    }
    .bc-lb-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: rgba(255,255,255,.35);
      cursor: pointer;
      transition: background .2s, transform .2s;
    }
    .bc-lb-dot.active {
      background: #fff;
      transform: scale(1.3);
    }

    /* Close button */
    #bc-lb-close {
      position: fixed; top: 16px; right: 18px;
      width: 44px; height: 44px; border-radius: 50%;
      background: rgba(255,255,255,.15);
      border: 1.5px solid rgba(255,255,255,.22);
      backdrop-filter: blur(10px);
      color: #fff; font-size: 1.3rem;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s, transform .15s;
      z-index: 100002;
    }
    #bc-lb-close:hover { background: rgba(255,255,255,.28); transform: scale(1.08); }

    /* Counter badge */
    #bc-lb-counter {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      font-size: .78rem; color: rgba(255,255,255,.55);
      pointer-events: none; letter-spacing: .06em;
      font-weight: 600;
      z-index: 100002;
    }

    /* Bottom info bar */
    #bc-lb-bar {
      position: fixed; bottom: 0; left: 0; right: 0;
      padding: 52px 24px 32px;
      background: linear-gradient(to top, rgba(0,0,0,.88) 0%, transparent 100%);
      display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
      pointer-events: none;
    }
    #bc-lb-info { display: flex; flex-direction: column; gap: 4px; }
    #bc-lb-title {
      font-size: 1.15rem; font-weight: 800; color: #fff;
      text-shadow: 0 1px 8px rgba(0,0,0,.5);
      max-width: 70vw;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #bc-lb-price {
      font-size: 1.05rem; font-weight: 700;
      color: rgba(255,255,255,.88);
    }
    #bc-lb-action {
      pointer-events: all;
      padding: 12px 22px; border-radius: 12px; border: none;
      background: linear-gradient(135deg, #3b67f5, #6f42f5);
      color: #fff; font-size: .9rem; font-weight: 700;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
      box-shadow: 0 8px 20px rgba(59,103,245,.4);
      transition: opacity .15s, transform .15s;
    }
    #bc-lb-action:hover { opacity: .9; transform: translateY(-1px); }

    /* Zoom cursor on modal main image */
    .modal-main-img { cursor: zoom-in !important; transition: opacity .15s; }
    .modal-main-img:hover { opacity: .92; }
    .modal-hero img { cursor: zoom-in !important; }

    /* Zoom icon badge on top of modal image */
    .modal-images { position: relative; }
    .bc-zoom-badge {
      position: absolute; bottom: 10px; right: 10px;
      background: rgba(0,0,0,.55); color: #fff;
      font-size: .72rem; font-weight: 700;
      padding: 4px 10px; border-radius: 20px;
      backdrop-filter: blur(6px);
      pointer-events: none; letter-spacing: .03em;
      display: flex; align-items: center; gap: 5px;
    }

    @media (max-width: 600px) {
      #bc-lb-img { max-width: 98vw; max-height: 62vh; border-radius: 10px; }
      #bc-lb-bar { padding: 40px 16px 28px; }
      #bc-lb-title { font-size: 1rem; }
      #bc-lb-price { font-size: .95rem; }
      #bc-lb-action { padding: 10px 16px; font-size: .85rem; }
      #bc-lb-prev { left: 6px; width: 40px; height: 40px; }
      #bc-lb-next { right: 6px; width: 40px; height: 40px; }
    }
  `;
  document.head.appendChild(style);

  let _gallery = [];
  let _galIdx  = 0;

  function closeLightbox() {
    const lb = document.getElementById('bc-lightbox');
    if (!lb) return;
    lb.classList.add('bc-closing');
    setTimeout(() => { lb.remove(); }, 200);
    document.removeEventListener('keydown', _keyHandler);
  }

  function _keyHandler(e) {
    if (e.key === 'Escape')     { closeLightbox(); return; }
    if (e.key === 'ArrowRight') { _navigate(1);  return; }
    if (e.key === 'ArrowLeft')  { _navigate(-1); return; }
  }

  function _navigate(dir) {
    if (_gallery.length <= 1) return;
    _galIdx = (_galIdx + dir + _gallery.length) % _gallery.length;
    _updateGalleryView();
  }

  function _updateGalleryView() {
    const img = document.getElementById('bc-lb-img');
    if (!img) return;

    img.classList.add('bc-img-fade');
    setTimeout(() => {
      img.src = _gallery[_galIdx];
      img.classList.remove('bc-img-fade');
    }, 160);

    document.querySelectorAll('.bc-lb-dot').forEach((d, i) => {
      d.classList.toggle('active', i === _galIdx);
    });

    const counter = document.getElementById('bc-lb-counter');
    if (counter && _gallery.length > 1) {
      counter.textContent = (_galIdx + 1) + ' / ' + _gallery.length;
    }

    const prev = document.getElementById('bc-lb-prev');
    const next = document.getElementById('bc-lb-next');
    if (prev && next && _gallery.length > 1) {
      prev.classList.toggle('bc-hidden', _galIdx === 0);
      next.classList.toggle('bc-hidden', _galIdx === _gallery.length - 1);
    }
  }

  window.bcGallery = function (images, startIdx, title, price, actionLabel, actionHref) {
    if (document.getElementById('bc-lightbox')) closeLightbox();

    _gallery = (Array.isArray(images) ? images : [images]).filter(Boolean);
    if (!_gallery.length) return;
    _galIdx = Math.max(0, Math.min(startIdx || 0, _gallery.length - 1));

    const lb = document.createElement('div');
    lb.id = 'bc-lightbox';
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });

    const multipleImgs = _gallery.length > 1;
    const dotsHtml = multipleImgs
      ? '<div id="bc-lb-dots">' +
        _gallery.map((_, i) => `<div class="bc-lb-dot${i === _galIdx ? ' active' : ''}" onclick="bcNavTo(${i})"></div>`).join('') +
        '</div>'
      : '';

    lb.innerHTML = `
      <button id="bc-lb-close">&#10005;</button>
      ${multipleImgs ? `<div id="bc-lb-counter">${_galIdx + 1} / ${_gallery.length}</div>` : ''}
      ${multipleImgs ? `<button class="bc-lb-nav${_galIdx === 0 ? ' bc-hidden' : ''}" id="bc-lb-prev" onclick="event.stopPropagation();bcNav(-1)">&#8249;</button>` : ''}
      ${multipleImgs ? `<button class="bc-lb-nav${_galIdx === _gallery.length - 1 ? ' bc-hidden' : ''}" id="bc-lb-next" onclick="event.stopPropagation();bcNav(1)">&#8250;</button>` : ''}
      <img id="bc-lb-img" src="${_gallery[_galIdx]}" alt="${title || ''}">
      ${dotsHtml}
      <div id="bc-lb-bar">
        <div id="bc-lb-info">
          ${title ? `<div id="bc-lb-title">${title}</div>` : ''}
          ${price ? `<div id="bc-lb-price">${price}</div>` : ''}
        </div>
        ${actionLabel && actionHref
          ? `<button id="bc-lb-action" onclick="window.location.href='${actionHref}'">${actionLabel}</button>`
          : ''}
      </div>
    `;

    document.body.appendChild(lb);
    document.addEventListener('keydown', _keyHandler);
    lb.querySelector('#bc-lb-close').addEventListener('click', closeLightbox);
    lb.querySelector('#bc-lb-img').addEventListener('click', e => e.stopPropagation());

    /* Touch swipe */
    let _tx = 0;
    lb.addEventListener('touchstart', e => { _tx = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - _tx;
      if (Math.abs(dx) > 40) _navigate(dx < 0 ? 1 : -1);
    });
  };

  window.bcNav = function (dir) { _navigate(dir); };
  window.bcNavTo = function (idx) { _galIdx = idx; _updateGalleryView(); };

  window.bcZoom = function (src, title, price, actionLabel, actionHref) {
    bcGallery([src], 0, title, price, actionLabel, actionHref);
  };

  /* Auto-wire modal-img on each page */
  function wireModalImg() {
    const img = document.getElementById('modal-img');
    if (!img || img._bcLbWired) return;
    img._bcLbWired = true;

    const wrap = img.closest('.modal-images') || img.closest('.modal-hero');
    if (wrap && !wrap.querySelector('.bc-zoom-badge')) {
      const badge = document.createElement('div');
      badge.className = 'bc-zoom-badge';
      badge.innerHTML = '&#128247; Tap to zoom';
      wrap.appendChild(badge);
    }

    img.addEventListener('click', function (e) {
      e.stopPropagation();
      const title = document.getElementById('modal-title')?.textContent?.trim() || '';
      const price = (document.getElementById('modal-price')?.textContent ||
                     document.getElementById('detail-price')?.textContent || '').trim();
      /* Use window._currentGalleryImages if available, else just this image */
      const imgs = (window._currentGalleryImages && window._currentGalleryImages.length)
        ? window._currentGalleryImages
        : [this.src];
      const idx = imgs.indexOf(this.src);
      bcGallery(imgs, idx >= 0 ? idx : 0, title, price);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireModalImg);
  } else {
    wireModalImg();
  }

  let _lastSrc = '';
  setInterval(function () {
    const img = document.getElementById('modal-img');
    if (!img) return;
    if (!img._bcLbWired) { wireModalImg(); return; }
    if (img.src !== _lastSrc) {
      _lastSrc = img.src;
      const wrap = img.closest('.modal-images') || img.closest('.modal-hero');
      const badge = wrap && wrap.querySelector('.bc-zoom-badge');
      if (badge) badge.style.display = img.src ? '' : 'none';
    }
  }, 400);
})();
