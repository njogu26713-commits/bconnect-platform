'use strict';
const { sendText, sendImage } = require('../utils');
const { setStep } = require('../state');

const SYSTEM_PROMPT = `You are BConnect Bot — the friendly AI assistant for BConnect, Kenya's all-in-one marketplace. You chat with users on WhatsApp.

BConnect has four main categories:
• 🏠 Housing & Rentals — bedsitters, studios, 1BR/2BR/3BR apartments, houses, bungalows across Kenya
• 🛍️ Products — electronics, phones, laptops, clothes, furniture, household items
• 🔧 Services — plumbers, electricians, cleaners, movers, painters, carpenters, fundis
• 🎉 Events — concerts, expos, conferences, parties, festivals

Your personality:
- Warm, helpful, and conversational — like a knowledgeable Kenyan friend
- Use light Kenyan expressions naturally (e.g. "sawa", "poa", "karibu")
- Keep replies concise — 1 to 4 short sentences max (WhatsApp, not email)
- Use KSh for prices, reference Nairobi neighbourhoods (Westlands, Kilimani, CBD, Kasarani, etc.)
- M-Pesa is how most people pay here

When the user asks to find something:
- Acknowledge what they need warmly
- The system will automatically show them matching listings from the database
- You can comment on what was found or offer to narrow the search

When they ask general questions (not searching):
- Answer helpfully and briefly
- If relevant, mention they can browse or search on BConnect

Never give long lists. Never use markdown formatting like ** or # — plain WhatsApp text only.
If you don't know something specific (e.g. exact prices, availability), be honest and encourage them to check the listing.
Always end with a natural follow-up or offer to help further.`;

const MODELS = ['grok-3-mini', 'grok-3'];

function detectSearchIntent(text) {
  const t = text.toLowerCase();
  const searchWords = /\b(show|find|search|looking for|need|want|list|get|display|any|available|i want|i need|where can|do you have|give me|send me|photo of|image of|nataka|tafuta|ninatafuta|ninahitaji)\b/;

  if (/\b(house|flat|apartment|bedsitter|studio|1br|2br|3br|bedroom|bungalow|mansion|rent|rental|property|nyumba|chumba)\b/.test(t)) return 'housing';
  if (/\b(plumber|electrician|cleaner|mover|technician|painter|carpenter|fundi|repair|service|tailor|mechanic)\b/.test(t)) return 'services';
  if (/\b(event|concert|show|ticket|festival|conference|expo|party|gig|show)\b/.test(t)) return 'events';

  if (!searchWords.test(t)) return null;
  if (/\b(product|item|phone|laptop|clothes|shoes|electronics|furniture|food|sofa|fridge|tv|gadget|bag|watch)\b/.test(t)) return 'products';
  return null;
}

