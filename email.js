const nodemailer = require('nodemailer');

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[email] Not configured — EMAIL_USER/EMAIL_PASS missing');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
  transporter.verify((err) => {
    if (err) {
      console.error('[email] SMTP connection failed:', err.message);
      console.error('[email] Tip: Use a Gmail App Password, not your regular password.');
      transporter = null;
    } else {
      console.log(`[email] ✓ SMTP ready — sending as ${EMAIL_USER}`);
    }
  });
  return transporter;
}

// Eagerly verify on startup so misconfiguration appears in the startup log
getTransporter();

async function sendEmail(to, subject, text, html, attachments) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[email] Skipped (not configured): ${subject} → ${to}`);
    return false;
  }
  try {
    const mailOptions = {
      from: `"BConnect" <${EMAIL_USER}>`,
      to,
      subject,
      text,
      html: html || text
    };
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments;
    }
    const info = await t.sendMail(mailOptions);
    console.log(`[email]  Sent "${subject}" → ${to} (${info.messageId})`);
    return true;
  } catch (err) {
    console.error(`[email]  Failed "${subject}" → ${to}:`, err.message);
    return false;
  }
}

//  Templates 

function baseTemplate(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#f4f4f7;font-family:'Segoe UI',Arial,sans-serif}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .header{background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:28px 32px;text-align:center}
  .header h1{margin:0;color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px}
  .header p{margin:6px 0 0;color:rgba(255,255,255,.8);font-size:13px}
  .body{padding:28px 32px;color:#374151}
  .body p{margin:0 0 14px;font-size:15px;line-height:1.6}
  .card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:16px 0}
  .card .row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:14px}
  .card .row:last-child{border-bottom:none}
  .card .row .label{color:#6b7280}
  .card .row .val{font-weight:700;color:#111827}
  .amount{font-size:28px;font-weight:900;color:#7c3aed;text-align:center;margin:12px 0}
  .btn{display:block;width:fit-content;margin:20px auto;padding:14px 36px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;text-align:center}
  .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;font-size:12px;color:#9ca3af}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700}
  .badge-green{background:#dcfce7;color:#15803d}
  .badge-amber{background:#fef9c3;color:#92400e}
  .badge-red{background:#fee2e2;color:#b91c1c}
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <h1> BConnect</h1>
    <p>Kenya's Property & Marketplace Platform</p>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">© ${new Date().getFullYear()} BConnect · Nairobi, Kenya<br>
  This email was sent automatically. Do not reply.</div>
</div>
</body></html>`;
}

function passwordResetEmail(name, resetUrl) {
  const text = `Hi ${name},\n\nYou requested a password reset for your BConnect account.\n\nClick this link to reset your password (expires in 15 minutes):\n${resetUrl}\n\nIf you did not request this, please ignore this email.\n\nBConnect Team`;
  const html = baseTemplate('Reset Your Password', `
    <p>Hi <strong>${name}</strong>,</p>
    <p>You requested a password reset for your BConnect account. Click the button below — this link expires in <strong>15 minutes</strong>.</p>
    <a class="btn" href="${resetUrl}"> Reset My Password</a>
    <p style="font-size:13px;color:#9ca3af;text-align:center">Or copy this link: <br><code style="word-break:break-all;font-size:11px">${resetUrl}</code></p>
    <p style="font-size:13px;color:#6b7280">If you did not request a password reset, you can safely ignore this email — your account is not at risk.</p>
  `);
  return { text, html };
}

