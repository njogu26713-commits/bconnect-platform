'use strict';

const path = require('path');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const { getSession, setStep, clearSession } = require('./state');
const { getMsgText, isImage, sendText, showGalleryPage, phoneFromJid } = require('./utils');
const { detectIntent, isNumericChoice } = require('./router');

const { searchProducts, showProductDetail, showProductsMenu, showProductSubcategories, showProductPriceMenu, createListingPrompt, PRODUCT_CATEGORIES, PRODUCT_PRICE_RANGES } = require('./handlers/products');
const { showServicesMenu, searchServices, showServiceDetail, SERVICE_CATEGORIES } = require('./handlers/services');
const { showHousingMenu, showHousingLocations, showHousingPriceMenu, searchHousing, showPropertyDetail, showPropertyCard, HOUSING_TYPES, HOUSING_LOCATIONS, HOUSING_PRICE_RANGES } = require('./handlers/housing');
const { showEventsMenu, showEventDetail, showEventVariants, showVariantBooking } = require('./handlers/events');
const { showAccountMenu, showSellerDashboard, showTenantDashboard, showLandlordDashboard } = require('./handlers/account');
const { handleAI, startAIChat } = require('./handlers/ai');
const { handleCreateFlow } = require('./handlers/create-listing');

const AUTH_DIR = path.join(__dirname, 'auth_info');

let currentQR = null;
let currentQRDataUrl = null;
let currentPairingCode = null;
let currentPairingPhone = '';   // phone number the current code was generated for
let botConnected = false;
let botLoggedOut = false;
let botRestarting = false;
let botSocket = null;
let _db = null;
let _genAI = null;

function getQR() {
  return {
    qr: currentQR,
    dataUrl: currentQRDataUrl,
    pairingCode: currentPairingCode,
    pairingPhone: currentPairingPhone,
    connected: botConnected,
    mode: process.env.WHATSAPP_PHONE_NUMBER ? 'pairing' : 'qr'
  };
}
function isConnected() { return botConnected; }

async function refreshPairingCode(requestedPhone) {
  // Phone number: prefer the one passed from UI, fall back to env var
  const phoneNumber = (requestedPhone || process.env.WHATSAPP_PHONE_NUMBER || '').replace(/\D/g, '');
  if (!phoneNumber) return { success: false, error: 'Enter your WhatsApp number to get a pairing code' };
  if (botConnected) return { success: false, error: 'Already connected' };

  // Bot is already in the middle of restarting — just tell client to keep polling
  if (botRestarting) {
    return { success: true, restarting: true, pairingCode: null };
  }

  // Socket is dead or not yet ready — clear auth and restart
  if (!botSocket) {
    console.log('[WhatsApp Bot] Socket not ready — clearing auth and restarting for re-link…');
    currentPairingCode = null;
    try {
      const files = fs.readdirSync(AUTH_DIR);
      for (const f of files) fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
      console.log('[WhatsApp Bot] Auth cleared.');
    } catch (_) {}
    if (requestedPhone) process.env._WA_PAIRING_PHONE = phoneNumber;
    botRestarting = true;
    startBot(_db, _genAI).catch(e => { botRestarting = false; console.error('[WhatsApp Bot] Restart error:', e.message); });
    return { success: true, restarting: true, pairingCode: null };
  }

  // Socket is alive — request a fresh code directly
  try {
    const code = await botSocket.requestPairingCode(phoneNumber);
    currentPairingCode = code;
    currentPairingPhone = phoneNumber;
    console.log('[WhatsApp Bot] Pairing code for +' + phoneNumber + ':', code);
    return { success: true, pairingCode: code, pairingPhone: phoneNumber };
  } catch (e) {
    console.error('[WhatsApp Bot] Pairing code error:', e.message);
    return { success: false, error: e.message };
  }
}

