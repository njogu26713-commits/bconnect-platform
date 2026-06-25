'use strict';
const { sendText, sendGallery, getListingImages, fmtPrice, truncate } = require('../utils');
const { setStep } = require('../state');

const FALLBACK_TYPES = [
  { key: 'bedsitter',   label: '🛏️ Bedsitter' },
  { key: 'studio',      label: '🏢 Studio Apartment' },
  { key: '1 bedroom',   label: '🚪 1 Bedroom' },
  { key: '2 bedroom',   label: '🏠 2 Bedrooms' },
  { key: '3 bedroom',   label: '🏡 3+ Bedrooms' },
  { key: 'shop office', label: '🏪 Shop / Office' },
  { key: 'land',        label: '🌳 Land / Plot' },
];

const FALLBACK_LOCATIONS = [
  { key: 'Nairobi',   label: '🌆 Nairobi' },
  { key: 'Mombasa',   label: '🌊 Mombasa' },
  { key: 'Kisumu',    label: '🌊 Kisumu' },
  { key: 'Nakuru',    label: '🏙️ Nakuru' },
  { key: 'Thika',     label: '🏙️ Thika' },
];

const HOUSING_PRICE_RANGES = [
  { label: '💚 Under KSh 5,000/mo',     min: 0,     max: 4999 },
  { label: '💛 KSh 5,000 – 15,000/mo',  min: 5000,  max: 15000 },
  { label: '🧡 KSh 15,000 – 30,000/mo', min: 15000, max: 30000 },
  { label: '🔴 KSh 30,000 – 60,000/mo', min: 30000, max: 60000 },
  { label: '💎 Over KSh 60,000/mo',     min: 60000, max: null },
  { label: '🔓 Any rent',               min: null,  max: null },
];

const TYPE_ICONS = {
  bedsitter: '🛏️', studio: '🏢', bedroom: '🚪', shop: '🏪',
  office: '🏪', land: '🌳', plot: '🌳', bungalow: '🏡',
  apartment: '🏢', flat: '🏢', mansion: '🏰', villa: '🏖️',
  townhouse: '🏘️', hostel: '🏨', commercial: '🏬',
};

const LOC_ICONS = {
  nairobi: '🌆', mombasa: '🌊', kisumu: '🌊', nakuru: '🏙️',
  thika: '🏙️', westlands: '📍', kilimani: '📍', karen: '🌿',
  kikuyu: '🌄', kitengela: '🌄', rongai: '🌄', ruiru: '🌄',
  embakasi: '📍', langata: '🌿', syokimau: '📍',
};

function typeIcon(name) {
  if (!name) return '🏠';
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(TYPE_ICONS)) {
    if (l.includes(k)) return v;
  }
  return '🏠';
}

function locIcon(name) {
  if (!name) return '📍';
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(LOC_ICONS)) {
    if (l.includes(k)) return v;
  }
  return '📍';
}

async function getHousingTypes(db) {
  if (!db) return FALLBACK_TYPES;
  try {
    const fields = { projection: { subcategory: 1, propertyType: 1, type: 1 } };
    const [lp, gp] = await Promise.all([
      db.collection('landlord_properties').find({}, fields).toArray(),
      db.collection('properties').find(
        { $or: [{ listing_type: 'housing' }, { category: { $regex: /housing|rental/i } }] }, fields
      ).toArray()
    ]);
    const seen = new Set();
    const types = [];
    for (const d of [...lp, ...gp]) {
      const raw = (d.subcategory || d.propertyType || d.type || '').trim();
      if (!raw || seen.has(raw.toLowerCase())) continue;
      seen.add(raw.toLowerCase());
      types.push({ key: raw, label: `${typeIcon(raw)} ${raw}` });
    }
    if (types.length) return types;
  } catch (e) {
    console.error('[Bot housing] getHousingTypes error:', e.message);
  }
  return FALLBACK_TYPES;
}

async function getHousingLocations(db) {
  if (!db) return FALLBACK_LOCATIONS;
  try {
    const fields = { projection: { location: 1 } };
    const [lp, gp] = await Promise.all([
      db.collection('landlord_properties').find({}, fields).toArray(),
      db.collection('properties').find(
        { $or: [{ listing_type: 'housing' }, { category: { $regex: /housing|rental/i } }] }, fields
      ).toArray()
    ]);
    const seen = new Set();
    const locs = [];
    for (const d of [...lp, ...gp]) {
      const raw = (d.location || '').trim();
      if (!raw || seen.has(raw.toLowerCase())) continue;
      seen.add(raw.toLowerCase());
      locs.push({ key: raw, label: `${locIcon(raw)} ${raw}` });
    }
    if (locs.length) return locs;
  } catch (e) {
    console.error('[Bot housing] getHousingLocations error:', e.message);
  }
  return FALLBACK_LOCATIONS;
}

