'use strict';
const { sendText, fmtPrice } = require('../utils');
const { setStep } = require('../state');
const { phoneFromJid } = require('../utils');

async function showAccountMenu(sock, jid, session, db) {
  const phone = phoneFromJid(jid);
  setStep(jid, 'account');

  let profile = null;
  if (db) {
    try {
      profile = await db.collection('profiles').findOne({
        $or: [{ phone }, { phone: '+' + phone }, { phone: '0' + phone.slice(3) }]
      });
    } catch (_) {}
  }

  if (profile) {
    session.data.profile = profile;
    const name = profile.name || 'there';
    let msg = `👤 *Hi ${name}!*\n📱 Phone: +${phone}\n\n`;

    if (profile.role === 'landlord' || profile.role === 'admin') {
      msg += '1 - 🏠 Landlord Dashboard\n2 - 📋 My Properties\n3 - 👥 My Tenants\n';
    } else if (profile.role === 'seller') {
      msg += '1 - 🛍️ Seller Dashboard\n2 - 📦 My Listings\n3 - 📬 My Orders\n';
    } else {
      msg += '1 - 🏠 Tenant Dashboard\n2 - 💰 Rent Status\n3 - 🔧 Maintenance Request\n';
    }
    msg += '4 - 🔙 Main Menu\n\nReply with a number.';
    await sendText(sock, jid, msg);
  } else {
    await sendText(sock, jid,
      '👤 *My Account*\n\nYou\'re not linked to a BConnect account.\n\n' +
      'To link your account, register at *bconnect.co.ke* with this phone number.\n\n' +
      '1 - 🛍️ Register as Seller\n2 - 🏠 Register as Landlord\n3 - 🔙 Main Menu\n\nReply with a number.');
  }
}

async function showSellerDashboard(sock, jid, session, db) {
  setStep(jid, 'seller_dashboard');
  const phone = phoneFromJid(jid);

  try {
    let profile = session.data.profile;
    if (!profile && db) {
      profile = await db.collection('profiles').findOne({
        $or: [{ phone }, { phone: '+' + phone }]
      });
    }
    if (!profile) {
      await sendText(sock, jid, '❌ Account not found. Visit bconnect.co.ke to register.\n\nType MENU to go back.');
      return;
    }

    let listings = [];
    if (db) {
      listings = await db.collection('properties').find({ seller_id: String(profile._id), active: true }).limit(5).toArray();
    }

    let msg = `🛍️ *Seller Dashboard*\nWelcome, ${profile.name}!\n\n`;
    msg += `📦 *Active Listings:* ${listings.length}\n\n`;
    if (listings.length) {
      listings.forEach((l, i) => { msg += `${i + 1}. ${l.title || l.name} — ${fmtPrice(l.price || 0)}\n`; });
    } else {
      msg += '_No active listings yet._\n';
    }
    msg += '\n1 - ➕ Create New Listing\n2 - 📬 View Orders\n3 - 🔙 Main Menu\n\nReply with a number.';
    await sendText(sock, jid, msg);
  } catch (e) {
    await sendText(sock, jid, '❌ Error loading dashboard. Type MENU to go back.');
  }
}

async function showTenantDashboard(sock, jid, session, db) {
  setStep(jid, 'tenant_dashboard');
  const phone = phoneFromJid(jid);

  try {
    let profile = session.data.profile;
    if (!profile && db) {
      profile = await db.collection('profiles').findOne({
        $or: [{ phone }, { phone: '+' + phone }]
      });
    }
    if (!profile) {
      await sendText(sock, jid, '❌ Account not found. Visit bconnect.co.ke to register.\n\nType MENU to go back.');
      return;
    }

    let tenancy = null;
    let property = null;
    if (db) {
      tenancy = await db.collection('tenants').findOne({ profileId: String(profile._id) });
      if (tenancy) {
        const { ObjectId } = require('mongodb');
        try { property = await db.collection('landlord_properties').findOne({ _id: new ObjectId(tenancy.propertyId) }); } catch (_) {}
      }
    }

    let msg = `🏠 *Tenant Dashboard*\nWelcome, ${profile.name}!\n\n`;
    if (tenancy && property) {
      const due = tenancy.nextDueDate ? new Date(tenancy.nextDueDate).toLocaleDateString('en-KE') : 'N/A';
      msg += `🏡 *Property:* ${property.name}\n📍 *Location:* ${property.location || 'N/A'}\n💰 *Monthly Rent:* ${fmtPrice(tenancy.monthlyRent || property.rent)}\n📅 *Next Due:* ${due}\n\n`;
    } else {
      msg += '_No linked property found._\n\n';
    }
    msg += '1 - 💰 Pay Rent (M-Pesa)\n2 - 🔧 Submit Maintenance\n3 - 📋 Rent History\n4 - 🔙 Main Menu\n\nReply with a number.';
    await sendText(sock, jid, msg);
  } catch (e) {
    await sendText(sock, jid, '❌ Error loading dashboard. Type MENU to go back.');
  }
}

async function showLandlordDashboard(sock, jid, session, db) {
  setStep(jid, 'landlord_dashboard');
  const phone = phoneFromJid(jid);

  try {
    let profile = session.data.profile;
    if (!profile && db) {
      profile = await db.collection('profiles').findOne({
        $or: [{ phone }, { phone: '+' + phone }]
      });
    }
    if (!profile) {
      await sendText(sock, jid, '❌ Account not found. Visit bconnect.co.ke to register.\n\nType MENU to go back.');
      return;
    }

    let properties = [];
    let tenantCount = 0;
    if (db) {
      properties = await db.collection('landlord_properties').find({ landlordId: String(profile._id) }).limit(5).toArray();
      tenantCount = await db.collection('tenants').countDocuments({ landlordId: String(profile._id) });
    }

    let msg = `🏠 *Landlord Dashboard*\nWelcome, ${profile.name}!\n\n`;
    msg += `🏡 *Properties:* ${properties.length}\n👥 *Tenants:* ${tenantCount}\n\n`;
    if (properties.length) {
      properties.forEach((p, i) => {
        const avail = p.roomsRemaining ? ` (${p.roomsRemaining} vacant)` : '';
        msg += `${i + 1}. ${p.name}${avail} — ${fmtPrice(p.rent)}/mo\n`;
      });
    } else {
      msg += '_No properties yet._\n';
    }
    msg += '\n1 - ➕ Add Property\n2 - 👥 Manage Tenants\n3 - 💰 Rent Collection\n4 - 🔙 Main Menu\n\nReply with a number.';
    await sendText(sock, jid, msg);
  } catch (e) {
    await sendText(sock, jid, '❌ Error loading dashboard. Type MENU to go back.');
  }
}

module.exports = { showAccountMenu, showSellerDashboard, showTenantDashboard, showLandlordDashboard };