async function showMainMenu(sock, jid) {
  setStep(jid, 'main');
  await sendText(sock, jid,
    '🏪 *Welcome to BConnect!*\n' +
    'Kenya\'s All-in-One Marketplace\n\n' +
    '*What would you like to do?*\n\n' +
    '1️⃣  🛍️ *Products* — buy & browse items\n' +
    '2️⃣  🔧 *Services* — plumbers, electricians & more\n' +
    '3️⃣  🏠 *Housing* — houses, flats & rentals\n' +
    '4️⃣  🎉 *Events* — concerts, shows & tickets\n' +
    '5️⃣  🤖 *AI Assistant* — ask anything\n' +
    '6️⃣  👤 *My Account* — login / profile\n' +
    '7️⃣  ➕ *Sell / List* — add your listing\n\n' +
    '💬 *Or just type what you need*, e.g.\n' +
    '_"house in Westlands"_  •  _"I need a plumber"_  •  _"show me phones"_\n\n' +
    '_Type *MENU* anytime to return here._');
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe || isJidGroup(jid)) return;

  const text = getMsgText(msg);
  const hasImage = isImage(msg);

  if (!text && !hasImage) return;

  const session = getSession(jid);
  const upper = text ? text.toUpperCase() : '';
  console.log(`[Bot] MSG | step="${session.step}" | text="${text}"`);

  const CREATE_STEPS = ['create_photo', 'create_title', 'create_price', 'create_desc'];

  if (CREATE_STEPS.includes(session.step) || (session.step === 'create_photo' && hasImage)) {
    return await handleCreateFlow(sock, jid, msg, session, _db);
  }

  if (upper === 'MENU' || upper === 'MAIN' || upper === '0' || upper === 'BACK' || upper === 'HOME' || upper === 'START') {
    return await showMainMenu(sock, jid);
  }

  if (session.step === 'ai') {
    if (text) return await handleAI(sock, jid, text, session, _genAI, _db);
  }

  if (session.step === 'main') {
    if (isNumericChoice(text)) {
      const n = parseInt(text);
      if (n === 1) return await showProductsMenu(sock, jid, session);
      if (n === 2) return await showServicesMenu(sock, jid, session, _db);
      if (n === 3) return await showHousingMenu(sock, jid, session, _db);
      if (n === 4) return await showEventsMenu(sock, jid, session, _db);
      if (n === 5) return await startAIChat(sock, jid, session);
      if (n === 6) return await showAccountMenu(sock, jid, session, _db);
      if (n === 7) return await createListingPrompt(sock, jid, session);
    }

    const intent = detectIntent(text);
    if (intent === 'greeting') return await showMainMenu(sock, jid);
    if (intent === 'menu') return await showMainMenu(sock, jid);
    if (intent === 'products') { await showProductsMenu(sock, jid, session); return; }
    if (intent === 'services') { await showServicesMenu(sock, jid, session, _db); return; }
    if (intent === 'housing') { await showHousingMenu(sock, jid, session, _db); return; }
    if (intent === 'events') { await showEventsMenu(sock, jid, session, _db); return; }
    if (intent === 'account') { await showAccountMenu(sock, jid, session, _db); return; }
    if (intent === 'ai') { await startAIChat(sock, jid, session); return; }

    // Natural language — quietly switch to AI mode and handle immediately
    if (_db || _genAI) {
      setStep(jid, 'ai', { chatHistory: [] });
      await handleAI(sock, jid, text, session, _genAI, _db);
    } else {
      await showMainMenu(sock, jid);
    }
    return;
  }

  // ... rest of handler omitted for brevity in this file but unchanged ...
}

