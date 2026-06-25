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

  if (session.step === 'products_cat') {
    if (text === '0') return await showMainMenu(sock, jid);
    const nCat = parseInt(text);
    if (!isNaN(nCat) && nCat >= 1 && nCat <= PRODUCT_CATEGORIES.length) {
      const cat = PRODUCT_CATEGORIES[nCat - 1];
      if (cat) {
        if (cat.subs && cat.subs.length > 0) return await showProductSubcategories(sock, jid, cat, session);
        return await searchProducts(sock, jid, cat.key, session, _db, null, null, cat.label, true);
      }
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchProducts(sock, jid, q, session, _db);
  }

  if (session.step === 'products_subcat') {
    if (text === '0') return await showProductsMenu(sock, jid, session);
    const cat = session.data.selectedCategory || {};
    const subs = cat.subs || [];
    const n = parseInt(text);
    if (!isNaN(n) && n >= 1 && n <= subs.length) {
      const sub = subs[n - 1];
      return await searchProducts(sock, jid, sub.key, session, _db, null, null, sub.label, true);
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchProducts(sock, jid, q, session, _db);
  }

  if (session.step === 'products_price') {
    if (text === '0') {
      const cat = session.data.selectedCategory;
      if (cat) return await showProductSubcategories(sock, jid, cat, session);
      return await showProductsMenu(sock, jid, session);
    }
    const query = session.data.pendingProductQuery || '';
    if (isNumericChoice(text)) {
      const idx = parseInt(text) - 1;
      const range = PRODUCT_PRICE_RANGES[idx];
      if (range) return await searchProducts(sock, jid, query, session, _db, range.min, range.max);
    }
    return await searchProducts(sock, jid, text, session, _db);
  }

  if (session.step === 'products_results') {
    if (text === '0') {
      const cat = session.data.selectedCategory;
      if (cat && cat.subs && cat.subs.length) return await showProductSubcategories(sock, jid, cat, session);
      return await showProductsMenu(sock, jid, session);
    }
    const results = session.data.productResults || [];
    const n = parseInt(text);
    if (!isNaN(n) && n >= 1 && n <= results.length) {
      return await showProductDetail(sock, jid, results[n - 1], session);
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchProducts(sock, jid, q, session, _db);
  }

  if (session.step === 'product_detail') {
    if (text === '1') {
      const p = session.data.selectedProduct;
      const itemName = p ? (p.title || p.name || 'this item') : 'this item';
      await sendText(sock, jid,
        `🛍️ *Ready to buy ${itemName}?*\n\nJoin BConnect to complete your purchase securely:\n\n👉 *https://bconnect.co.ke*\n\n_Create a free account or login if you already have one, then find this item in the marketplace to order._\n\nType *MENU* to go back.`
      );
      return;
    }
    if (text === '2') {
      const p = session.data.selectedProduct;
      const phone = p && (p.phone || p.contact || p.seller_phone);
      if (phone) await sendText(sock, jid, `💬 Contact seller: wa.me/${phone.replace(/\D/g, '')}\n\nType *MENU* to go back.`);
      else await sendText(sock, jid, '💬 Seller contact not available. Visit bconnect.co.ke\n\nType *MENU* to go back.');
      return;
    }
    if (text === '3') {
      const results = session.data.productResults;
      if (results && results.length) {
        setStep(jid, 'products_results');
        let msg = `🛍️ *Back to results*\n\n`;
        results.forEach((p, i) => { msg += `*${i + 1}.* ${p.title || p.name} — KSh ${parseInt(p.price || 0).toLocaleString()}\n`; });
        msg += '\nReply with a *number* or type *MENU* to go back.';
        return await sendText(sock, jid, msg);
      }
    }
    if (text === '4') return await showMainMenu(sock, jid);
    if (text === '5') {
      const imgs = session.data.galleryImages || [];
      if (imgs.length > 1) {
        setStep(jid, 'photo_gallery', { galleryImages: imgs, galleryIndex: 1, returnStep: 'product_detail', selectedProduct: session.data.selectedProduct });
        return await showGalleryPage(sock, jid, imgs, 1);
      }
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchProducts(sock, jid, q, session, _db);
  }

  if (session.step === 'services_browse') {
    if (text === '0') return await showMainMenu(sock, jid);
    const serviceCats = (session.data && session.data.serviceCategories) || [];
    const nSvc = parseInt(text);
    if (!isNaN(nSvc) && nSvc >= 1 && nSvc <= serviceCats.length) {
      const cat = serviceCats[nSvc - 1];
      return await searchServices(sock, jid, cat.key, session, _db, cat.label, true);
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchServices(sock, jid, q, session, _db);
  }

  if (session.step === 'services_results') {
    if (isNumericChoice(text)) {
      const results = session.data.serviceResults || [];
      const idx = parseInt(text) - 1;
      if (results[idx]) return await showServiceDetail(sock, jid, results[idx], session);
    }
    return await searchServices(sock, jid, text, session, _db);
  }

  if (session.step === 'service_detail') {
    if (text === '1') {
      const s = session.data.selectedService;
      const phone = s && (s.phone || s.contact);
      if (phone) await sendText(sock, jid, `📅 Book via WhatsApp: wa.me/${phone.replace(/\D/g, '')}\n\nType *MENU* to go back.`);
      else {
        const sName = s ? (s.title || s.name || 'this service') : 'this service';
        await sendText(sock, jid,
          `📅 *Ready to book ${sName}?*\n\nJoin BConnect to book this service:\n\n👉 *https://bconnect.co.ke*\n\n_Create a free account or login if you already have one, then find this service to book it._\n\nType *MENU* to go back.`
        );
      }
      return;
    }
    if (text === '2') {
      const s = session.data.selectedService;
      const phone = s && (s.phone || s.contact);
      if (phone) await sendText(sock, jid, `📞 Call / WhatsApp: wa.me/${phone.replace(/\D/g, '')}\n\nType *MENU* to go back.`);
      else await sendText(sock, jid, '📞 Contact info not available. Visit bconnect.co.ke\n\nType *MENU* to go back.');
      return;
    }
    if (text === '3') {
      return await showServicesMenu(sock, jid, session, _db);
    }
    if (text === '4') return await showMainMenu(sock, jid);
    if (text === '5') {
      const imgs = session.data.galleryImages || [];
      if (imgs.length > 1) {
        setStep(jid, 'photo_gallery', { galleryImages: imgs, galleryIndex: 1, returnStep: 'service_detail', selectedService: session.data.selectedService });
        return await showGalleryPage(sock, jid, imgs, 1);
      }
    }
  }

  if (session.step === 'housing_type') {
    if (text === '0') return await showMainMenu(sock, jid);
    const housingTypes = (session.data && session.data.housingTypes) || [];
    const nType = parseInt(text);
    if (!isNaN(nType) && nType >= 1 && nType <= housingTypes.length) {
      const t = housingTypes[nType - 1];
      return await showHousingLocations(sock, jid, t, session, _db);
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchHousing(sock, jid, q, session, _db);
  }

  if (session.step === 'housing_location') {
    if (text === '0') return await showHousingMenu(sock, jid, session, _db);
    const housingType = session.data.selectedHousingType || {};
    const housingLocs = (session.data && session.data.housingLocations) || [];
    const nLoc = parseInt(text);
    if (!isNaN(nLoc) && nLoc >= 1 && nLoc <= housingLocs.length) {
      const loc = housingLocs[nLoc - 1];
      const combined = `${housingType.key || ''} ${loc.key}`.trim();
      return await searchHousing(sock, jid, combined, session, _db);
    }
    const typePrefix = housingType.key ? `${housingType.key} ` : '';
    const q = `${typePrefix}${text}`.trim();
    return await searchHousing(sock, jid, q, session, _db);
  }

  if (session.step === 'housing_card') {
    const results = (session.data && session.data.housingResults) || [];
    const idx = session.data.housingCardIndex || 0;
    if (text === '0') return await showHousingMenu(sock, jid, session, _db);
    if (text === '1' && idx > 0) return await showPropertyCard(sock, jid, results, idx - 1, session);
    if (text === '2' && idx < results.length - 1) return await showPropertyCard(sock, jid, results, idx + 1, session);
    if (text === '3') return await showPropertyDetail(sock, jid, results[idx], session);
    return await showPropertyCard(sock, jid, results, idx, session);
  }

  if (session.step === 'housing_results') {
    if (text === '0') return await showHousingMenu(sock, jid, session, _db);
    const nRes = parseInt(text);
    const housingResults = session.data.housingResults || [];
    if (!isNaN(nRes) && nRes >= 1 && nRes <= housingResults.length) {
      return await showPropertyDetail(sock, jid, housingResults[nRes - 1], session);
    }
    const q = upper === 'ALL' ? '' : text;
    return await searchHousing(sock, jid, q, session, _db);
  }

  if (session.step === 'property_detail') {
    if (text === '1') {
      const p = session.data.selectedProperty;
      const propName = p ? (p.title || p.name || 'this property') : 'this property';
      await sendText(sock, jid,
        `🏠 *Ready to move into ${propName}?*\n\nJoin BConnect to pay your deposit securely:\n\n👉 *https://bconnect.co.ke*\n\n_Create a free account or login if you already have one, then find this property to complete your deposit._\n\nType *MENU* to go back.`
      );
      return;
    }
    if (text === '2') {
      const p = session.data.selectedProperty;
      const ph = p && (p.phone || p.landlordPhone);
      if (ph) await sendText(sock, jid, `📞 Contact Landlord: wa.me/${ph.replace(/\D/g, '')}\n\nType *MENU* to go back.`);
      else await sendText(sock, jid, '📞 Contact info not available. Visit bconnect.co.ke\n\nType *MENU* to go back.');
      return;
    }
    if (text === '3') {
      const pv = session.data.selectedProperty;
      const pvName = pv ? (pv.title || pv.name || 'this property') : 'this property';
      await sendText(sock, jid,
        `📅 *Book a viewing for ${pvName}?*\n\nJoin BConnect to schedule your visit:\n\n👉 *https://bconnect.co.ke*\n\n_Create a free account or login if you already have one, then find this property to book a viewing._\n\nType *MENU* to go back.`
      );
      return;
    }
    if (text === '4') {
      setStep(jid, 'housing_results');
      const results = session.data.housingResults || [];
      let msg = '🏠 *Back to results*\n\n';
      results.forEach((p, i) => { msg += `*${i + 1}.* ${p.title} — KSh ${parseInt(p.price || 0).toLocaleString()}/mo\n`; });
      msg += '\nReply with a *number* or type *MENU* to go back.';
      return await sendText(sock, jid, msg);
    }
    if (text === '5') return await showMainMenu(sock, jid);
    if (text === '6') {
      const imgs = session.data.galleryImages || [];
      if (imgs.length > 1) {
        setStep(jid, 'photo_gallery', { galleryImages: imgs, galleryIndex: 1, returnStep: 'property_detail', selectedProperty: session.data.selectedProperty });
        return await showGalleryPage(sock, jid, imgs, 1);
      }
    }
  }

  if (session.step === 'events_list') {
    if (isNumericChoice(text)) {
      const results = session.data.eventResults || [];
      const idx = parseInt(text) - 1;
      if (results[idx]) return await showEventDetail(sock, jid, results[idx], session);
    }
    return await showEventsMenu(sock, jid, session, _db);
  }

  if (session.step === 'event_detail') {
    if (text === '1') {
      const e = session.data.selectedEvent;
      const variants = e && (e.variants || e.ticket_types || []);
      if (variants && variants.length) {
        return await showEventVariants(sock, jid, e, session);
      }
      const url = e ? `https://bconnect.co.ke/events.html?id=${e._id}` : 'https://bconnect.co.ke/events.html';
      await sendText(sock, jid, `🎫 To book ticket(s), visit:\n${url}\n\nType *MENU* to go back.`);
      return;
    }
    if (text === '2') {
      const e = session.data.selectedEvent;
      if (e) {
        const date = e.event_date ? new Date(e.event_date).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'TBD';
        await sendText(sock, jid,
          `ℹ️ *${e.title}*\n\n` +
          `📅 ${date}\n📍 ${e.location || 'Kenya'}\n\n` +
          (e.description || 'No further details available.') + '\n\n' +
          `🔗 https://bconnect.co.ke/events.html?id=${e._id}\n\nType *MENU* to go back.`
        );
      }
      return;
    }
    if (text === '3') return await showEventsMenu(sock, jid, session, _db);
    if (text === '4') return await showMainMenu(sock, jid);
    if (text === '5') {
      const imgs = session.data.galleryImages || [];
      if (imgs.length > 1) {
        setStep(jid, 'photo_gallery', { galleryImages: imgs, galleryIndex: 1, returnStep: 'event_detail', selectedEvent: session.data.selectedEvent });
        return await showGalleryPage(sock, jid, imgs, 1);
      }
    }
  }

  if (session.step === 'photo_gallery') {
    const { galleryImages = [], galleryIndex = 1, returnStep } = session.data;
    const total = galleryImages.length;
    if (text === '1' && galleryIndex > 0) {
      const next = galleryIndex - 1;
      setStep(jid, 'photo_gallery', { ...session.data, galleryIndex: next });
      return await showGalleryPage(sock, jid, galleryImages, next);
    }
    if (text === '2' && galleryIndex < total - 1) {
      const next = galleryIndex + 1;
      setStep(jid, 'photo_gallery', { ...session.data, galleryIndex: next });
      return await showGalleryPage(sock, jid, galleryImages, next);
    }
    if (text === '3') {
      if (returnStep === 'product_detail' && session.data.selectedProduct)
        return await showProductDetail(sock, jid, session.data.selectedProduct, session);
      if (returnStep === 'property_detail' && session.data.selectedProperty)
        return await showPropertyDetail(sock, jid, session.data.selectedProperty, session);
      if (returnStep === 'service_detail' && session.data.selectedService)
        return await showServiceDetail(sock, jid, session.data.selectedService, session);
      if (returnStep === 'event_detail' && session.data.selectedEvent)
        return await showEventDetail(sock, jid, session.data.selectedEvent, session);
      return await showMainMenu(sock, jid);
    }
    if (text === '4') return await showMainMenu(sock, jid);
    return await showGalleryPage(sock, jid, galleryImages, galleryIndex);
  }

  if (session.step === 'event_variants') {
    const e = session.data.selectedEvent;
    const variants = e && (e.variants || e.ticket_types || []);
    if (text === '0') {
      if (e) return await showEventDetail(sock, jid, e, session);
      return await showEventsMenu(sock, jid, session, _db);
    }
    if (isNumericChoice(text) && variants && variants.length) {
      const idx = parseInt(text) - 1;
      if (variants[idx]) return await showVariantBooking(sock, jid, e, variants[idx]);
    }
    return await showEventVariants(sock, jid, e, session);
  }

  if (session.step === 'event_variant_detail') {
    if (text === '1') {
      const e = session.data.selectedEvent;
      if (e) return await showEventVariants(sock, jid, e, session);
      return await showEventsMenu(sock, jid, session, _db);
    }
    if (text === '2') return await showMainMenu(sock, jid);
  }

  if (session.step === 'account') {
    if (text === '1') {
      const role = session.data.profile?.role || 'tenant';
      if (role === 'landlord' || role === 'admin') return await showLandlordDashboard(sock, jid, session, _db);
      if (role === 'seller') return await showSellerDashboard(sock, jid, session, _db);
      return await showTenantDashboard(sock, jid, session, _db);
    }
    if (text === '2') {
      const role = session.data.profile?.role || 'tenant';
      if (role === 'landlord') return await showLandlordDashboard(sock, jid, session, _db);
      return await showSellerDashboard(sock, jid, session, _db);
    }
    if (text === '3') return await showMainMenu(sock, jid);
    if (text === '4') return await showMainMenu(sock, jid);
  }

  if (session.step === 'seller_dashboard') {
    if (text === '1') return await createListingPrompt(sock, jid, session);
    if (text === '2') {
      await sendText(sock, jid, '📬 View all orders at:\nbconnect.co.ke/seller-dashboard.html\n\nType *MENU* to go back.');
      return;
    }
    if (text === '3') return await showMainMenu(sock, jid);
  }

  if (session.step === 'tenant_dashboard') {
    if (text === '1') await sendText(sock, jid, '💰 To pay rent via M-Pesa, visit:\nbconnect.co.ke/tenant-dashboard.html\n\nType *MENU* to go back.');
    else if (text === '2') await sendText(sock, jid, '🔧 To submit a maintenance request, visit:\nbconnect.co.ke/tenant-dashboard.html\n\nType *MENU* to go back.');
    else if (text === '3') await sendText(sock, jid, '📋 To view rent history, visit:\nbconnect.co.ke/tenant-dashboard.html\n\nType *MENU* to go back.');
    else if (text === '4') return await showMainMenu(sock, jid);
    return;
  }

  if (session.step === 'landlord_dashboard') {
    if (text === '1') await sendText(sock, jid, '➕ To add a property, visit:\nbconnect.co.ke/landlord-dashboard.html\n\nType *MENU* to go back.');
    else if (text === '4') return await showMainMenu(sock, jid);
    return;
  }

  if (text) {
    await startAIChat(sock, jid, session);
    return await handleAI(sock, jid, text, session, _genAI, _db);
  }

  await showMainMenu(sock, jid);
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
    // ──────────────────────────────────────────────────────────────────────
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
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('[WhatsApp Bot] Connection closed. Code:', statusCode, '| Logged out:', loggedOut);
      if (loggedOut) {
        // Session rejected by WhatsApp — clear stale creds and wait for user to click Refresh
        botSocket = null;
        botLoggedOut = true;
        currentPairingCode = null;
        console.log('[WhatsApp Bot] Session rejected. Visit /whatsapp-qr.html and click Refresh Code.');
        try {
          const files = fs.readdirSync(AUTH_DIR);
          for (const f of files) fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
        } catch (_) {}
      } else {
        console.log('[WhatsApp Bot] Reconnecting in 5s...');
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