function extractKeyword(text) {
  return text
    .replace(/\b(show me|find me|search for|i want|i need|looking for|get me|send me|give me|any|available|do you have|photo of|image of|nataka|ninatafuta|ninahitaji|tafuta|show|find|search|get|list|display)\b/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
}

function getItemImage(item) {
  return item.image_url || item.imageUrl || item.image || item.propertyImage ||
    item.thumbnail || (Array.isArray(item.images) ? item.images[0] : null) || null;
}

async function queryDB(db, intent, keyword) {
  try {
    if (intent === 'housing') {
      const q = { $or: [{ listOnMarketplace: true }, { active: true, listing_type: 'housing' }] };
      if (keyword) q.$and = [{ $or: [
        { name: { $regex: keyword, $options: 'i' } },
        { location: { $regex: keyword, $options: 'i' } },
        { subcategory: { $regex: keyword, $options: 'i' } },
        { description: { $regex: keyword, $options: 'i' } }
      ]}];
      const rows = await db.collection('landlord_properties').find(q).sort({ createdAt: -1 }).limit(5).toArray();
      return rows.map(p => ({
        title: p.name || 'Property', price: p.rent || p.monthlyRent || 0,
        location: p.location || '', subcategory: p.subcategory || '',
        image_url: p.image_url || p.imageUrl || p.image || p.propertyImage || ''
      }));
    }

    if (intent === 'products') {
      const q = { active: true, listing_type: { $nin: ['service', 'housing'] } };
      if (keyword) q.$or = [
        { title: { $regex: keyword, $options: 'i' } },
        { name: { $regex: keyword, $options: 'i' } },
        { category: { $regex: keyword, $options: 'i' } },
        { description: { $regex: keyword, $options: 'i' } }
      ];
      return db.collection('properties').find(q).sort({ created_at: -1 }).limit(5).toArray();
    }

    if (intent === 'services') {
      const q = { active: true, $or: [{ listing_type: 'service' }, { category: { $regex: /service/i } }] };
      if (keyword) q.$and = [{ $or: [
        { title: { $regex: keyword, $options: 'i' } },
        { name: { $regex: keyword, $options: 'i' } },
        { category: { $regex: keyword, $options: 'i' } },
        { location: { $regex: keyword, $options: 'i' } }
      ]}];
      return db.collection('properties').find(q).sort({ created_at: -1 }).limit(5).toArray();
    }

    if (intent === 'events') {
      const rows = await db.collection('events')
        .find({ active: true }).sort({ event_date: 1 }).limit(5).toArray();
      return rows.map(e => ({
        title: e.title, price: e.price, location: e.location,
        image_url: e.image_url || e.imageUrl || (Array.isArray(e.images) ? e.images[0] : null)
      }));
    }
  } catch (e) {
    console.error('[Bot AI DB error]', e.message);
  }
  return [];
}

async function sendListingsToUser(sock, jid, items, kind) {
  if (!items || !items.length) return false;

  const icons = { properties: '🏠', products: '🛍️', services: '🔧', events: '🎉' };
  const icon = icons[kind] || '📋';

  let msg = `${icon} *${kind.charAt(0).toUpperCase() + kind.slice(1)} found:*\n\n`;
  items.forEach((item, i) => {
    const title = item.title || item.name || 'Item';
    const price = item.price || item.rent || item.monthlyRent || 0;
    msg += `${i + 1}. ${title}`;
    if (price) msg += `  —  KSh ${parseInt(price).toLocaleString()}`;
    if (item.location) msg += `  📍 ${item.location}`;
    msg += '\n';
  });
  msg += '\nType *MENU* → choose a category → reply with a number to see full details & book.';
  await sendText(sock, jid, msg);

  const featured = items.find(i => getItemImage(i));
  if (featured) {
    const img = getItemImage(featured);
    const title = featured.title || featured.name || 'Item';
    const price = featured.price || featured.rent || featured.monthlyRent;
    const caption = `📌 *${title}*` +
      (price ? `\nKSh ${parseInt(price).toLocaleString()}` : '') +
      (featured.location ? `\n📍 ${featured.location}` : '');
    await sendImage(sock, jid, img, caption);
  }
  return true;
}

async function askGrok(genAI, history, userText, dbSummary) {
  const userMsg = dbSummary
    ? `${userText}\n\n[System note: The database returned these results — ${dbSummary}. Acknowledge naturally, don't list them again.]`
    : userText;

  // Build OpenAI-format messages from history
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const turn of history.slice(0, -1)) {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: turn.parts[0].text
    });
  }
  messages.push({ role: 'user', content: userMsg });

  for (const model of MODELS) {
    try {
      const res = await genAI.chat.completions.create({
        model,
        messages,
        max_tokens: 300,
        temperature: 0.7
      });
      return res.choices[0].message.content.trim();
    } catch (e) {
      const msg = e.message || '';
      const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('RESOURCE_EXHAUSTED');
      const isKeyBad = msg.includes('401') || msg.includes('403') || msg.includes('API key') || msg.includes('invalid');
      if (isQuota) { console.warn(`[AI] ${model} quota/rate hit, trying next`); continue; }
      if (isKeyBad) { console.warn(`[AI] ${model} key invalid — skipping all models`); return null; }
      throw e;
    }
  }
  return null;
}

