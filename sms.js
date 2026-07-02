/**
 * sms.js — Africa's Talking SMS utility for BConnect
 *
 * Usage:
 *   const { sendSMS } = require('./sms');
 *   await sendSMS('+254712345678', 'Your ticket code is TKT-XXXX');
 *
 * Required Replit Secrets:
 *   AT_USERNAME  — your Africa's Talking username (use "sandbox" for testing)
 *   AT_API_KEY   — your Africa's Talking API key (from the AT dashboard)
 */

const AfricasTalking = require('africastalking');

// ── Initialise the SDK ──────────────────────────────────────────────────────
// Credentials are pulled exclusively from environment variables — never
// hardcoded — so the API key is never exposed to the frontend or logs.
const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY  = process.env.AT_API_KEY;

// Flag: SMS is only active when both secrets are present
const SMS_ENABLED = !!(AT_USERNAME && AT_API_KEY);

let smsClient = null;

if (SMS_ENABLED) {
  const at = AfricasTalking({ username: AT_USERNAME, apiKey: AT_API_KEY });
  smsClient = at.SMS;
  console.log(`[OK] Africa's Talking SMS ready (username: ${AT_USERNAME})`);
} else {
  console.log('[INFO] SMS not configured — set AT_USERNAME and AT_API_KEY secrets to enable.');
}

/**
 * Validate that a phone number is in international E.164 format.
 * Accepts: +2547XXXXXXXX, +2541XXXXXXXX, etc.
 * Also accepts Kenyan numbers starting with 07/01 and auto-converts them.
 *
 * @param {string} raw — the raw phone string from the caller
 * @returns {{ ok: boolean, phone: string, error?: string }}
 */
function normalisePhone(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, phone: '', error: 'Phone number is required.' };
  }

  // Strip whitespace and dashes
  let phone = raw.replace(/[\s\-().]/g, '');

  // Convert local Kenyan format (07XX or 01XX) → +254XX
  if (/^0[17]\d{8}$/.test(phone)) {
    phone = '+254' + phone.slice(1);
  }

  // Accept any E.164 number: + followed by 7–15 digits
  if (/^\+\d{7,15}$/.test(phone)) {
    return { ok: true, phone };
  }

  return {
    ok: false,
    phone: '',
    error: `Invalid phone number "${raw}". Use international format: +2547XXXXXXXX`
  };
}

/**
 * sendSMS — send a text message via Africa's Talking.
 *
 * @param {string} phone   — recipient in E.164 format, e.g. "+254712345678"
 * @param {string} message — the text body (max 160 chars for single SMS)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendSMS(phone, message) {
  // Guard: SMS not configured
  if (!SMS_ENABLED) {
    console.warn('[SMS] Skipped — credentials not configured.');
    return { success: false, error: 'SMS service is not configured on this server.' };
  }

  // Validate & normalise phone number
  const { ok, phone: normPhone, error: phoneError } = normalisePhone(phone);
  if (!ok) {
    console.error('[SMS] Invalid phone:', phoneError);
    return { success: false, error: phoneError };
  }

  // Guard: message must not be empty
  if (!message || !message.trim()) {
    return { success: false, error: 'SMS message body cannot be empty.' };
  }

  try {
    const response = await smsClient.send({
      to: [normPhone],     // Africa's Talking expects an array
      message: message.trim(),
      // from: 'BCONNECT'  // Optional: set a registered sender ID here
    });

    const recipient = response.SMSMessageData?.Recipients?.[0];
    const status    = (recipient?.status || '').toLowerCase();

    if (status === 'success') {
      console.log(`[SMS] Sent to ${normPhone} | messageId: ${recipient.messageId}`);
      return { success: true, messageId: recipient.messageId, phone: normPhone };
    } else {
      // AT returned a non-success status (e.g. "InvalidPhoneNumber")
      const errMsg = recipient?.status || 'Unknown error from Africa\'s Talking';
      console.error(`[SMS] Failed for ${normPhone}: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  } catch (err) {
    console.error('[SMS] Exception:', err.message || err);
    return { success: false, error: err.message || 'SMS send failed.' };
  }
}

module.exports = { sendSMS, normalisePhone, SMS_ENABLED };