function paymentReceiptEmail(name, order) {
  const { orderId, item, amount, phone, paymentType, date } = order;
  const dateStr = date ? new Date(date).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const amtFmt = 'KES ' + Number(amount).toLocaleString('en-KE');
  const typeFmt = paymentType === 'deposit' ? 'Security Deposit' : paymentType === 'rent' ? 'Rent Payment' : 'Product Purchase';

  const text = `Hi ${name},\n\nYour payment was successful!\n\nOrder: ${orderId}\nItem: ${item}\nAmount: ${amtFmt}\nType: ${typeFmt}\nDate: ${dateStr}\n\nThank you for using BConnect.`;
  const html = baseTemplate('Payment Confirmed ', `
    <p>Hi <strong>${name || 'Customer'}</strong>,</p>
    <p>Your payment was processed successfully. Here is your receipt:</p>
    <div class="amount">${amtFmt} <span class="badge badge-green"> Paid</span></div>
    <div class="card">
      <div class="row"><span class="label">Order ID</span><span class="val">${orderId || '—'}</span></div>
      <div class="row"><span class="label">Item / Property</span><span class="val">${item || '—'}</span></div>
      <div class="row"><span class="label">Payment Type</span><span class="val">${typeFmt}</span></div>
      <div class="row"><span class="label">M-Pesa Number</span><span class="val">${phone || '—'}</span></div>
      <div class="row"><span class="label">Date & Time</span><span class="val">${dateStr}</span></div>
    </div>
    <p>Thank you for using <strong>BConnect</strong>. Keep this email as proof of payment.</p>
  `);
  return { text, html };
}

function bookingConfirmationEmail(name, booking) {
  const { propertyName, location, date, time, phone } = booking;
  const dateStr = date || new Date().toLocaleDateString('en-KE');

  const text = `Hi ${name},\n\nYour viewing has been booked!\n\nProperty: ${propertyName}\nLocation: ${location || 'See listing'}\nDate: ${dateStr}${time ? '\nTime: ' + time : ''}\n\nThe landlord will contact you on ${phone} to confirm.\n\nBConnect Team`;
  const html = baseTemplate('Viewing Booked! ', `
    <p>Hi <strong>${name || 'Customer'}</strong>,</p>
    <p>Your property viewing has been booked successfully. Here are the details:</p>
    <div class="card">
      <div class="row"><span class="label">Property</span><span class="val">${propertyName || '—'}</span></div>
      <div class="row"><span class="label">Location</span><span class="val">${location || '—'}</span></div>
      <div class="row"><span class="label">Date</span><span class="val">${dateStr}</span></div>
      ${time ? `<div class="row"><span class="label">Time</span><span class="val">${time}</span></div>` : ''}
      <div class="row"><span class="label">Contact Number</span><span class="val">${phone || '—'}</span></div>
    </div>
    <p>The landlord will contact you to <strong>confirm the exact time</strong>. Please keep your phone on.</p>
    <p style="font-size:13px;color:#6b7280">If you need to cancel or reschedule, please contact BConnect support.</p>
  `);
  return { text, html };
}

function landlordPaymentAlertEmail(landlordName, payment) {
  const { tenantName, tenantPhone, propertyName, amount, reference, paymentType, date } = payment;
  const dateStr = date
    ? new Date(date).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const amtFmt  = 'KES ' + Number(amount).toLocaleString('en-KE');
  const typeFmt = paymentType === 'deposit' ? 'Security Deposit' : paymentType === 'rent' ? 'Rent Payment' : 'Payment';

  const text = `Hi ${landlordName},\n\nGood news! A rent payment has been received.\n\nTenant: ${tenantName}\nPhone: ${tenantPhone || '—'}\nProperty: ${propertyName}\nAmount: ${amtFmt}\nType: ${typeFmt}\nReference: ${reference}\nDate: ${dateStr}\n\nBConnect Team`;
  const html = baseTemplate('Rent Payment Received ', `
    <p>Hi <strong>${landlordName}</strong>,</p>
    <p>Great news — a rent payment has just been completed for one of your properties.</p>
    <div class="amount">${amtFmt} <span class="badge badge-green"> Received</span></div>
    <div class="card">
      <div class="row"><span class="label">Tenant</span><span class="val">${tenantName || '—'}</span></div>
      <div class="row"><span class="label">Phone</span><span class="val">${tenantPhone || '—'}</span></div>
      <div class="row"><span class="label">Property</span><span class="val">${propertyName || '—'}</span></div>
      <div class="row"><span class="label">Payment Type</span><span class="val">${typeFmt}</span></div>
      <div class="row"><span class="label">Reference</span><span class="val">${reference || '—'}</span></div>
      <div class="row"><span class="label">Date & Time</span><span class="val">${dateStr}</span></div>
    </div>
    <p>Log in to your BConnect landlord dashboard to view all payments and manage your properties.</p>
    <a class="btn" href="https://bconnect.replit.app/landlord.html"> View Dashboard</a>
  `);
  return { text, html };
}

