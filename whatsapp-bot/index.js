'use strict';

const path   = require('path');
const fs     = require('fs');
const QRCode = require('qrcode');
const pino   = require('pino');
const { ObjectId } = require('mongodb');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  Browsers,
} = require('@whiskeysockets/baileys');

// Silent pino logger — correct interface, no output
const logger = pino({ level: 'silent' });

// ── State ──────────────────────────────────────────────────────────────────────
let _sock         = null;
let _db           = null;
let _genAI        = null;
let _qrData       = null;
let _qrDataUrl    = null;
let _connected    = false;
let _mode         = 'qr';
let _pairingCode  = null;
let _pairingPhone = null;
let _restarting   = false;
const _authDir = path.join(__dirname, 'auth_state');

// ── Per-user session store ─────────────────────────────────────────────────────
// Map<jid, { state, data, listing, results, resultIndex, phone }>
const sessions = new Map();

function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, {
      state: 'main',
      data: {},
      listing: {},
      results: [],
      resultIndex: 0,
      phone: jid.split('@')[0],
      userId: null,
    });
  }
  return sessions.get(jid);
}

function resetToMain(jid) {
  const s = getSession(jid);
  s.state       = 'main';
  s.data        = {};
  s.listing     = {};
  s.results     = [];
  s.resultIndex = 0;
}

// ── Static menus ───────────────────────────────────────────────────────────────
const MAIN_MENU = `🇰🇪 *Welcome to BConnect!*
Kenya's #1 Marketplace for Products, Services & Housing.

Reply with a number:
1️⃣  🛍️  Products & Marketplace
2️⃣  🔧  Services (Plumbers, Cleaners…)
3️⃣  🏠  Housing & Rentals
4️⃣  🎉  Events & Tickets
5️⃣  👤  My Dashboard
6️⃣  🤖  AI Assistant
0️⃣  ❓  Help & Support`;

const PRODUCTS_MENU = `🛍️ *Products & Marketplace*

1️⃣  🔍 Search Products
2️⃣  ➕ Create a Listing (Sell)
3️⃣  📦 My Listings
4️⃣  🛒 My Orders
0️⃣  ↩️ Main Menu`;

const SERVICES_MENU = `🔧 *Services*

1️⃣  🔍 Find a Service Provider
2️⃣  📅 Book a Service
3️⃣  ➕ Register as Provider
4️⃣  📋 My Bookings
0️⃣  ↩️ Main Menu`;

const HOUSING_MENU = `🏠 *Housing & Rentals*

1️⃣  🔍 Search Rentals
2️⃣  🏗️ List My Property (Landlord)
3️⃣  🏡 My Rented Property (Tenant)
4️⃣  📞 Contact Landlord
0️⃣  ↩️ Main Menu`;

const EVENTS_MENU = `🎉 *Events & Tickets*

1️⃣  📅 Browse All Events
2️⃣  🔍 Search Events
3️⃣  🎤 Manage My Events (Organiser)
0️⃣  ↩️ Main Menu`;

const ACCOUNT_MENU = `👤 *My Dashboard*

1️⃣  💼 Seller Dashboard
2️⃣  🏗️ Landlord Dashboard
3️⃣  🏠 Tenant Dashboard
4️⃣  👤 My Profile
0️⃣  ↩️ Main Menu`;

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function dbFind(col, filter, limit = 6) {
  if (!_db) return [];
  try { return await _db.collection(col).find(filter).limit(limit).toArray(); }
  catch (_) { return []; }
}

async function dbInsert(col, doc) {
  if (!_db) return null;
  try { return await _db.collection(col).insertOne(doc); }
  catch (_) { return null; }
}

function regexFilter(query, fields) {
  const rx = { $regex: query, $options: 'i' };
  return { $or: fields.map(f => ({ [f]: rx })) };
}

// ── Dynamic category cache (fetched from DB) ───────────────────────────────
let _catCache    = null;
let _catCacheAt  = 0;
const CAT_TTL    = 5 * 60 * 1000; // 5 minutes

const CAT_EMOJI_MAP = [
  ['electronic|gadget|phone|laptop|computer|tech',   '📱'],
  ['fashion|cloth|dress|shirt|wear|apparel',         '👗'],
  ['beauty|personal.?care|cosmetic|skin|hair',       '🧴'],
  ['home|kitchen|furniture|appliance|household',     '🏠'],
  ['bag|accessory|accessories|wallet|luggage',       '🎒'],
  ['shoe|footwear|sandal|boot|sneaker',              '👟'],
  ['sport|fitness|gym|outdoor|exercise',             '⚽'],
  ['food|agri|farm|grocery|drink|beverage',         '🌿'],
  ['book|education|stationery|school|office',       '📚'],
  ['gaming|game|toy|kids|children',                 '🎮'],
  ['vehicle|car|auto|motorcycle|bike|spare',        '🚗'],
];

function catEmoji(name) {
  const n = (name || '').toLowerCase();
  for (const [rx, em] of CAT_EMOJI_MAP) {
    if (new RegExp(rx).test(n)) return em;
  }
  return '📦';
}

function numEmoji(n) {
  const e = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
  return n < e.length ? e[n] : `*${n}*`;
}

// Base filter that matches marketplace products only (excludes service/housing)
function marketplaceFilter(extra = {}) {
  return {
    active: true,
    listing_type: { $nin: ['service', 'housing'] },
    $and: [
      { category: { $not: /^service/i } },
      { category: { $not: /^housing/i } },
      { category: { $not: /rental/i  } },
    ],
    ...extra,
  };
}

async function getProductCategories() {
  if (_catCache && Date.now() - _catCacheAt < CAT_TTL) return _catCache;
  if (!_db) return [];
  try {
    // In the DB, category='product' always; the real category name is in subcategory
    const rawSubs = await _db.collection('properties')
      .distinct('subcategory', marketplaceFilter());
    const cats = rawSubs
      .filter(s => s && typeof s === 'string' && s.trim() && !/housing|rental|service/i.test(s))
      .sort();
    _catCache   = cats;   // array of strings
    _catCacheAt = Date.now();
    return cats;
  } catch (err) {
    console.error('[Bot] getProductCategories error:', err.message);
    return [];
  }
}

async function buildCatMenu() {
  const cats = await getProductCategories(); // flat string[]
  let menu = `🛍️ *Browse by Category*\n\n`;
  if (cats.length) {
    cats.forEach((c, i) => {
      menu += `${numEmoji(i + 1)}  ${catEmoji(c)} ${c}\n`;
    });
    menu += `${numEmoji(cats.length + 1)}  📦 Show All Products\n`;
  } else {
    menu += `📦 No categories yet — type a keyword to search.\n`;
  }
  menu += `\nOr *type a keyword* to search (e.g., "soap", "Redmi")\n0️⃣  ↩️ Main Menu`;
  return { menu, cats };
}

async function buildSvcCatMenu() {
  const cats = await getServiceCategories();
  let menu = `🔧 *Browse Services by Category*\n\n`;
  if (cats.length) {
    cats.forEach((c, i) => { menu += `${numEmoji(i + 1)}  ${c}\n`; });
    menu += `${numEmoji(cats.length + 1)}  🔧 Show All Services\n`;
  } else {
    menu += `No categories yet.\n`;
  }
  menu += `\nOr *type a name* to search\n0️⃣  ↩️ Back`;
  return { menu, cats };
}

async function buildHousingTypeMenu() {
  const types = await getHousingTypes();
  let menu = `🏠 *Browse Rentals by Type*\n\n`;
  if (types.length) {
    types.forEach((t, i) => { menu += `${numEmoji(i + 1)}  ${t}\n`; });
    menu += `${numEmoji(types.length + 1)}  🏠 Show All Rentals\n`;
  } else {
    menu += `No types yet.\n`;
  }
  menu += `\nOr *type a location or name* to search\n0️⃣  ↩️ Back`;
  return { menu, types };
}

async function buildEventCatMenu() {
  const cats = await getEventCategories();
  let menu = `🎉 *Browse Events by Category*\n\n`;
  if (cats.length) {
    cats.forEach((c, i) => { menu += `${numEmoji(i + 1)}  ${c}\n`; });
    menu += `${numEmoji(cats.length + 1)}  🎉 Show All Events\n`;
  } else {
    menu += `No categories yet.\n`;
  }
  menu += `\nOr *type a name* to search\n0️⃣  ↩️ Back`;
  return { menu, cats };
}

