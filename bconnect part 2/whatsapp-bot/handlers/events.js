'use strict';
const { sendText, sendGallery, getListingImages, fmtPrice, truncate, resolveImageUrl } = require('../utils');
const { setStep } = require('../state');

function fmtDate(d) {
  if (!d) return 'TBD';
  return new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateLong(d) {
  if (!d) return 'TBD';
  return new Date(d).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function showEventCard(sock, jid, results, idx, session) {
  const e = results[idx];
  if (!e) return;
  const total = results.length;
  const imgs = getListingImages(e);
  setStep(jid, 'events_card', { eventResults: results, eventCardIndex: idx });

  const variants  = e.variants || e.ticket_types || [];
  const minPrice  = variants.length ? Math.min(...variants.map(v => Number(v.price || 0))) : (e.price || 0);
  const priceLbl  = variants.length ? `From ${fmtPrice(minPrice)}` : (e.price ? fmtPrice(e.price) : 'Free');

  const caption =
    `🎉 *${truncate(e.title, 50)}*\n` +
    `📅 ${fmtDate(e.event_date)}\n` +
    `📍 ${e.location || 'Kenya'}\n` +
    `🎫 ${priceLbl}\n` +
    `\n_${idx + 1} of ${total} events_\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    (idx > 0       ? `1 - ◀ Previous\n` : '') +
    (idx < total-1 ? `2 - ▶ Next\n`     : '') +
    `3 - 📋 Full Details\n0 - 🔙 Back`;

  if (imgs.length) {
    const resolved = resolveImageUrl(imgs[0]);
    if (resolved) {
      try { await sock.sendMessage(jid, { image: { url: resolved }, caption }); return; } catch {}
    }
  }
  await sendText(sock, jid, caption);
}

async function showEventsMenu(sock, jid, session, db) {
  await sendText(sock, jid, '🎉 _Loading upcoming events..._');
  try {
    let results = [];
    if (db) {
      results = await db.collection('events')
        .find({ active: true, event_date: { $gte: new Date() } })
        .sort({ event_date: 1 })
        .limit(30)
        .toArray();
      if (!results.length) {
        results = await db.collection('events').find({ active: true }).sort({ event_date: -1 }).limit(30).toArray();
      }
    }
    if (!results.length) {
      setStep(jid, 'events_list');
      await sendText(sock, jid, '😕 No upcoming events right now.\n\nCheck back soon or type *MENU* to go back.');
      return;
    }
    await showEventCard(sock, jid, results, 0, session);
  } catch (e) {
    console.error('[Bot events error]', e.message);
    await sendText(sock, jid, '❌ Error loading events. Type MENU to try again.');
  }
}

async function showEventDetail(sock, jid, event, session) {
  const variants = event.variants || event.ticket_types || [];
  const imgs = getListingImages(event);
  let ticketLine = '';
  if (variants.length) {
    const minPrice = Math.min(...variants.map(v => Number(v.price || 0)));
    const totalAvail = variants.reduce((sum, v) => {
      const a = (v.tickets_available != null) ? (v.tickets_available - (v.tickets_sold || 0)) : null;
      return a != null ? sum + a : sum;
    }, 0);
    ticketLine = `🎫 *Tickets:* From ${fmtPrice(minPrice)} • ${variants.length} type${variants.length > 1 ? 's' : ''}\n`;
    if (totalAvail > 0) ticketLine += `✅ *Available:* ${totalAvail} left\n`;
  } else {
    ticketLine = `💰 *Price:* ${event.price ? fmtPrice(event.price) : 'Free'}\n`;
    if (event.tickets_available != null) ticketLine += `🎫 *Tickets Left:* ${event.tickets_available - (event.tickets_sold || 0)}\n`;
  }

  const bookOption = variants.length ? '1 - 🎟️ View Ticket Types' : '1 - 🎫 Book Ticket';
  setStep(jid, 'event_detail', { selectedEvent: event, galleryImages: imgs });

  const detail =
    `🎉 *${event.title}*\n\n` +
    `📅 *Date:* ${fmtDateLong(event.event_date)}\n` +
    `📍 *Venue:* ${event.location || 'Kenya'}\n` +
    ticketLine +
    `\n${truncate(event.description, 200)}\n\n` +
    `Reply:\n${bookOption}\n2 - ℹ️ More Info\n3 - 🔙 Back to Events\n4 - 🏠 Main Menu` +
    (imgs.length > 1 ? `\n5 - 📸 More Photos (${imgs.length} photos)` : '');

  await sendGallery(sock, jid, imgs, detail);
}

async function showEventVariants(sock, jid, event, session) {
  const variants = event.variants || event.ticket_types || [];
  setStep(jid, 'event_variants', { selectedEvent: event });
  if (!variants.length) {
    await sendText(sock, jid,
      `🎫 *Ready to buy ${event.title}*, create a free account on BConnect:\nhttps://bconnect.co.ke\n\nType *MENU* to go back.`
    );
    return;
  }
  let msg = `🎟️ *${event.title}*\n*Select Your Ticket Type*\n\n`;
  variants.forEach((v, i) => {
    const available = v.tickets_available != null ? v.tickets_available - (v.tickets_sold || 0) : null;
    const soldOut = available !== null && available <= 0;
    const availText = soldOut ? '❌ Sold Out' : (available !== null ? `✅ ${available} left` : '✅ Available');
    msg += `*${i + 1}.* ${v.name || `Ticket ${i + 1}`}\n   💰 ${fmtPrice(v.price || 0)} • ${availText}\n`;
    if (v.description) msg += `   _${truncate(v.description, 80)}_\n`;
    msg += '\n';
  });
  msg += `Reply with a *number* to select.\n*0* - 🔙 Back\nType *MENU* for main menu.`;
  await sendText(sock, jid, msg);
}

async function showVariantBooking(sock, jid, event, variant) {
  setStep(jid, 'event_variant_detail', { selectedEvent: event, selectedVariant: variant });
  const available = variant.tickets_available != null ? variant.tickets_available - (variant.tickets_sold || 0) : null;
  if (available !== null && available <= 0) {
    await sendText(sock, jid, `❌ *${variant.name}* tickets are *Sold Out*.\n\nReply:\n1 - 🔙 Back to Ticket Types\n2 - 🏠 Main Menu`);
    return;
  }
  const availText = available !== null ? `✅ *${available} tickets left*\n` : '';
  await sendText(sock, jid,
    `🎟️ *${event.title}*\n🏷️ *${variant.name || 'Ticket'}*\n\n` +
    `💰 *Price:* ${fmtPrice(variant.price || 0)}\n` + availText +
    (variant.description ? `ℹ️ ${truncate(variant.description, 120)}\n` : '') +
    `\n🛍️ *Ready to book?* Create a free account on BConnect:\nhttps://bconnect.co.ke\n\n` +
    `Reply:\n1 - 🔙 Back to Ticket Types\n2 - 🏠 Main Menu`
  );
}

module.exports = { showEventsMenu, showEventCard, showEventDetail, showEventVariants, showVariantBooking };