function welcomeEmail(name, role) {
  const roleFmt = role === 'landlord' ? 'Landlord' : role === 'seller' ? 'Seller' : 'Member';
  const text = `Hi ${name},\n\nWelcome to BConnect! Your account has been created as a ${roleFmt}.\n\nBConnect Team`;
  const html = baseTemplate('Welcome to BConnect! ', `
    <p>Hi <strong>${name}</strong>,</p>
    <p>Welcome to <strong>BConnect</strong> — Kenya's property rental and marketplace platform!</p>
    <p>Your account has been created as a <span class="badge badge-amber">${roleFmt}</span>.</p>
    <p>You can now browse properties, list your products, and connect with landlords and tenants across Kenya.</p>
    <a class="btn" href="https://bconnect.replit.app"> Go to BConnect</a>
    <p style="font-size:13px;color:#6b7280">If you have any questions, contact our support team.</p>
  `);
  return { text, html };
}

function emailVerificationEmail(name, verifyUrl) {
  const text = `Hi ${name},\n\nThank you for registering with BConnect! Please verify your email address by visiting this link (expires in 24 hours):\n${verifyUrl}\n\nIf you did not create an account, please ignore this email.\n\nBConnect Team`;
  const html = baseTemplate('Verify Your Email Address', `
    <p>Hi <strong>${name}</strong>,</p>
    <p>Thanks for signing up for <strong>BConnect</strong>! You're almost ready — just verify your email address to activate your account.</p>
    <a class="btn" href="${verifyUrl}"> Verify My Email</a>
    <p style="font-size:13px;color:#9ca3af;text-align:center">Or copy this link:<br><code style="word-break:break-all;font-size:11px">${verifyUrl}</code></p>
    <p style="font-size:13px;color:#6b7280">This link expires in <strong>24 hours</strong>. If you did not create a BConnect account, you can safely ignore this email.</p>
  `);
  return { text, html };
}

function depositConfirmationEmail(name, order) {
  const { orderId, item, amount, phone, propertyCode, date } = order;
  const dateStr = date
    ? new Date(date).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
    : new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const amtFmt = 'KES ' + Number(amount).toLocaleString('en-KE');

  const text = `Hi ${name},\n\nYour security deposit payment was successful!\n\nOrder: ${orderId}\nProperty: ${item}\nAmount: ${amtFmt}\nDate: ${dateStr}\n\nYour Property Code: ${propertyCode || 'See landlord'}\n\nShare this code with your landlord or enter it in your BConnect Tenant Dashboard under "Link Property" to activate your tenancy.\n\nBConnect Team`;

  const html = baseTemplate('Security Deposit Confirmed 🏠', `
    <p>Hi <strong>${name || 'Customer'}</strong>,</p>
    <p>Your security deposit has been paid successfully. Here is your receipt:</p>
    <div class="amount">${amtFmt} <span class="badge badge-green"> Deposit Paid</span></div>
    <div class="card">
      <div class="row"><span class="label">Order ID</span><span class="val">${orderId || '—'}</span></div>
      <div class="row"><span class="label">Property</span><span class="val">${item || '—'}</span></div>
      <div class="row"><span class="label">M-Pesa Number</span><span class="val">${phone || '—'}</span></div>
      <div class="row"><span class="label">Date & Time</span><span class="val">${dateStr}</span></div>
    </div>
    ${propertyCode ? `
    <div style="background:#eff6ff;border:2px solid #3b82f6;border-radius:14px;padding:22px 28px;margin:22px 0;text-align:center;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;">Your Property Code</div>
      <div style="font-size:38px;font-weight:900;color:#1d4ed8;letter-spacing:6px;font-family:'Courier New',monospace;">${propertyCode}</div>
      <div style="font-size:13px;color:#3b82f6;margin-top:10px;font-weight:500;">Keep this code safe — share it with your landlord to link your tenancy</div>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#15803d;">What to do next:</p>
      <ol style="margin:0;padding-left:18px;font-size:13px;color:#374151;line-height:1.9;">
        <li>Log in to your <strong>BConnect Tenant Dashboard</strong></li>
        <li>Click <strong>"Link Property"</strong> and enter the code above</li>
        <li>Your landlord will confirm and your tenancy will be activated</li>
      </ol>
    </div>` : ''}
    <a class="btn" href="https://bconnect.replit.app/tenant.html?code=${encodeURIComponent(propertyCode || '')}"> Link Property Now</a>
    <p style="font-size:13px;color:#6b7280;text-align:center;margin-top:16px;">Keep this email as proof of payment.</p>
  `);
  return { text, html };
}

