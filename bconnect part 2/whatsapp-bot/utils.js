'use strict';

function getBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return '';
}

function resolveImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    const base = getBaseUrl();
    return base ? base + url : null;
  }
  return url;
}

async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

async function sendImage(sock, jid, url, caption = '') {
  const resolved = resolveImageUrl(url);
  if (!resolved) {
    if (caption) await sock.sendMessage(jid, { text: caption });
    return;
  }
  try {
    await sock.sendMessage(jid, { image: { url: resolved }, caption });
  } catch {
    await sock.sendMessage(jid, { text: caption || resolved });
  }
}

async function sendImageBuffer(sock, jid, buffer, caption = '') {
  try {
    await sock.sendMessage(jid, { image: buffer, caption, mimetype: 'image/jpeg' });
  } catch {
    if (caption) await sock.sendMessage(jid, { text: caption });
  }
}

function fmtPrice(n) {
  return 'KSh ' + parseInt(n || 0).toLocaleString();
}

function truncate(str, len = 120) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function phoneFromJid(jid) {
  return jid ? jid.replace('@s.whatsapp.net', '').replace('@g.us', '') : '';
}

/**
 * Collect all images from a listing into a deduplicated array.
 * Checks common field names used across products, housing, services, and events.
 */
function getListingImages(item) {
  if (!item) return [];
  const seen = new Set();
  const out = [];
  const candidates = [
    ...(Array.isArray(item.images) ? item.images : []),
    item.image_url,
    item.imageUrl,
    item.image,
    item.propertyImage,
    item.thumbnail,
  ];
  for (const url of candidates) {
    if (url && typeof url === 'string' && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Send only the first image with a text caption.
 * Extra photos are accessed by the user via the "More Photos" paging option.
 * Falls back to plain text when no images are present.
 */
async function sendGallery(sock, jid, images, caption) {
  if (!images || !images.length) {
    if (caption) await sock.sendMessage(jid, { text: caption });
    return;
  }
  const resolved = resolveImageUrl(images[0]);
  if (!resolved) {
    if (caption) await sock.sendMessage(jid, { text: caption });
  } else {
    try {
      await sock.sendMessage(jid, { image: { url: resolved }, caption });
    } catch {
      if (caption) await sock.sendMessage(jid, { text: caption });
    }
  }
}

/**
 * Send one photo from the gallery at a given index, then a separate text message
 * with Prev / Next / Back navigation so options are always fully visible in WhatsApp.
 */
async function showGalleryPage(sock, jid, images, index) {
  const total = images.length;
  const resolved = resolveImageUrl(images[index]);

  // Send the photo first (short caption so nothing is hidden behind "Read more")
  if (resolved) {
    try {
      await sock.sendMessage(jid, { image: { url: resolved }, caption: `📸 Photo ${index + 1} of ${total}` });
    } catch {
      await sock.sendMessage(jid, { text: `📸 Photo ${index + 1} of ${total} _(could not load image)_` });
    }
  } else {
    await sock.sendMessage(jid, { text: `📸 Photo ${index + 1} of ${total} _(image unavailable)_` });
  }

  // Send navigation as a separate text message — always fully visible
  const nav =
    (index > 0 ? `1 - ⬅️ Previous\n` : '') +
    (index < total - 1 ? `2 - ➡️ Next\n` : '') +
    `3 - 🔙 Back to Listing\n4 - 🏠 Main Menu`;
  await sock.sendMessage(jid, { text: nav });
}

function getMsgText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  ).trim();
}

function isImage(msg) {
  return !!msg.message?.imageMessage;
}

module.exports = { sendText, sendImage, sendImageBuffer, sendGallery, showGalleryPage, getListingImages, fmtPrice, truncate, phoneFromJid, getMsgText, isImage, resolveImageUrl };