async function handleAI(sock, jid, text, session, genAI, db) {
  if (!session.data.chatHistory) session.data.chatHistory = [];

  const intent = db ? detectSearchIntent(text) : null;
  const keyword = intent ? extractKeyword(text) : '';

  const [dbResults] = await Promise.all([
    intent ? queryDB(db, intent, keyword) : Promise.resolve([])
  ]);

  let dbSummary = null;
  if (dbResults && dbResults.length) {
    const kindMap = { housing: 'properties', products: 'products', services: 'services', events: 'events' };
    await sendListingsToUser(sock, jid, dbResults, kindMap[intent]);
    dbSummary = `${dbResults.length} ${intent} result(s) including: ` +
      dbResults.slice(0, 3).map(r => r.title || r.name || 'item').join(', ');
  } else if (intent) {
    await sendText(sock, jid, `😕 No ${intent} found matching that. Let me know if you want to try a different search.`);
  }

  session.data.chatHistory.push({ role: 'user', parts: [{ text }] });
  if (session.data.chatHistory.length > 30) {
    session.data.chatHistory = session.data.chatHistory.slice(-30);
  }

  if (!genAI) {
    if (!intent || !dbResults.length) {
      await sendText(sock, jid,
        '🤖 AI chat is briefly unavailable, but I can still help!\n\n' +
        'Try asking:\n' +
        '• _"Houses in Kilimani"_\n' +
        '• _"I need a plumber"_\n' +
        '• _"Show me phones under 20k"_\n\n' +
        'Or type *MENU* to browse everything.');
    }
    return;
  }

  try {
    const reply = await askGrok(genAI, session.data.chatHistory, text, dbSummary);
    if (reply) {
      session.data.chatHistory.push({ role: 'model', parts: [{ text: reply }] });
      await sendText(sock, jid, reply);
    } else if (!dbResults.length) {
      await sendText(sock, jid,
        '🤖 AI chat is briefly unavailable, but I can still help!\n\n' +
        'Try asking:\n' +
        '• _"Houses in Kilimani"_\n' +
        '• _"I need a plumber"_\n' +
        '• _"Show me phones under 20k"_\n\n' +
        'Or type *MENU* to browse everything.');
    }
  } catch (e) {
    console.error('[Bot AI Grok error]', e.message);
    if (!intent || !dbResults.length) {
      await sendText(sock, jid,
        '🤖 AI chat is briefly unavailable, but I can still help!\n\n' +
        'Try asking:\n' +
        '• _"Houses in Kilimani"_\n' +
        '• _"I need a plumber"_\n' +
        '• _"Show me phones under 20k"_\n\n' +
        'Or type *MENU* to browse everything.');
    }
  }
}

async function startAIChat(sock, jid, session) {
  if (session.step !== 'ai') {
    setStep(jid, 'ai', { chatHistory: [] });
    await sendText(sock, jid,
      '🤖 *BConnect AI*\n\n' +
      'Habari! I\'m your BConnect assistant. Just talk to me naturally!\n\n' +
      'I can:\n' +
      '• Find houses, rentals & apartments\n' +
      '• Search products & electronics\n' +
      '• Locate services (plumbers, fundis, etc)\n' +
      '• Show upcoming events\n' +
      '• Answer questions about BConnect\n\n' +
      'Try: _"I need a 2 bedroom in Westlands"_\n' +
      'Or: _"Find me a plumber near Kilimani"_\n\n' +
      '_Type MENU anytime to go back._');
  } else {
    setStep(jid, 'ai');
  }
}

module.exports = { handleAI, startAIChat };