function tenantJoinRequestEmail(landlordName, request) {
  const { tenantName, tenantEmail, tenantPhone, propertyName, propertyCode, monthlyRent, dashboardUrl } = request;
  const rentFmt = monthlyRent ? 'KES ' + Number(monthlyRent).toLocaleString('en-KE') + '/mo' : null;
  const url = dashboardUrl || 'https://bconnect.replit.app/landlord-dashboard.html';

  const text = `Hi ${landlordName},\n\n${tenantName} has submitted a join request for "${propertyName}" (code: ${propertyCode}).\n\nTenant: ${tenantName}${tenantEmail ? '\nEmail: ' + tenantEmail : ''}${tenantPhone ? '\nPhone: ' + tenantPhone : ''}${rentFmt ? '\nRequested Rent: ' + rentFmt : ''}\n\nLog in to your BConnect Landlord Dashboard to approve or reject this request:\n${url}\n\nBConnect Team`;

  const html = baseTemplate('New Tenant Join Request 🏠', `
    <p>Hi <strong>${landlordName}</strong>,</p>
    <p>A tenant has submitted a join request for one of your properties and is awaiting your approval.</p>
    <div class="card">
      <div class="row"><span class="label">Tenant</span><span class="val">${tenantName || '—'}</span></div>
      ${tenantEmail ? `<div class="row"><span class="label">Email</span><span class="val">${tenantEmail}</span></div>` : ''}
      ${tenantPhone ? `<div class="row"><span class="label">Phone</span><span class="val">${tenantPhone}</span></div>` : ''}
    </div>
    <div class="card">
      <div class="row"><span class="label">Property</span><span class="val">${propertyName || '—'}</span></div>
      <div class="row"><span class="label">Property Code</span><span class="val" style="font-family:monospace;letter-spacing:3px;">${propertyCode || '—'}</span></div>
      ${rentFmt ? `<div class="row"><span class="label">Requested Rent</span><span class="val">${rentFmt}</span></div>` : ''}
    </div>
    <p>Review this request in your dashboard and approve or reject the tenant.</p>
    <a class="btn" href="${url}">Review Request</a>
    <p style="font-size:13px;color:#6b7280;text-align:center;">Once approved, the tenant will be notified and linked to your property.</p>
  `);
  return { text, html };
}

module.exports = {
  sendEmail,
  passwordResetEmail,
  paymentReceiptEmail,
  bookingConfirmationEmail,
  landlordPaymentAlertEmail,
  tenantJoinRequestEmail,
  welcomeEmail,
  emailVerificationEmail,
  depositConfirmationEmail
};