async function searchProducts(q) {
  if (!_db) return [];
  try {
    const base = marketplaceFilter();
    if (q) {
      base.$or = ['title', 'name', 'description'].map(f => ({ [f]: { $regex: q, $options: 'i' } }));
    }
    return await _db.collection('properties').find(base).sort({ created_at: -1 }).limit(10).toArray();
  } catch (_) { return []; }
}

async function searchProductsByCategory(catName) {
  if (!_db) return [];
  try {
    // catName maps to the 'subcategory' field in the DB (category field is always "product")
    const extra = catName ? { subcategory: { $regex: `^${catName}$`, $options: 'i' } } : {};
    return await _db.collection('properties').find(marketplaceFilter(extra)).sort({ created_at: -1 }).limit(10).toArray();
  } catch (_) { return []; }
}
async function searchServices(q)  { return dbFind('services',   regexFilter(q, ['name','title','category','subcategory','description'])); }
async function searchHousing(q)   { return dbFind('properties', { ...regexFilter(q, ['title','location','description','type','subcategory']), status: { $ne: 'inactive' }, listing_type: { $nin: ['product','service'] } }); }
async function searchEvents(q)    { return dbFind('events',     q ? regexFilter(q, ['title','location','description','category']) : {}); }

async function searchServicesByCategory(cat) {
  if (!_db) return [];
  try {
    const notInactive = { status: { $ne: 'inactive' } };
    let filterSvc = { ...notInactive };
    let filterProp = { ...notInactive, category: { $in: ['service', 'services'] } };
    if (cat) {
      const rx = { $regex: `^${cat}$`, $options: 'i' };
      filterSvc.$or = [{ subcategory: rx }, { category: rx }];
      filterProp.$or = [{ subcategory: rx }];
    }
    const [fromSvc, fromProp] = await Promise.all([
      _db.collection('services').find(filterSvc).sort({ created_at: -1 }).limit(15).toArray(),
      _db.collection('properties').find(filterProp).sort({ created_at: -1 }).limit(15).toArray(),
    ]);
    const seen = new Set();
    return [...fromSvc, ...fromProp].filter(s => {
      const k = String(s._id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 15);
  } catch (_) { return []; }
}

async function searchHousingByType(type) {
  if (!_db) return [];
  try {
    const propFilter = {
      active: true,
      $or: [{ listing_type: 'housing' }, { category: { $regex: /^housing/i } }, { category: { $regex: /rental/i } }]
    };
    if (type) {
      const rx = { $regex: type, $options: 'i' };
      propFilter.$and = [{ $or: [{ subcategory: rx }, { property_type: rx }] }];
    }
    const lpFilter = {
      $or: [
        { listOnMarketplace: true, marketplaceStatus: 'approved' },
        { listOnMarketplace: true, marketplaceStatus: { $exists: false } },
        { listOnMarketplace: true, marketplaceStatus: null }
      ]
    };
    if (type) {
      const rx = { $regex: type, $options: 'i' };
      if (!lpFilter.$and) lpFilter.$and = [];
      lpFilter.$and.push({ $or: [{ subcategory: rx }, { propertyType: rx }] });
    }
    const [fromProps, fromLandlord] = await Promise.all([
      _db.collection('properties').find(propFilter).sort({ created_at: -1 }).limit(12).toArray(),
      _db.collection('landlord_properties').find(lpFilter).sort({ createdAt: -1 }).limit(12).toArray(),
    ]);
    const normalizedLandlord = fromLandlord.map(p => ({
      _id: p._id,
      title: p.name || 'Property',
      price: p.rent || p.monthlyRent || 0,
      location: p.location || '',
      property_type: p.propertyType || '',
      subcategory: p.subcategory || p.propertyType || '',
      bedrooms: p.bedrooms || 0,
      description: p.description || '',
      image_url: p.image_url || p.imageUrl || '',
      listing_type: 'housing',
      isLandlordProperty: true,
    }));
    const seen = new Set();
    return [...fromProps, ...normalizedLandlord].filter(s => {
      const k = String(s._id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 15);
  } catch (_) { return []; }
}

async function searchEventsByCategory(cat) {
  if (!_db) return [];
  try {
    const filter = {};
    if (cat) filter.category = { $regex: `^${cat}$`, $options: 'i' };
    return await _db.collection('events').find(filter).sort({ created_at: -1 }).limit(15).toArray();
  } catch (_) { return []; }
}

async function getServiceCategories() {
  if (!_db) return [];
  try {
    const notInactive = { status: { $ne: 'inactive' } };
    const propFilter = { ...notInactive, category: { $in: ['service', 'services'] } };
    const [subSvc, catSvc, subProp] = await Promise.all([
      _db.collection('services').distinct('subcategory', notInactive),
      _db.collection('services').distinct('category', notInactive),
      _db.collection('properties').distinct('subcategory', propFilter),
    ]);
    const EXCLUDE = ['service', 'services', 'product', 'housing'];
    const merged = [...new Set([...subSvc, ...catSvc, ...subProp])]
      .filter(c => c && typeof c === 'string' && c.trim() && !EXCLUDE.includes(c.toLowerCase()))
      .sort();
    console.log('[Bot] svc categories:', JSON.stringify(merged));
    return merged;
  } catch (e) {
    console.error('[Bot] getServiceCategories error:', e.message);
    return [];
  }
}

async function getHousingTypes() {
  if (!_db) return [];
  try {
    // Use aggregation to reliably get distinct type values across both collections
    const housingMatch = {
      $or: [{ listing_type: 'housing' }, { category: { $regex: /^housing/i } }, { category: { $regex: /rental/i } }]
    };
    const lpMatch = { listOnMarketplace: true };
    const agg = fields => [
      { $match: housingMatch },
      { $project: { vals: { $filter: { input: fields.map(f => `$${f}`), as: 'v', cond: { $and: [{ $ne: ['$$v', null] }, { $ne: ['$$v', ''] }] } } } } },
      { $unwind: '$vals' },
      { $group: { _id: '$vals' } },
    ];
    const lpAgg = fields => [
      { $match: lpMatch },
      { $project: { vals: { $filter: { input: fields.map(f => `$${f}`), as: 'v', cond: { $and: [{ $ne: ['$$v', null] }, { $ne: ['$$v', ''] }] } } } } },
      { $unwind: '$vals' },
      { $group: { _id: '$vals' } },
    ];
    const [fromProps, fromLP] = await Promise.all([
      _db.collection('properties').aggregate(agg(['subcategory', 'property_type'])).toArray(),
      _db.collection('landlord_properties').aggregate(lpAgg(['subcategory', 'propertyType'])).toArray(),
    ]);
    const merged = [...new Set([...fromProps, ...fromLP].map(x => x._id).filter(c => c && typeof c === 'string' && c.trim()))]
      .sort();
    console.log('[Bot] housing types:', JSON.stringify(merged));
    return merged;
  } catch (e) {
    console.error('[Bot] getHousingTypes error:', e.message);
    return [];
  }
}

async function getEventCategories() {
  if (!_db) return [];
  try {
    return (await _db.collection('events').distinct('category'))
      .filter(c => c && typeof c === 'string' && c.trim()).sort();
  } catch (_) { return []; }
}

async function getProfile(phone)  {
  if (!_db) return null;
  try { return await _db.collection('profiles').findOne({ phone: { $regex: phone, $options: 'i' } }); }
  catch (_) { return null; }
}

async function getTenantInfo(phone) {
  if (!_db) return null;
  try {
    const t = await _db.collection('tenants').findOne({ phone: { $regex: phone, $options: 'i' } });
    if (!t?.propertyId) return { tenant: t, property: null };
    const p = await _db.collection('properties').findOne({ _id: new ObjectId(String(t.propertyId)) }).catch(() => null);
    return { tenant: t, property: p };
  } catch (_) { return null; }
}

// ── Intent detection ───────────────────────────────────────────────────────────
const INTENT_MAP = [
  { re: /plumb|electrician|cleaner|mover|fundi|technician|mechanic|painter|mason/i, state: 'svc_search_ask' },
  { re: /house|bedsit|apartment|flat|studio|rent|rental|property|room|hostel/i,     state: 'house_search_ask' },
  { re: /event|concert|party|conference|workshop|seminar|festival|show|match/i,      state: 'events_browse' },
  { re: /sell|create.*listing|list.*product|post.*item/i,                            state: 'prod_create_title' },
  { re: /buy|shop|order|phone|laptop|tv|sofa|shoes|clothes|electronic|gadget/i,     state: 'prod_search_ask' },
  { re: /my.*order|track.*order|order.*status/i,                                     state: 'my_orders' },
  { re: /my.*listing|my.*product|what.*i.*listed/i,                                 state: 'my_listings' },
  { re: /landlord.*dash|manage.*prop|my.*propert.*landlord/i,                       state: 'landlord_dash' },
  { re: /tenant.*dash|pay.*rent|rent.*status|maintenance.*request/i,                state: 'tenant_dash' },
];

async function detectIntent(text) {
  for (const { re, state } of INTENT_MAP) {
    if (re.test(text)) return state;
  }
  if (_genAI) {
    try {
      const model  = _genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const resp   = await model.generateContent(
        `Classify this message into ONE of these intents (reply with ONLY the key):
prod_search_ask, prod_create_title, svc_search_ask, house_search_ask,
events_browse, tenant_dash, landlord_dash, seller_dash, ai_chat, main

Message: "${text}"
Intent:`
      );
      const intent = resp.response.text().trim().split(/\s/)[0];
      const valid  = ['prod_search_ask','prod_create_title','svc_search_ask','house_search_ask','events_browse','tenant_dash','landlord_dash','seller_dash','ai_chat','main'];
      if (valid.includes(intent)) return intent;
    } catch (_) {}
  }
  return null;
}

// ── AI helpers ─────────────────────────────────────────────────────────────────
async function aiReply(text) {
  if (!_genAI) return null;
  try {
    const model = _genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const res   = await model.generateContent(
      `You are BConnect Kenya's AI assistant — a helpful, friendly marketplace bot for products, services, housing, and events in Kenya. Reply concisely in 3-4 sentences.

User: ${text}
Assistant:`
    );
    return res.response.text().trim();
  } catch (_) { return null; }
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const BASE_URL = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : 'https://bconnect.replit.app';

function resolveImgUrl(p) {
  // Collect all candidate image values and pick the first absolute http(s) URL.
  // Local /uploads/ paths are skipped — those files live on ephemeral disk and
  // 404 after a server restart, causing WhatsApp to silently drop the image.
  const candidates = [
    p.imageUrl, p.image_url, p.image,
    ...(Array.isArray(p.images) ? p.images : []),
  ];
  for (const raw of candidates) {
    if (raw && typeof raw === 'string' && raw.startsWith('http')) return raw;
  }
  return null;
}

function fmtKsh(v) { return v ? `KSh ${Number(v).toLocaleString()}` : 'Price on request'; }

function fmtProduct(p, i) {
  return `*${i}. ${p.title || 'Product'}*\n💰 ${fmtKsh(p.price)}\n📍 ${p.location || p.city || 'Kenya'}\n${(p.description || '').slice(0, 70)}`;
}

function fmtProductDetail(p, idx, total) {
  return `🛍️ *${p.title}*\n💰 ${fmtKsh(p.price)}\n📍 ${p.location || 'Kenya'}\n👤 ${p.sellerName || 'BConnect Seller'}\n📦 ${p.category || '—'}\n\n${p.description || ''}\n\n_(${idx} of ${total})_\n\nReply:\n1️⃣  🛒 Buy Now\n2️⃣  💬 Chat Seller\n3️⃣  📸 More Photos\n4️⃣  🔍 Similar Products\nN  ▶️ Next result\n0️⃣  ↩️ Back`;
}

function fmtService(s, i) {
  return `*${i}. ${s.name || s.title || 'Provider'}*\n🔧 ${s.category || 'Service'}\n💰 ${s.price || 'Negotiable'}\n📍 ${s.location || 'Kenya'}\n📞 ${s.phone || '—'}`;
}

function fmtServiceDetail(s) {
  return `🔧 *${s.name || s.title}*\n🏷️ ${s.category || 'Service'}\n💰 ${s.price || 'Negotiable'}\n📍 ${s.location || 'Kenya'}\n📞 ${s.phone || '—'}\n\n${s.description || ''}\n\nReply:\n1️⃣  📅 Book Service\n2️⃣  📞 Contact Directly\n3️⃣  ℹ️  More Info\n0️⃣  ↩️ Back`;
}

function fmtProperty(p, i) {
  const rent = p.price || p.rent;
  return `*${i}. ${p.title || p.type || 'Property'}*\n🏠 ${p.type || 'Rental'}\n💰 ${fmtKsh(rent)}/mo\n📍 ${p.location || 'Kenya'}\n${(p.description || '').slice(0, 70)}`;
}

function fmtPropertyDetail(p) {
  const rent = p.price || p.rent;
  return `🏠 *${p.title || p.type || 'Property'}*\n📐 ${p.type || 'Rental'}\n💰 ${fmtKsh(rent)}/mo\n📍 ${p.location || 'Kenya'}\n👤 ${p.landlordName || 'Landlord'}\n\n${p.description || ''}\n\nReply:\n1️⃣  📞 Contact Landlord\n2️⃣  📅 Schedule Viewing\n3️⃣  📸 More Photos\n4️⃣  🔍 Similar Properties\n0️⃣  ↩️ Back`;
}

function fmtEvent(e, i) {
  const d = e.date ? new Date(e.date).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBA';
  return `*${i}. ${e.title || 'Event'}*\n📅 ${d}\n📍 ${e.location || e.venue || 'Kenya'}\n💰 ${e.price ? fmtKsh(e.price) : 'Free'}`;
}

function fmtEventDetail(e) {
  const d = e.date ? new Date(e.date).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'TBA';
  return `🎉 *${e.title}*\n📅 ${d}\n📍 ${e.location || e.venue || 'Kenya'}\n💰 ${e.price ? fmtKsh(e.price) : 'Free'}\n🎫 Tickets: ${e.availableTickets || e.tickets || '—'}\n\n${e.description || ''}\n\nReply:\n1️⃣  🎫 Book Ticket\n2️⃣  ℹ️  More Info\n3️⃣  🔍 Other Events\n0️⃣  ↩️ Back`;
}

// ── Result list builders ───────────────────────────────────────────────────────
async function showProductList(jid, s, query, catName) {
  if (catName !== undefined) {
    s.results = await searchProductsByCategory(catName || null);
  } else {
    s.results = await searchProducts(query);
  }
  s.resultIndex = 0;
  if (!s.results.length) {
    const scope = catName ? `*${catName}*` : query ? `"*${query}*"` : '';
    return { text: `🔍 No products found${scope ? ` in ${scope}` : ''}.\n\nTry a different keyword or browse by category — type *1* from Products menu.` };
  }
  const label = catName || query || 'All Products';
  const messages = [];
  // Header
  messages.push({ text: `🛍️ *${s.results.length} product(s) — ${label}*` });
  // One message per product — always send with image
  s.results.forEach((p, i) => {
    const imgUrl = resolveImgUrl(p);
    const caption = fmtProduct(p, i + 1);
    if (imgUrl) {
      messages.push({ image: { url: imgUrl }, caption });
    } else {
      messages.push({ text: caption });
    }
  });
  // Footer prompt
  messages.push({ text: `Reply with a *number* (1–${s.results.length}) to view details.\nOr type a keyword to search again.` });
  return { messages };
}

async function showServiceList(jid, s, query, catName) {
  if (catName !== undefined) {
    s.results = await searchServicesByCategory(catName || null);
    s.data.catName = catName;
  } else {
    s.results = await searchServices(query);
  }
  const label = catName || query || 'All Services';
  if (!s.results.length) return { text: `🔍 No services found${label ? ` in *${label}*` : ''}.\n\nType a keyword to search or *0* to go back.` };
  const messages = [];
  messages.push({ text: `🔧 *${s.results.length} service(s) — ${label}*` });
  s.results.forEach((sv, i) => {
    const imgUrl = resolveImgUrl(sv);
    const caption = fmtService(sv, i + 1);
    if (imgUrl) messages.push({ image: { url: imgUrl }, caption });
    else messages.push({ text: caption });
  });
  messages.push({ text: `Reply with a *number* (1–${s.results.length}) to view & book.\nOr type a name to search again.` });
  return { messages };
}

async function showHousingList(jid, s, query, typeName) {
  if (typeName !== undefined) {
    s.results = await searchHousingByType(typeName || null);
    s.data.catName = typeName;
  } else {
    s.results = await searchHousing(query);
  }
  const label = typeName || query || 'All Rentals';
  if (!s.results.length) return { text: `🏠 No rentals found${label ? ` for *${label}*` : ''}.\n\nType a location or name to search or *0* to go back.` };
  const messages = [];
  messages.push({ text: `🏠 *${s.results.length} rental(s) — ${label}*` });
  s.results.forEach((p, i) => {
    const imgUrl = resolveImgUrl(p);
    const caption = fmtProperty(p, i + 1);
    if (imgUrl) messages.push({ image: { url: imgUrl }, caption });
    else messages.push({ text: caption });
  });
  messages.push({ text: `Reply with a *number* (1–${s.results.length}) to view details.\nOr type a location or name to search again.` });
  return { messages };
}

async function showEventList(jid, s, query, catName) {
  if (catName !== undefined) {
    s.results = await searchEventsByCategory(catName || null);
    s.data.catName = catName;
  } else {
    s.results = await searchEvents(query);
  }
  const label = catName || query || 'All Events';
  if (!s.results.length) return { text: `🎉 No events found${label ? ` in *${label}*` : ''}.\n\nType a keyword to search or *0* to go back.` };
  const messages = [];
  messages.push({ text: `🎉 *${s.results.length} event(s) — ${label}*` });
  s.results.forEach((e, i) => {
    const imgUrl = resolveImgUrl(e);
    const caption = fmtEvent(e, i + 1);
    if (imgUrl) messages.push({ image: { url: imgUrl }, caption });
    else messages.push({ text: caption });
  });
  messages.push({ text: `Reply with a *number* (1–${s.results.length}) to view & book.\nOr type a name to search again.` });
  return { messages };
}

// ── Dashboard helpers ──────────────────────────────────────────────────────────
async function sellerDashboard(jid, s) {
  s.state = 'seller_dash';
  const phone = s.phone;
  let listings = 0, orders = 0;
  if (_db) {
    listings = await _db.collection('properties').countDocuments({ sellerPhone: { $regex: phone, $options: 'i' }, active: true, listing_type: { $nin: ['service', 'housing'] } }).catch(() => 0);
    orders   = await _db.collection('orders').countDocuments({ buyerPhone: { $regex: phone, $options: 'i' } }).catch(() => 0);
  }
  return `💼 *Seller Dashboard*\n\n📦 My Listings: *${listings}*\n🛒 My Orders: *${orders}*\n\n1️⃣  📦 My Listings\n2️⃣  🛒 My Orders\n3️⃣  ➕ Create New Listing\n\n📱 Full dashboard: bconnect.replit.app/seller-dashboard.html\n\n0️⃣  ↩️ Back`;
}

async function landlordDashboard(jid, s) {
  s.state = 'landlord_dash';
  const phone = s.phone;
  const props = await dbFind('properties', { landlordPhone: { $regex: phone, $options: 'i' } }, 5);
  let out = `🏗️ *Landlord Dashboard*\n\n`;
  if (props.length) {
    out += `*Your Properties:*\n`;
    props.forEach((p, i) => {
      out += `${i + 1}. ${p.title || 'Property'} — ${p.location || '—'} — ${fmtKsh(p.price || p.rent)}/mo\n`;
    });
  } else {
    out += `No properties listed yet.\n`;
  }
  out += `\n1️⃣  🏗️ List New Property\n\n📱 Full dashboard: bconnect.replit.app/landlord-dashboard.html\n0️⃣  ↩️ Back`;
  return out;
}

async function tenantDashboard(jid, s) {
  s.state = 'tenant_dash';
  const ti = await getTenantInfo(s.phone);
  if (ti?.property) {
    const p    = ti.property;
    const t    = ti.tenant;
    const rent = fmtKsh(p.price || p.rent || t.rentAmount);
    return `🏠 *Tenant Dashboard*\n\n🏡 *${p.title || 'Your Property'}*\n📍 ${p.location || '—'}\n💰 Rent: ${rent}/month\n📊 Status: ${t.status || 'Active'}\n\n1️⃣  💳 Pay Rent (M-Pesa)\n2️⃣  🔧 Submit Maintenance Request\n3️⃣  💬 Message Landlord\n\n📱 Full dashboard: bconnect.replit.app/tenant-dashboard.html\n0️⃣  ↩️ Back`;
  }
  return `🏠 *Tenant Dashboard*\n\nNo property linked to your number.\n\nLink your property at:\nbconnect.replit.app/tenant-dashboard.html\n\nOr contact your landlord for your unit code.\n\n0️⃣  ↩️ Back`;
}

async function myListings(jid, s) {
  if (!_db) return `📦 Manage listings: bconnect.replit.app/seller-dashboard.html`;
  const items = await dbFind('properties', { sellerPhone: { $regex: s.phone, $options: 'i' }, active: true, listing_type: { $nin: ['service', 'housing'] } }, 8);
  if (!items.length) return `📦 No active listings yet.\n\nType *2* to create a listing!`;
  let out = `📦 *Your Listings (${items.length})*\n\n`;
  items.forEach((p, i) => { out += `${i + 1}. ${p.title} — ${fmtKsh(p.price)} — active\n`; });
  out += `\n📱 bconnect.replit.app/seller-dashboard.html\nType *menu* for main menu.`;
  return out;
}

async function myOrders(jid, s) {
  if (!_db) return `🛒 Track orders: bconnect.replit.app/orders.html`;
  const items = await dbFind('orders', { buyerPhone: { $regex: s.phone, $options: 'i' } }, 6);
  if (!items.length) return `🛒 No orders yet.\n\nBrowse products — type *1* then *1*.\nType *menu* for main menu.`;
  let out = `🛒 *Your Orders (${items.length})*\n\n`;
  items.forEach((o, i) => { out += `${i + 1}. ${o.productTitle || '—'} — ${fmtKsh(o.price)} — ${o.status || 'pending'}\n`; });
  out += `\n📱 bconnect.replit.app/orders.html\nType *menu* for main menu.`;
  return out;
}

// ── Core message handler ───────────────────────────────────────────────────────
async function handleMessage(jid, msg) {
  const s      = getSession(jid);
  const text   = extractText(msg).trim();
  const lower  = text.toLowerCase();
  const isImg  = !!(msg.message?.imageMessage);

  // Universal escape hatches
  if (lower === '0' || lower === 'menu' || lower === 'main' || lower === 'back') {
    resetToMain(jid);
    return { text: MAIN_MENU };
  }
  if (lower === 'help' || lower === '?') {
    return { text: `🙋 *BConnect Support*\n\nVisit: bconnect.replit.app/support.html\n\nType *menu* to return to the main menu.` };
  }

  // ── MAIN ────────────────────────────────────────────────────────────────────
  if (s.state === 'main') {
    switch (lower) {
      case '1': s.state = 'prod_menu';    return { text: PRODUCTS_MENU };
      case '2': s.state = 'svc_menu';     return { text: SERVICES_MENU };
      case '3': s.state = 'house_menu';   return { text: HOUSING_MENU };
      case '4': s.state = 'events_menu';  return { text: EVENTS_MENU };
      case '5': s.state = 'account_menu'; return { text: ACCOUNT_MENU };
      case '6':
        s.state = 'ai_chat';
        return { text: `🤖 *AI Assistant*\n\nAsk me anything — products, housing, services, events, or anything!\n\n_(Type *menu* to exit)_` };
      default: {
        const intent = await detectIntent(text);
        if (intent && intent !== 'main') {
          s.state = intent;
          return handleEntry(jid, s, msg, text);
        }
        return { text: MAIN_MENU };
      }
    }
  }

  return handleEntry(jid, s, msg, text);
}

// Called when we need to handle a state, possibly on first entry
async function handleEntry(jid, s, msg, text) {
  const lower = text.toLowerCase();
  const isImg = !!(msg.message?.imageMessage);

  // ── PRODUCTS MENU ──────────────────────────────────────────────────────────
  if (s.state === 'prod_menu') {
    switch (lower) {
      case '1': {
        s.state = 'prod_cat_pick';
        const { menu, cats } = await buildCatMenu();
        s.data.cats = cats;
        return { text: menu };
      }
      case '2': s.state = 'prod_create_title'; return { text: '➕ *Create a Listing*\n\n📝 What is the *product title*?\n_(e.g., Samsung Galaxy A54 256GB Blue)_' };
      case '3': return { text: await myListings(jid, s) };
      case '4': return { text: await myOrders(jid, s) };
      default:  return { text: PRODUCTS_MENU };
    }
  }

  // ── CATEGORY PICKER ────────────────────────────────────────────────────────
  // cats is a flat string[] — each entry IS the category (stored as subcategory in DB)
  if (s.state === 'prod_cat_pick') {
    const cats   = s.data.cats && s.data.cats.length ? s.data.cats : await getProductCategories();
    const allNum = String(cats.length + 1);

    if (lower === '0') { s.state = 'prod_menu'; return { text: PRODUCTS_MENU }; }

    if (lower === allNum) {
      s.state = 'prod_results';
      s.data.catName = null;
      return await showProductList(jid, s, '', null);
    }

    const idx = parseInt(lower) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < cats.length) {
      const catName = cats[idx]; // plain string
      s.data.catName = catName;
      s.state = 'prod_results';
      return await showProductList(jid, s, '', catName);
    }

    if (text.length > 1 && isNaN(parseInt(lower))) {
      s.data.query = text;
      s.state = 'prod_results';
      return await showProductList(jid, s, text);
    }

    const { menu, cats: freshCats } = await buildCatMenu();
    s.data.cats = freshCats;
    return { text: menu };
  }

  // ── PRODUCT SEARCH (keyword, from intent detection) ────────────────────────
  if (s.state === 'prod_search_ask') {
    if (!text) {
      const { menu, cats } = await buildCatMenu();
      s.data.cats = cats;
      s.state = 'prod_cat_pick';
      return { text: menu };
    }
    s.data.query = text;
    s.state = 'prod_results';
    return await showProductList(jid, s, text);
  }

  if (s.state === 'prod_results') {
    if (lower === 'n' || lower === 'next') {
      s.resultIndex = Math.min(s.resultIndex + 1, s.results.length - 1);
      s.state = 'prod_action';
      return productDetailMsg(s.results[s.resultIndex], s.resultIndex + 1, s.results.length);
    }
    const num = parseInt(lower);
    if (!isNaN(num) && num >= 1 && num <= s.results.length) {
      s.resultIndex = num - 1;
      s.state = 'prod_action';
      return productDetailMsg(s.results[s.resultIndex], num, s.results.length);
    }
    if (!isNaN(num) && num > 0) {
      // Number typed but out of range — don't treat as a search keyword
      return { text: `Please reply with a number between *1* and *${s.results.length}*, or type a keyword to search again.` };
    }
    // Non-numeric text — treat as keyword search
    s.data.query = text;
    s.state = 'prod_results';
    return await showProductList(jid, s, text);
  }

  if (s.state === 'prod_action') {
    const p = s.results[s.resultIndex];
    switch (lower) {
      case '1': // Buy
        s.state = 'prod_buy_confirm';
        s.data.selectedProduct = p;
        return { text: `🛒 *Confirm Purchase*\n\n${p.title}\n💰 ${fmtKsh(p.price)}\n\nReply *YES* to place order, or *NO* to cancel.\n\n_(M-Pesa STK Push will be sent to your number)_` };
      case '2': // Chat seller
        const spn = (p.sellerPhone || '').replace(/\D/g, '');
        return { text: `💬 *Chat with Seller*\n\n${p.sellerName || 'Seller'}\n📞 wa.me/${spn}\n\nMessage them directly on WhatsApp!` };
      case '3': // More photos
        const imgs = p.images || (p.imageUrl ? [p.imageUrl] : []);
        if (!imgs.length) return { text: `📸 No additional photos for this listing.\n\n📱 View online: bconnect.replit.app/product.html?id=${p._id}` };
        return { text: `📸 *${p.title}* — ${imgs.length} photo(s)\n\nView all: bconnect.replit.app/product.html?id=${p._id}` };
      case '4': // Similar — match by subcategory (real category in DB)
        s.state = 'prod_results';
        return await showProductList(jid, s, '', p.subcategory || s.data.catName || null);
      case 'n': case 'next':
        s.resultIndex = Math.min(s.resultIndex + 1, s.results.length - 1);
        return productDetailMsg(s.results[s.resultIndex], s.resultIndex + 1, s.results.length);
      default:
        return productDetailMsg(p, s.resultIndex + 1, s.results.length);
    }
  }

  if (s.state === 'prod_buy_confirm') {
    if (lower === 'yes') {
      const p = s.data.selectedProduct;
      await dbInsert('orders', {
        productId: p._id, productTitle: p.title, price: p.price,
        buyerPhone: s.phone, sellerId: p.sellerId, status: 'pending',
        channel: 'whatsapp', createdAt: new Date(),
      });
      resetToMain(jid);
      return { text: `✅ *Order Placed!*\n\n📦 ${p.title}\n💰 ${fmtKsh(p.price)}\n\nThe seller will contact you shortly!\n\n📱 Track: bconnect.replit.app/orders.html\n\nType *menu* for main menu.` };
    }
    resetToMain(jid);
    return { text: `❌ Order cancelled.\nType *menu* for main menu.` };
  }

  // ── CREATE PRODUCT LISTING ─────────────────────────────────────────────────
  if (s.state === 'prod_create_title') {
    if (!text) return { text: '📝 What is the *product title*?' };
    s.listing.title = text;
    s.state = 'prod_create_desc';
    return { text: `📋 *Describe your product*\n\nInclude condition (new/used), features, and key details.` };
  }
  if (s.state === 'prod_create_desc') {
    if (!text) return { text: '📋 Please describe your product:' };
    s.listing.description = text;
    s.state = 'prod_create_price';
    return { text: `💰 *What is the price?*\n\nEnter price in KSh (numbers only, e.g., 15000)` };
  }
  if (s.state === 'prod_create_price') {
    const price = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(price) || price <= 0) return { text: `💰 Please enter a valid price (e.g., 15000)` };
    s.listing.price = price;
    s.state = 'prod_create_category';
    return { text: `🏷️ *Select Category:*\n\n1️⃣  📱 Electronics\n2️⃣  👗 Fashion & Clothing\n3️⃣  🛋️ Furniture & Home\n4️⃣  🚗 Vehicles & Parts\n5️⃣  🌿 Food & Agriculture\n6️⃣  📚 Books & Education\n7️⃣  🎮 Gaming & Toys\n8️⃣  📦 Other` };
  }
  if (s.state === 'prod_create_category') {
    const cats = { '1':'Electronics','2':'Fashion','3':'Furniture','4':'Vehicles','5':'Food','6':'Education','7':'Gaming','8':'Other' };
    const cat  = cats[lower];
    if (!cat) return { text: `🏷️ Reply with a number (1–8) to select category.` };
    s.listing.category = cat;
    s.state = 'prod_create_location';
    return { text: `📍 *Where are you located?*\n\nEnter your area/town (e.g., Nairobi CBD, Westlands, Mombasa)` };
  }
  if (s.state === 'prod_create_location') {
    if (!text) return { text: `📍 Please enter your location:` };
    s.listing.location = text;
    s.state = 'prod_create_photo';
    return { text: `📸 *Add a Photo*\n\nSend a photo of your product, or type *SKIP* to publish without one.` };
  }
  if (s.state === 'prod_create_photo') {
    if (!isImg && lower !== 'skip') return { text: `📸 Please send a photo, or type *SKIP*` };
    if (isImg) {
      try {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        s.listing.imageBase64 = buf.toString('base64').slice(0, 60000);
        s.listing.imageType   = msg.message.imageMessage.mimetype || 'image/jpeg';
      } catch (_) {}
    }
    s.state = 'prod_create_confirm';
    const l = s.listing;
    return { text: `✅ *Listing Preview*\n\n📦 *${l.title}*\n📋 ${(l.description || '').slice(0, 100)}\n💰 ${fmtKsh(l.price)}\n🏷️ ${l.category}\n📍 ${l.location}\n📸 Photo: ${l.imageBase64 ? 'Attached ✓' : 'None'}\n\nReply *YES* to publish or *NO* to cancel.` };
  }
  if (s.state === 'prod_create_confirm') {
    if (lower === 'yes') {
      const l = { ...s.listing };
      if (l.imageBase64) {
        l.imageUrl = `data:${l.imageType};base64,${l.imageBase64}`;
        delete l.imageBase64; delete l.imageType;
      }
      await dbInsert('properties', { ...l, sellerPhone: s.phone, active: true, listing_type: 'product', channel: 'whatsapp', views: 0, created_at: new Date() });
      resetToMain(jid);
      return { text: `🎉 *Your listing is LIVE!*\n\n✅ "${s.listing.title}" published on BConnect!\n\n📱 Manage: bconnect.replit.app/seller-dashboard.html\n\nType *menu* for main menu.` };
    }
    resetToMain(jid);
    return { text: `❌ Listing cancelled.\nType *menu* for main menu.` };
  }

  // ── SERVICES MENU ──────────────────────────────────────────────────────────
  if (s.state === 'svc_menu') {
    switch (lower) {
      case '1': case '2': {
        const { menu, cats } = await buildSvcCatMenu();
        s.data.svcCats = cats;
        s.state = 'svc_cat_pick';
        return { text: menu };
      }
      case '3':
        s.state = 'svc_reg_name';
        return { text: `➕ *Register as Service Provider*\n\nWhat is your *full name* or *business name*?` };
      case '4':
        return { text: await myBookings(jid, s) };
      default:
        return { text: SERVICES_MENU };
    }
  }

  if (s.state === 'svc_cat_pick') {
    const cats = s.data.svcCats || [];
    const num = parseInt(lower);
    if (lower === '0') { s.state = 'svc_menu'; return { text: SERVICES_MENU }; }
    if (!isNaN(num) && num >= 1 && num <= cats.length) {
      s.state = 'svc_results';
      return await showServiceList(jid, s, '', cats[num - 1]);
    }
    if (!isNaN(num) && num === cats.length + 1) {
      s.state = 'svc_results';
      return await showServiceList(jid, s, '', '');
    }
    // Non-numeric → treat as keyword search
    s.data.query = text;
    s.state = 'svc_results';
    return await showServiceList(jid, s, text);
  }

  if (s.state === 'svc_results') {
    const num = parseInt(lower);
    if (lower === '0') {
      const { menu, cats } = await buildSvcCatMenu();
      s.data.svcCats = cats;
      s.state = 'svc_cat_pick';
      return { text: menu };
    }
    if (!isNaN(num) && num >= 1 && num <= s.results.length) {
      s.data.selectedService = s.results[num - 1];
      s.state = 'svc_action';
      return { text: fmtServiceDetail(s.data.selectedService) };
    }
    // Non-numeric → keyword search by name
    s.data.query = text;
    return await showServiceList(jid, s, text);
  }

  if (s.state === 'svc_action') {
    const svc = s.data.selectedService;
    switch (lower) {
      case '1': s.state = 'svc_book_date'; return { text: `📅 *Book ${svc.name || svc.title}*\n\nWhen do you need the service?\n_(e.g., Tomorrow 9am, 15 June)_` };
      case '2': return { text: `📞 *Contact Provider*\n\n${svc.name || svc.title}\nwa.me/${(svc.phone || '').replace(/\D/g, '')}` };
      case '3': return { text: fmtServiceDetail(svc) };
      default:  return { text: fmtServiceDetail(svc) };
    }
  }

  if (s.state === 'svc_book_date') {
    if (!text) return { text: '📅 When do you need the service?' };
    s.data.bookDate = text;
    s.state = 'svc_book_loc';
    return { text: `📍 *Your Location*\n\nWhere do you need the service?\n_(e.g., Kilimani, Westlands, Mombasa)_` };
  }
  if (s.state === 'svc_book_loc') {
    if (!text) return { text: '📍 Please enter your location:' };
    s.data.bookLoc = text;
    s.state = 'svc_book_desc';
    return { text: `📝 *Describe the Job*\n\nBriefly describe what needs to be done:` };
  }
  if (s.state === 'svc_book_desc') {
    s.data.bookDesc = text;
    const ref = 'BC' + Date.now().toString().slice(-6);
    await dbInsert('service_bookings', {
      serviceId: s.data.selectedService?._id,
      serviceName: s.data.selectedService?.name || s.data.selectedService?.title,
      date: s.data.bookDate, location: s.data.bookLoc, details: s.data.bookDesc,
      clientPhone: s.phone, status: 'pending', reference: ref,
      channel: 'whatsapp', createdAt: new Date(),
    });
    resetToMain(jid);
    return { text: `✅ *Booking Confirmed!*\n\n📋 Ref: *${ref}*\n🔧 ${s.data.selectedService?.name || 'Service'}\n📅 ${s.data.bookDate}\n📍 ${s.data.bookLoc}\n\nThe provider will contact you shortly!\nType *menu* for main menu.` };
  }

  // Provider registration
  if (s.state === 'svc_reg_name') {
    s.data.provName = text;
    s.state = 'svc_reg_cat';
    return { text: `🔧 *What service do you offer?*\n\n1️⃣  Plumbing\n2️⃣  Electrical\n3️⃣  Cleaning\n4️⃣  Moving\n5️⃣  Painting\n6️⃣  Carpentry\n7️⃣  Tutoring\n8️⃣  Photography\n9️⃣  Other` };
  }
  if (s.state === 'svc_reg_cat') {
    const cats = { '1':'Plumbing','2':'Electrical','3':'Cleaning','4':'Moving','5':'Painting','6':'Carpentry','7':'Tutoring','8':'Photography','9':'Other' };
    s.data.provCat = cats[lower] || text;
    s.state = 'svc_reg_loc';
    return { text: `📍 Where do you operate?\n_(e.g., Nairobi, Mombasa — or "Nationwide")_` };
  }
  if (s.state === 'svc_reg_loc') {
    s.data.provLoc = text;
    s.state = 'svc_reg_price';
    return { text: `💰 What is your rate?\n_(e.g., KSh 2000/visit, From KSh 500/hr, Negotiable)_` };
  }
  if (s.state === 'svc_reg_price') {
    await dbInsert('services', {
      name: s.data.provName, category: 'service', subcategory: s.data.provCat,
      location: s.data.provLoc, price: text, phone: s.phone,
      active: true, status: 'active', channel: 'whatsapp', createdAt: new Date(),
    });
    resetToMain(jid);
    return { text: `🎉 *Profile Live!*\n\n✅ Listed as *${s.data.provCat}* provider on BConnect!\n\n📱 Manage: bconnect.replit.app/seller-dashboard.html\nType *menu* for main menu.` };
  }

  // ── HOUSING MENU ───────────────────────────────────────────────────────────
  if (s.state === 'house_menu') {
    switch (lower) {
      case '1': {
        const { menu, types } = await buildHousingTypeMenu();
        s.data.housingTypes = types;
        s.state = 'house_cat_pick';
        return { text: menu };
      }
      case '2': s.state = 'house_create_title'; return { text: `🏗️ *List Your Property*\n\nWhat is the *property title*?\n_(e.g., Spacious 2BR in Westlands)_` };
      case '3': return { text: await tenantPropertyText(jid, s) };
      case '4': {
        const ti = await getTenantInfo(s.phone);
        if (ti?.property) {
          const p = ti.property;
          return { text: `📞 *Your Landlord*\n\n${p.landlordName || 'Landlord'}\nwa.me/${(p.landlordPhone || '').replace(/\D/g, '')}\n🏠 ${p.title || 'Property'}` };
        }
        return { text: `❌ No linked property.\n\nLink at: bconnect.replit.app/tenant-dashboard.html` };
      }
      default: return { text: HOUSING_MENU };
    }
  }

  if (s.state === 'house_cat_pick') {
    const types = s.data.housingTypes || [];
    const num = parseInt(lower);
    if (lower === '0') { s.state = 'house_menu'; return { text: HOUSING_MENU }; }
    if (!isNaN(num) && num >= 1 && num <= types.length) {
      s.state = 'house_results';
      return await showHousingList(jid, s, '', types[num - 1]);
    }
    if (!isNaN(num) && num === types.length + 1) {
      s.state = 'house_results';
      return await showHousingList(jid, s, '', '');
    }
    // Non-numeric → keyword/location search
    s.data.query = text;
    s.state = 'house_results';
    return await showHousingList(jid, s, text);
  }

  if (s.state === 'house_results') {
    const num = parseInt(lower);
    if (lower === '0') {
      const { menu, types } = await buildHousingTypeMenu();
      s.data.housingTypes = types;
      s.state = 'house_cat_pick';
      return { text: menu };
    }
    if (!isNaN(num) && num >= 1 && num <= s.results.length) {
      s.data.selectedProperty = s.results[num - 1];
      s.state = 'house_action';
      return { text: fmtPropertyDetail(s.data.selectedProperty) };
    }
    // Non-numeric → keyword/location search
    s.data.query = text;
    return await showHousingList(jid, s, text);
  }

  if (s.state === 'house_action') {
    const p = s.data.selectedProperty;
    switch (lower) {
      case '1': {
        const ph = (p.landlordPhone || p.phone || '').replace(/\D/g, '');
        return { text: `📞 *Contact Landlord*\n\n${p.landlordName || 'Landlord'}\nwa.me/${ph}` };
      }
      case '2': s.state = 'house_viewing_date'; return { text: `📅 *Schedule Viewing*\n\nWhen would you like to view?\n_(e.g., Tomorrow 2pm, Saturday morning)_` };
      case '3': return { text: `📸 View photos: bconnect.replit.app/housing.html` };
      case '4': s.state = 'house_results'; return await showHousingList(jid, s, s.data.query);
      default:  return { text: fmtPropertyDetail(p) };
    }
  }

  if (s.state === 'house_viewing_date') {
    if (!text) return { text: `📅 When would you like to view?` };
    const p = s.data.selectedProperty;
    await dbInsert('bookings', {
      propertyId: p._id, propertyTitle: p.title, landlordId: p.landlordId,
      tenantPhone: s.phone, viewingDate: text, status: 'pending',
      channel: 'whatsapp', createdAt: new Date(),
    });
    resetToMain(jid);
    return { text: `✅ *Viewing Requested!*\n\n🏠 ${p.title || 'Property'}\n📅 ${text}\n\nThe landlord will confirm your viewing.\nType *menu* for main menu.` };
  }

  // Property listing (landlord)
  if (s.state === 'house_create_title') {
    s.listing.title = text;
    s.state = 'house_create_type';
    return { text: `🏠 *Property Type*\n\n1️⃣  Bedsitter\n2️⃣  1 Bedroom\n3️⃣  2 Bedroom\n4️⃣  3+ Bedroom\n5️⃣  Studio\n6️⃣  Office Space\n7️⃣  Other` };
  }
  if (s.state === 'house_create_type') {
    const types = { '1':'Bedsitter','2':'1 Bedroom','3':'2 Bedroom','4':'3+ Bedroom','5':'Studio','6':'Office','7':'Other' };
    s.listing.type = types[lower] || text;
    s.state = 'house_create_loc';
    return { text: `📍 Where is the property?\n_(e.g., Westlands, Nairobi)_` };
  }
  if (s.state === 'house_create_loc') {
    s.listing.location = text;
    s.state = 'house_create_price';
    return { text: `💰 Monthly rent in KSh?\n_(numbers only, e.g., 25000)_` };
  }
  if (s.state === 'house_create_price') {
    const price = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(price)) return { text: `💰 Please enter a valid amount (e.g., 25000)` };
    s.listing.price = price;
    s.state = 'house_create_desc';
    return { text: `📋 *Describe the property*\n\nAmenities, floor, nearby landmarks, etc.` };
  }
  if (s.state === 'house_create_desc') {
    s.listing.description = text;
    s.state = 'house_create_photo';
    return { text: `📸 Send a photo of the property, or type *SKIP*.` };
  }
  if (s.state === 'house_create_photo') {
    if (!isImg && lower !== 'skip') return { text: `📸 Please send a photo or type *SKIP*` };
    if (isImg) s.listing.hasPhoto = true;
    s.state = 'house_create_confirm';
    const l = s.listing;
    return { text: `✅ *Property Preview*\n\n🏠 *${l.title}*\n📐 ${l.type}\n📍 ${l.location}\n💰 ${fmtKsh(l.price)}/mo\n${(l.description || '').slice(0, 100)}\n📸 Photo: ${l.hasPhoto ? 'Yes ✓' : 'None'}\n\nReply *YES* to publish or *NO* to cancel.` };
  }
  if (s.state === 'house_create_confirm') {
    if (lower === 'yes') {
      await dbInsert('properties', { ...s.listing, landlordPhone: s.phone, status: 'active', channel: 'whatsapp', createdAt: new Date() });
      resetToMain(jid);
      return { text: `🎉 *Property Listed!*\n\n✅ "${s.listing.title}" is now live on BConnect!\n\n📱 Manage: bconnect.replit.app/landlord-dashboard.html\nType *menu* for main menu.` };
    }
    resetToMain(jid);
    return { text: `❌ Listing cancelled.\nType *menu* for main menu.` };
  }

  // ── EVENTS MENU ────────────────────────────────────────────────────────────
  if (s.state === 'events_menu' || s.state === 'events_browse') {
    switch (lower) {
      case '1': case 'events_browse': case '': {
        const { menu, cats } = await buildEventCatMenu();
        s.data.eventCats = cats;
        s.state = 'events_cat_pick';
        return { text: menu };
      }
      case '2': s.state = 'events_search_ask'; return { text: `🔍 *Search Events*\n\nWhat event are you looking for?` };
      case '3': return { text: `🎤 *Manage Events*\n\nVisit: bconnect.replit.app/organizer-dashboard.html\nType *menu* for main menu.` };
      default:
        return { text: EVENTS_MENU };
    }
  }

  if (s.state === 'events_cat_pick') {
    const cats = s.data.eventCats || [];
    const num = parseInt(lower);
    if (lower === '0') { s.state = 'events_menu'; return { text: EVENTS_MENU }; }
    if (!isNaN(num) && num >= 1 && num <= cats.length) {
      s.state = 'events_results';
      return await showEventList(jid, s, '', cats[num - 1]);
    }
    if (!isNaN(num) && num === cats.length + 1) {
      s.state = 'events_results';
      return await showEventList(jid, s, '', '');
    }
    // Non-numeric → keyword search
    s.data.query = text;
    s.state = 'events_results';
    return await showEventList(jid, s, text);
  }

  if (s.state === 'events_search_ask') {
    s.data.query = text;
    s.state = 'events_results';
    return await showEventList(jid, s, text);
  }

  if (s.state === 'events_results') {
    const num = parseInt(lower);
    if (lower === '0') {
      const { menu, cats } = await buildEventCatMenu();
      s.data.eventCats = cats;
      s.state = 'events_cat_pick';
      return { text: menu };
    }
    if (!isNaN(num) && num >= 1 && num <= s.results.length) {
      s.data.selectedEvent = s.results[num - 1];
      s.state = 'event_action';
      return { text: fmtEventDetail(s.data.selectedEvent) };
    }
    // Non-numeric → keyword search by name
    s.data.query = text;
    return await showEventList(jid, s, text || '');
  }

  if (s.state === 'event_action') {
    const ev = s.data.selectedEvent;
    switch (lower) {
      case '1': {
        const ref = 'EVT' + Date.now().toString().slice(-5);
        await dbInsert('event_bookings', {
          eventId: ev._id, eventTitle: ev.title, phone: s.phone,
          reference: ref, status: 'confirmed', channel: 'whatsapp', createdAt: new Date(),
        });
        resetToMain(jid);
        return { text: `🎉 *Ticket Booked!*\n\n🎫 Ref: *${ref}*\n🎉 ${ev.title}\n📅 ${ev.date ? new Date(ev.date).toLocaleDateString() : 'TBA'}\n\nType *menu* for main menu.` };
      }
      case '2': return { text: fmtEventDetail(ev) };
      case '3': s.state = 'events_results'; return await showEventList(jid, s, '');
      default:  return { text: fmtEventDetail(ev) };
    }
  }

  // ── ACCOUNT MENU ───────────────────────────────────────────────────────────
  if (s.state === 'account_menu') {
    switch (lower) {
      case '1': return { text: await sellerDashboard(jid, s) };
      case '2': return { text: await landlordDashboard(jid, s) };
      case '3': return { text: await tenantDashboard(jid, s) };
      case '4': {
        const pr = await getProfile(s.phone);
        if (pr) return { text: `👤 *Your Profile*\n\n📛 ${pr.name || pr.fullName || 'User'}\n📧 ${pr.email || '—'}\n📞 +${s.phone}\n🗓️ Member since: ${pr.createdAt ? new Date(pr.createdAt).toLocaleDateString() : '—'}\n\n📱 bconnect.replit.app/settings.html\n0️⃣  ↩️ Back` };
        return { text: `👤 No profile found.\n\nRegister: bconnect.replit.app/login.html\nType *menu* for main menu.` };
      }
      default: return { text: ACCOUNT_MENU };
    }
  }

  // Direct dashboard states from intent detection
  if (s.state === 'seller_dash')   return { text: await sellerDashboard(jid, s) };
  if (s.state === 'landlord_dash') return { text: await landlordDashboard(jid, s) };
  if (s.state === 'tenant_dash')   return { text: await tenantDashboard(jid, s) };
  if (s.state === 'my_listings')   return { text: await myListings(jid, s) };
  if (s.state === 'my_orders')     return { text: await myOrders(jid, s) };

  // Sub-actions inside seller dash
  if (s.state === 'seller_dash_menu') {
    switch (lower) {
      case '1': return { text: await myListings(jid, s) };
      case '2': return { text: await myOrders(jid, s) };
      case '3': s.state = 'prod_create_title'; return { text: `➕ *Create Listing*\n\nWhat is the product title?` };
      default:  return { text: await sellerDashboard(jid, s) };
    }
  }

  // ── AI CHAT ────────────────────────────────────────────────────────────────
  if (s.state === 'ai_chat') {
    if (!text) return { text: `🤖 Go ahead, ask me anything!\n_(Type *menu* to exit AI mode)_` };
    const reply = await aiReply(text);
    return { text: reply || `🤖 I'm not sure about that. Type *menu* to return to main.` };
  }

  // ── FALLBACK ───────────────────────────────────────────────────────────────
  return { text: MAIN_MENU };
}

// Builds product detail message with optional image
function productDetailMsg(p, idx, total) {
  const imgUrl = resolveImgUrl(p);
  if (imgUrl) {
    return { image: { url: imgUrl }, caption: fmtProductDetail(p, idx, total) };
  }
  return { text: fmtProductDetail(p, idx, total) };
}

async function tenantPropertyText(jid, s) {
  const ti = await getTenantInfo(s.phone);
  if (ti?.property) return fmtPropertyDetail(ti.property);
  return `🏠 No property linked to your number.\n\nLink at: bconnect.replit.app/tenant-dashboard.html\nType *menu* for main menu.`;
}

async function myBookings(jid, s) {
  if (!_db) return `📋 View bookings: bconnect.replit.app`;
  const items = await dbFind('service_bookings', { clientPhone: { $regex: s.phone, $options: 'i' } }, 5);
  if (!items.length) return `📋 No bookings yet.\nType *menu* for main menu.`;
  let out = `📋 *Your Service Bookings*\n\n`;
  items.forEach((b, i) => { out += `${i+1}. ${b.serviceName||'Service'} — ${b.date} — ${b.status}\nRef: ${b.reference}\n\n`; });
  return out;
}

// ── Text extractor ─────────────────────────────────────────────────────────────
function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  ).trim();
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
function ensureAuthDir() {
  if (!fs.existsSync(_authDir)) fs.mkdirSync(_authDir, { recursive: true });
}

async function genQRDataUrl(qr) {
  try { return await QRCode.toDataURL(qr, { width: 280, margin: 2 }); }
  catch (_) { return null; }
}

function clearSession() {
  try { if (fs.existsSync(_authDir)) fs.rmSync(_authDir, { recursive: true, force: true }); }
  catch (_) {}
  _qrData = _qrDataUrl = _pairingCode = _pairingPhone = null;
  _connected = false;
}

function closeSocket() {
  try { if (_sock) { _sock.end(); _sock = null; } } catch (_) { _sock = null; }
}

// ── Connect ────────────────────────────────────────────────────────────────────
async function connect(usePairing, phoneNumber) {
  ensureAuthDir();
  const { state, saveCreds } = await useMultiFileAuthState(_authDir);

  _sock = makeWASocket({
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  if (usePairing && phoneNumber && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const clean = String(phoneNumber).replace(/\D/g, '');
        const code  = await _sock.requestPairingCode(clean);
        _pairingCode  = code;
        _pairingPhone = clean;
        _mode = 'pairing';
        console.log('[WhatsApp Bot] Pairing code ready:', code);
      } catch (e) { console.warn('[WhatsApp Bot] Pairing code error:', e.message); }
    }, 3000);
  }

  _sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      _qrData    = qr;
      _qrDataUrl = await genQRDataUrl(qr);
      _mode      = 'qr';
      _connected = false;
      console.log('[WhatsApp Bot] QR updated — visit /whatsapp-qr.html');
    }
    if (connection === 'open') {
      _connected   = true;
      _qrData      = null;
      _qrDataUrl   = null;
      _pairingCode = null;
      _restarting  = false;
      console.log('[WhatsApp Bot] ✅ Connected to WhatsApp');
    }
    if (connection === 'close') {
      _connected = false;
      const code     = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[WhatsApp Bot] Connection closed (code: ${code ?? 'unknown'})`);
      if (loggedOut) { console.log('[WhatsApp Bot] Logged out — clearing session'); clearSession(); }
      else if (!_restarting) { setTimeout(() => connect(false, null), 5000); }
    }
  });

  _sock.ev.on('creds.update', saveCreds);

  _sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) continue;
        if (jid.endsWith('@g.us')) continue; // skip groups for now

        const body  = extractText(msg);
        const isImg = !!(msg.message?.imageMessage);
        if (!body && !isImg) continue;

        console.log(`[WhatsApp Bot] 📩 ${jid}: ${body.slice(0, 60)}`);
        if (_db) { _db.collection('whatsapp_messages').insertOne({ jid, body, direction: 'inbound', createdAt: new Date() }).catch(() => {}); }

        // Get response object
        const response = await handleMessage(jid, msg);

        // Send — supports: { text }, { image, caption }, or { messages: [...] }
        async function sendOne(r) {
          if (r.image) {
            try {
              await _sock.sendMessage(jid, { image: r.image, caption: r.caption || '' });
            } catch (_) {
              await _sock.sendMessage(jid, { text: r.caption || r.text || '' });
            }
          } else {
            await _sock.sendMessage(jid, { text: r.text || '' });
          }
        }

        if (Array.isArray(response.messages)) {
          for (const part of response.messages) {
            await sendOne(part);
          }
        } else {
          await sendOne(response);
        }

        console.log(`[WhatsApp Bot] 📤 Replied to ${jid}`);
        if (_db) { _db.collection('whatsapp_messages').insertOne({ jid, body: response.text || '[image]', direction: 'outbound', createdAt: new Date() }).catch(() => {}); }

      } catch (err) {
        console.warn('[WhatsApp Bot] Error handling message:', err.message);
      }
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────
module.exports = {
  async startBot(db, genAI) {
    _db    = db;
    _genAI = genAI;
    await connect(false, null);
  },

  getQR() {
    return { qr: _qrData || null, dataUrl: _qrDataUrl || null, pairingCode: _pairingCode || null, pairingPhone: _pairingPhone || null, connected: _connected, mode: _mode };
  },

  async disconnectAndReset() {
    _restarting = true;
    try { if (_sock) await _sock.logout(); } catch (_) {}
    closeSocket(); clearSession(); _restarting = false;
  },

  async reconnect() {
    _restarting = true;
    closeSocket(); _connected = false; _restarting = false;
    await connect(false, null);
    return { success: true };
  },

  async refreshPairingCode(phoneNumber) {
    if (!phoneNumber) return { success: false, error: 'Phone number required' };
    const clean = String(phoneNumber).replace(/\D/g, '');
    if (_sock && !_sock.authState?.creds?.registered) {
      try {
        const code = await _sock.requestPairingCode(clean);
        _pairingCode = code; _pairingPhone = clean; _mode = 'pairing';
        return { success: true, pairingCode: code, pairingPhone: clean };
      } catch (_) {}
    }
    _restarting = true;
    closeSocket(); clearSession(); _restarting = false;
    await connect(true, clean);
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (_pairingCode) return { success: true, pairingCode: _pairingCode, pairingPhone: _pairingPhone || clean };
    }
    return { success: true, restarting: true };
  },
};
