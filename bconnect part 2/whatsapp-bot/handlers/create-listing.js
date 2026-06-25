'use strict';
const { sendText } = require('../utils');
const { setStep, getSession } = require('../state');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

async function uploadToCloudinary(buffer, filename) {
  try {
    const cloudinary = require('cloudinary').v2;
    return await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'bconnect_whatsapp', resource_type: 'image', public_id: filename },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      stream.end(buffer);
    });
  } catch (e) {
    console.error('[Bot cloudinary error]', e.message);
    return null;
  }
}

async function handleCreateFlow(sock, jid, msg, session, db) {
  const step = session.step;
  const text = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption || ''
  ).trim();

  if (text.toUpperCase() === 'CANCEL') {
    setStep(jid, 'main');
    await sendText(sock, jid, '❌ Listing creation cancelled.\n\nType *MENU* to go back.');
    return;
  }

  if (step === 'create_photo') {
    if (!msg.message?.imageMessage) {
      await sendText(sock, jid, '📸 Please send a *photo* of your product.\n\nType *CANCEL* to stop.');
      return;
    }
    await sendText(sock, jid, '⏳ Uploading photo...');
    let imageUrl = null;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const fname = 'product_' + Date.now();
      imageUrl = await uploadToCloudinary(buffer, fname);
    } catch (e) {
      console.error('[Bot photo upload error]', e.message);
    }
    setStep(jid, 'create_title', { listingImageUrl: imageUrl });
    await sendText(sock, jid, imageUrl
      ? '✅ Photo uploaded!\n\nStep 2 of 4: What is the *title/name* of your product?\n\nType *CANCEL* to stop.'
      : '⚠️ Photo upload failed, continuing without image.\n\nStep 2 of 4: What is the *title/name* of your product?\n\nType *CANCEL* to stop.');
    return;
  }

  if (step === 'create_title') {
    if (!text || text.length < 2) {
      await sendText(sock, jid, '✏️ Please type a *title* for your product (e.g. "Redmi 13C 128GB").\n\nType *CANCEL* to stop.');
      return;
    }
    setStep(jid, 'create_price', { listingTitle: text });
    await sendText(sock, jid, `✅ Title: "${text}"\n\nStep 3 of 4: What is the *price* in KSh?\n\nJust type the number (e.g. *14500*).\nType *CANCEL* to stop.`);
    return;
  }

  if (step === 'create_price') {
    const price = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!price || price < 1) {
      await sendText(sock, jid, '💰 Please enter a valid *price* in KSh (numbers only, e.g. *14500*).\n\nType *CANCEL* to stop.');
      return;
    }
    setStep(jid, 'create_desc', { listingPrice: price });
    await sendText(sock, jid, `✅ Price: KSh ${price.toLocaleString()}\n\nStep 4 of 4: Give a short *description* of your product.\n\nInclude condition, features, and anything buyers should know.\nType *CANCEL* to stop.`);
    return;
  }

  if (step === 'create_desc') {
    if (!text || text.length < 5) {
      await sendText(sock, jid, '📝 Please type a *description* for your product.\n\nType *CANCEL* to stop.');
      return;
    }

    const { listingTitle, listingPrice, listingImageUrl } = session.data;
    const { phoneFromJid } = require('../utils');
    const phone = phoneFromJid(jid);

    let savedId = null;
    if (db) {
      try {
        let profile = await db.collection('profiles').findOne({
          $or: [{ phone }, { phone: '+' + phone }]
        });
        const listing = {
          title: listingTitle,
          name: listingTitle,
          price: listingPrice,
          description: text,
          image_url: listingImageUrl || '',
          listing_type: 'product',
          category: 'general',
          active: true,
          seller_phone: phone,
          seller_id: profile ? String(profile._id) : null,
          source: 'whatsapp_bot',
          created_at: new Date()
        };
        const result = await db.collection('properties').insertOne(listing);
        savedId = result.insertedId;
      } catch (e) {
        console.error('[Bot create listing DB error]', e.message);
      }
    }

    setStep(jid, 'main');
    if (savedId) {
      await sendText(sock, jid,
        `✅ *Listing Created!*\n\n🛍️ *${listingTitle}*\n💰 KSh ${listingPrice.toLocaleString()}\n\nYour product is now *live* on BConnect marketplace!\n\nType *MENU* to go back.`);
    } else {
      await sendText(sock, jid, '❌ Could not save listing right now. Please try via bconnect.co.ke\n\nType *MENU* to go back.');
    }
    return;
  }
}

module.exports = { handleCreateFlow };
