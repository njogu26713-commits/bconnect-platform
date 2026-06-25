'use strict';
const { sendText, sendGallery, getListingImages, fmtPrice, truncate } = require('../utils');
const { setStep } = require('../state');

const FALLBACK_CATEGORIES = [
  { key: 'plumber',      label: '🔧 Plumber' },
  { key: 'electrician',  label: '⚡ Electrician' },
  { key: 'cleaner',      label: '🧹 Cleaner' },
  { key: 'mover',        label: '🚚 Mover' },
  { key: 'technician',   label: '🛠️ Technician' },
  { key: 'painter',      label: '🎨 Painter' },
  { key: 'carpenter',    label: '🪚 Carpenter' },
  { key: 'security',     label: '🛡️ Security' },
];

const CATEGORY_ICONS = {
  plumber: '🔧', electrician: '⚡', cleaner: '🧹', mover: '🚚',
  technician: '🛠️', painter: '🎨', carpenter: '🪚', security: '🛡️',
  catering: '🍽️', gardening: '🌿', laundry: '👕', driver: '🚗',
  tutor: '📚', salon: '✂️', mechanic: '🔩', IT: '💻',
  photography: '📷', delivery: '📦', doctor: '🏥', legal: '⚖️',
};

function iconFor(name) {
  if (!name) return '🔧';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(CATEGORY_ICONS)) {
    if (lower.includes(k.toLowerCase())) return v;
  }
  return '🔧';
}

async function getServiceCategories(db) {
  if (!db) return FALLBACK_CATEGORIES;
  try {
    const serviceFilter = {
      $or: [{ listing_type: 'service' }, { category: { $regex: /service/i } }],
      $and: [{ $or: [{ active: true }, { status: 'active' }] }]
    };
    const docs = await db.collection('properties').find(serviceFilter, {
      projection: { subcategory: 1, category: 1 }
    }).toArray();

    const seen = new Set();
    const cats = [];
    for (const d of docs) {
      const raw = d.subcategory || d.category || '';
      // skip generic "service" values
      if (!raw || /^service$/i.test(raw.trim())) continue;
      const key = raw.trim();
      if (!seen.has(key.toLowerCase())) {
        seen.add(key.toLowerCase());
        cats.push({ key, label: `${iconFor(key)} ${key}` });
      }
    }
    if (cats.length) return cats;
  } catch (e) {
    console.error('[Bot services] getServiceCategories error:', e.message);
  }
  return FALLBACK_CATEGORIES;
}

async function showServicesMenu(sock, jid, session, db) {
  const cats = await getServiceCategories(db);
  setStep(jid, 'services_browse', { serviceCategories: cats });
  let msg = '🔧 *Services Marketplace*\n_Pick a category to see all providers:_\n\n';
  cats.forEach((s, i) => { msg += `${i + 1}. ${s.label}\n`; });
  msg += '\n_Or *type* what you need (e.g. "plumber Westlands")._\n0️⃣  🏠 Main Menu';
  await sendText(sock, jid, msg);
}

async function searchServices(sock, jid, query, session, db, displayLabel = null, exactCategory = false) {
  await sendText(sock, jid, '🔍 _Searching services..._');
  try {
    let results = [];
    if (db) {
      const baseFilter = {
        $and: [
          { $or: [{ active: true }, { status: 'active' }] },
          { $or: [{ listing_type: 'service' }, { category: { $regex: /service/i } }] }
        ]
      };
      if (query) {
        if (exactCategory) {
          baseFilter.$and.push({ $or: [{ subcategory: query }, { category: query }] });
        } else {
          baseFilter.$and.push({ $or: [
            { title: { $regex: query, $options: 'i' } },
            { name:  { $regex: query, $options: 'i' } },
            { subcategory: { $regex: query, $options: 'i' } },
            { category: { $regex: query, $options: 'i' } },
            { description: { $regex: query, $options: 'i' } },
            { location: { $regex: query, $options: 'i' } }
          ]});
        }
      }
      results = await db.collection('properties').find(baseFilter).sort({ created_at: -1 }).limit(50).toArray();
    }

    if (!results.length) {
      await sendText(sock, jid,
        `😕 *No services found.*\n\n_Try a different search or:_\n0️⃣  🔙 Back to Categories\n*MENU* — Main Menu`);
      return;
    }

    setStep(jid, 'services_results', {
      serviceResults: results,
      serviceLabel: displayLabel || query,
    });

    const header = displayLabel || (query || 'All Services');
    const CHUNK = 20;
    for (let start = 0; start < results.length; start += CHUNK) {
      const chunk = results.slice(start, start + CHUNK);
      const isFirst = start === 0;
      const isLast  = start + CHUNK >= results.length;

      let msg = '';
      if (isFirst) {
        msg += `🔧 *${header}*\n`;
        msg += `_${results.length} provider(s) found — pick a number:_\n`;
        msg += `━━━━━━━━━━━━━━━━━\n`;
      }
      chunk.forEach((s, j) => {
        const idx  = start + j + 1;
        const rate = s.price ? fmtPrice(s.price) : 'On request';
        const loc  = s.location ? ` · ${s.location}` : '';
        msg += `${idx}. ${truncate(s.title || s.name, 40)} — _${rate}${loc}_\n`;
      });
      if (isLast) {
        msg += `\n━━━━━━━━━━━━━━━━━\n`;
        msg += `0️⃣  🔙 Back  |  *MENU* Home`;
      }
      await sendText(sock, jid, msg);
    }

  } catch (e) {
    console.error('[Bot services error]', e.message);
    await sendText(sock, jid, '❌ Error searching services. Type MENU to try again.');
  }
}

async function showServiceDetail(sock, jid, service, session) {
  const imgs = getListingImages(service);
  setStep(jid, 'service_detail', { selectedService: service, galleryImages: imgs });
  const price = service.price ? fmtPrice(service.price) + '/job' : 'Price on request';
  const phone = service.phone || service.contact || '';

  const detail =
    `🔧 *${service.title || service.name}*\n\n` +
    `💰 *Rate:* ${price}\n` +
    `📍 *Location:* ${service.location || 'Kenya'}\n` +
    (phone ? `📞 *Contact:* ${phone}\n` : '') +
    `\n${truncate(service.description, 200)}\n\n` +
    `Reply:\n1 - 📅 Book Now\n2 - 💬 Call / WhatsApp Provider\n3 - 🔙 Back to Results\n4 - 🏠 Main Menu` +
    (imgs.length > 1 ? `\n5 - 📸 More Photos (${imgs.length} photos)` : '');

  await sendGallery(sock, jid, imgs, detail);
}

module.exports = { showServicesMenu, searchServices, showServiceDetail, SERVICE_CATEGORIES: FALLBACK_CATEGORIES };