async function showHousingMenu(sock, jid, session, db) {
  const types = await getHousingTypes(db);
  setStep(jid, 'housing_type', { housingTypes: types });
  let msg = '🏠 *Housing & Rentals*\n_Pick a property type:_\n\n';
  types.forEach((t, i) => { msg += `${i + 1}. ${t.label}\n`; });
  msg += '\n_Or *type* a location / keyword (e.g. "Kilimani 2br")._\n0️⃣  🏠 Main Menu';
  await sendText(sock, jid, msg);
}

async function showHousingLocations(sock, jid, housingType, session, db) {
  const locs = await getHousingLocations(db);
  setStep(jid, 'housing_location', { selectedHousingType: housingType, housingLocations: locs });
  let msg = `${housingType.label}\n\n_Choose a location:_\n\n`;
  locs.forEach((l, i) => { msg += `${i + 1}. ${l.label}\n`; });
  msg += `\n_Or *type* any area name._\n0️⃣  🔙 Back to Types`;
  await sendText(sock, jid, msg);
}

async function showPropertyCard(sock, jid, results, idx, session) {
  const p = results[idx];
  if (!p) return;
  const total = results.length;
  const imgs = getListingImages(p);
  setStep(jid, 'housing_card', { housingResults: results, housingCardIndex: idx });

  const rent  = fmtPrice(p.price || 0);
  const loc   = p.location ? `📍 ${p.location}\n` : '';
  const type  = p.subcategory ? `🏡 ${p.subcategory}\n` : '';
  const avail = p.rooms_remaining ? `✅ ${p.rooms_remaining} unit(s) available\n` : '';
  const caption =
    `🏠 *${truncate(p.title, 50)}*\n` +
    `💰 ${rent}/mo\n` +
    loc + type + avail +
    `\n_${idx + 1} of ${total} properties_\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    (idx > 0        ? `1 - ◀ Previous\n` : '') +
    (idx < total-1  ? `2 - ▶ Next\n`     : '') +
    `3 - 📋 Full Details\n0 - 🔙 Back`;

  if (imgs.length) {
    const resolved = require('../utils').resolveImageUrl(imgs[0]);
    if (resolved) {
      try {
        await sock.sendMessage(jid, { image: { url: resolved }, caption });
        return;
      } catch {}
    }
  }
  await sendText(sock, jid, caption);
}

async function showHousingPriceMenu(sock, jid, query, session) {
  setStep(jid, 'housing_price', { pendingHousingQuery: query });
  let msg = '💰 *What\'s your monthly budget?*\n\n';
  HOUSING_PRICE_RANGES.forEach((r, i) => { msg += `${i + 1}. ${r.label}\n`; });
  msg += '\n0️⃣  🔙 Back';
  await sendText(sock, jid, msg);
}

async function searchHousing(sock, jid, query, session, db, minPrice = null, maxPrice = null) {
  await sendText(sock, jid, '🔍 _Searching properties..._');
  try {
    let results = [];
    if (db) {
      // landlord_properties
      const lpQuery = {
        $or: [
          { listOnMarketplace: true, marketplaceStatus: 'approved' },
          { listOnMarketplace: true, marketplaceStatus: { $exists: false } }
        ]
      };
      const lpAnd = [];
      if (query && query !== 'all') {
        lpAnd.push({ $or: [
          { name:        { $regex: query, $options: 'i' } },
          { location:    { $regex: query, $options: 'i' } },
          { subcategory: { $regex: query, $options: 'i' } },
          { propertyType:{ $regex: query, $options: 'i' } },
          { description: { $regex: query, $options: 'i' } },
        ]});
      }
      if (minPrice !== null || maxPrice !== null) {
        const rf = {};
        if (minPrice !== null) rf.$gte = minPrice;
        if (maxPrice !== null) rf.$lte = maxPrice;
        lpAnd.push({ $or: [{ rent: rf }, { monthlyRent: rf }] });
      }
      if (lpAnd.length) lpQuery.$and = lpAnd;

      // properties collection
      const gp = { $and: [
        { $or: [{ active: true }, { status: 'active' }] },
        { $or: [{ listing_type: 'housing' }, { category: { $regex: /housing|rental/i } }] }
      ]};
      if (query && query !== 'all') {
        gp.$and.push({ $or: [
          { title:    { $regex: query, $options: 'i' } },
          { name:     { $regex: query, $options: 'i' } },
          { location: { $regex: query, $options: 'i' } },
          { subcategory: { $regex: query, $options: 'i' } },
          { description: { $regex: query, $options: 'i' } },
        ]});
      }
      if (minPrice !== null || maxPrice !== null) {
        const pf = {};
        if (minPrice !== null) pf.$gte = minPrice;
        if (maxPrice !== null) pf.$lte = maxPrice;
        gp.$and.push({ price: pf });
      }

      const [landlordProps, genProps] = await Promise.all([
        db.collection('landlord_properties').find(lpQuery).sort({ createdAt: -1 }).limit(30).toArray(),
        db.collection('properties').find(gp).sort({ created_at: -1 }).limit(30).toArray()
      ]);

      const seen = new Set();
      const combined = [];
      for (const p of landlordProps) {
        const id = String(p._id);
        if (!seen.has(id)) { seen.add(id); combined.push({ _id: p._id, title: p.name || 'Property', price: p.rent || p.monthlyRent || 0, location: p.location || 'Kenya', subcategory: p.subcategory || p.propertyType || '', description: p.description || '', image_url: p.image_url || p.imageUrl || p.image || '', rooms_remaining: p.roomsRemaining || 0, phone: p.phone || '', code: p.code || '' }); }
      }
      for (const p of genProps) {
        const id = String(p._id);
        if (!seen.has(id)) { seen.add(id); combined.push({ ...p, title: p.title || p.name || 'Property', price: p.price || p.rent || 0 }); }
      }
      results = combined.slice(0, 50);
    }

    if (!results.length) {
      const areaHint = query && query !== 'all' ? ` for *"${query}"*` : '';
      setStep(jid, 'housing_type', { housingTypes: (session && session.data && session.data.housingTypes) || [] });
      await sendText(sock, jid,
        `😕 *No properties found${areaHint}.*\n\n` +
        `_Check your spelling and try typing a location name below — for example:_\n` +
        `• Nairobi\n• Kilimani\n• Mombasa\n• Thika\n• Westlands\n\n` +
        `_Or pick a property type from the list:_\n0️⃣  🔙 Back  |  *MENU* Home`
      );
      return;
    }

    // Show first card — user swipes through with 1/2
    await showPropertyCard(sock, jid, results, 0, session);

  } catch (e) {
    console.error('[Bot housing error]', e.message);
    await sendText(sock, jid, '❌ Error searching properties. Type MENU to try again.');
  }
}

async function showPropertyDetail(sock, jid, property, session) {
  const imgs = getListingImages(property);
  setStep(jid, 'property_detail', { selectedProperty: property, galleryImages: imgs });
  const price = fmtPrice(property.price || 0);
  const avail = property.rooms_remaining ? `✅ *${property.rooms_remaining} unit(s) available*\n` : '';

  const detail =
    `🏠 *${property.title}*\n\n` +
    `💰 *Rent:* ${price}/month\n` +
    `📍 *Location:* ${property.location || 'Kenya'}\n` +
    (property.subcategory ? `🏡 *Type:* ${property.subcategory}\n` : '') +
    avail +
    `\n${truncate(property.description, 200)}\n\n` +
    `Reply:\n1 - 💳 Pay Deposit\n2 - 📞 Contact Landlord\n3 - 📅 Book Viewing\n4 - 🔙 Back to Results\n5 - 🏠 Main Menu` +
    (imgs.length > 1 ? `\n6 - 📸 More Photos (${imgs.length} photos)` : '');

  await sendGallery(sock, jid, imgs, detail);
}

// Keep legacy exports for backward compat
module.exports = {
  showHousingMenu, showHousingLocations, showHousingPriceMenu,
  searchHousing, showPropertyDetail, showPropertyCard,
  HOUSING_TYPES: FALLBACK_TYPES,
  HOUSING_LOCATIONS: FALLBACK_LOCATIONS,
  HOUSING_PRICE_RANGES,
};