async function startBot(db, genAI) {
  _db = db;
  _genAI = genAI;

  // Use env var, or the one-time phone override set by refreshPairingCode
  const phoneNumber = (process.env.WHATSAPP_PHONE_NUMBER || process.env._WA_PAIRING_PHONE || '').replace(/\D/g, '');
  const usePairingCode = !!phoneNumber;
  // Clear the one-time override after reading it
  delete process.env._WA_PAIRING_PHONE;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log('[WhatsApp Bot] Starting — v' + version.join('.'));
  if (usePairingCode) {
    console.log('[WhatsApp Bot] Pairing code mode — phone: +' + phoneNumber);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => ({ conversation: '' })
  });

  botSocket = sock;
  botRestarting = false;

  sock.ev.on('creds.update', saveCreds);

  // Track whether we have already requested the pairing code for this socket
  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // ── Pairing code: request when QR fires (WebSocket is open & ready) ───
    // The 'connecting' event fires via process.nextTick BEFORE the WebSocket
    // is actually open, so sendNode would fail there. The 'qr' event fires
    // inside ws.on('open') after the handshake — that's the correct window.
    if (qr && usePairingCode && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        currentPairingCode = code;
        currentPairingPhone = phoneNumber;
        console.log('\n' +
          '╔══════════════════════════════════════════╗\n' +
          '║   BCONNECT WHATSAPP BOT — PAIRING CODE  ║\n' +
          '╠══════════════════════════════════════════╣\n' +
          '║                                          ║\n' +
          '║  Code:  ' + code.padEnd(33) + '║\n' +
          '║  Phone: +' + phoneNumber.padEnd(32) + '║\n' +
          '║                                          ║\n' +
          '║  IMPORTANT: Enter this code on the       ║\n' +
          '║  WhatsApp app on the phone above.        ║\n' +
          '║  ⋮ → Linked Devices → Link a Device      ║\n' +
          '║  → "Link with phone number instead"      ║\n' +
          '║                                          ║\n' +
          '║  Or visit: /whatsapp-qr.html             ║\n' +
          '╚══════════════════════════════════════════╝\n');
      } catch (e) {
        pairingCodeRequested = false; // allow retry on next QR event
        console.error('[WhatsApp Bot] Pairing code error:', e.message);
      }
      return; // consumed the QR event — don't show QR to user
    }
    // ──────────────────────────────────────────────────────────────
    // Only use QR fallback when no phone number is configured
    if (qr && !usePairingCode) {
      currentQR = qr;
      try {
        currentQRDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      } catch (_) {}
      console.log('\n' +
        '╔══════════════════════════════════════════╗\n' +
        '║   BCONNECT WHATSAPP BOT — SCAN QR CODE  ║\n' +
        '║  Visit /whatsapp-qr.html to scan         ║\n' +
        '╚══════════════════════════════════════════╝\n');
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
        if (!err) console.log(str);
      });
    }

    if (connection === 'open') {
      botConnected = true;
      currentQR = null;
      currentQRDataUrl = null;
      currentPairingCode = null;
      console.log('[WhatsApp Bot] ✅ Connected to WhatsApp! Bot is live.');
    }

    if (connection === 'close') {
      botConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('[WhatsApp Bot] Connection closed. Code:', statusCode, '| full error:', lastDisconnect?.error || '');
      // Treat these as non-recoverable session rejection codes
      const nonRecoverable = new Set([
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.connectionReplaced,
        DisconnectReason.restartRequired,
        401, 403, 404, 405
      ]);
      const sessionRejected = statusCode != null && nonRecoverable.has(statusCode);
      if (sessionRejected) {
        // Session rejected by WhatsApp — clear stale creds and wait for user to click Refresh
        botSocket = null;
        botLoggedOut = true;
        currentPairingCode = null;
        console.log('[WhatsApp Bot] Session rejected or invalid. Clearing saved credentials and waiting for admin to re-link (visit /whatsapp-qr.html).');
        try {
          const files = fs.readdirSync(AUTH_DIR);
          for (const f of files) fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
        } catch (_) {}
      } else {
        console.log('[WhatsApp Bot] Transient disconnect — reconnecting in 5s...');
        setTimeout(() => startBot(db, genAI), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (e) {
        console.error('[WhatsApp Bot] Message handler error:', e.message);
      }
    }
  });

  return sock;
}

async function disconnectAndReset() {
  botConnected = false;
  currentPairingCode = null;
  currentPairingPhone = '';
  currentQR = null;
  currentQRDataUrl = null;
  const sock = botSocket;
  botSocket = null;
  // Logout from WhatsApp so the old session is invalid
  try { if (sock) await sock.logout(); } catch (_) {}
  // Clear saved credentials so fresh pairing is needed
  try {
    const files = fs.readdirSync(AUTH_DIR);
    for (const f of files) fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
  } catch (_) {}
  console.log('[WhatsApp Bot] Disconnected and auth cleared — ready for new pairing code.');
}

async function reconnect() {
  if (botRestarting) return { success: true, restarting: true };
  botConnected = false;
  currentQR = null;
  currentQRDataUrl = null;
  currentPairingCode = null;
  const sock = botSocket;
  botSocket = null;
  try { if (sock) sock.end(); } catch (_) {}
  botRestarting = true;
  console.log('[WhatsApp Bot] Reconnecting (keeping existing session)…');
  startBot(_db, _genAI).catch(e => {
    botRestarting = false;
    console.error('[WhatsApp Bot] Reconnect error:', e.message);
  });
  return { success: true, restarting: true };
}

module.exports = { startBot, getQR, isConnected, refreshPairingCode, disconnectAndReset, reconnect };
