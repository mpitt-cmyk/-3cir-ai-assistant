'use strict';

const axios = require('axios');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const SMS_FROM = process.env.TWILIO_SMS_FROM || '+61429774862';
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+61429774862';

// Parse incoming Twilio webhook (URL-encoded form data)
function parseMessage(body) {
  if (!body || !body.From || !body.Body) return null;

  const from = body.From || '';
  const isWhatsApp = from.startsWith('whatsapp:');
  const phone = isWhatsApp ? from.replace('whatsapp:', '') : from;

  return {
    platform: isWhatsApp ? 'whatsapp' : 'sms',
    senderId: phone,
    text: (body.Body || '').trim(),
    timestamp: Date.now(),
    phone: phone,
    // Media attachments (WhatsApp/MMS)
    media: body.NumMedia > 0 ? Array.from({ length: parseInt(body.NumMedia) }, (_, i) => ({
      url: body[`MediaUrl${i}`],
      type: body[`MediaContentType${i}`],
    })) : [],
  };
}

// Send SMS response
async function sendSms(to, text) {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    console.error('[SMS] Twilio credentials not set');
    return false;
  }

  // Split long messages for SMS (160 chars per segment, but Twilio handles concatenation up to 1600)
  const chunks = splitForSms(text, 1500);

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
        new URLSearchParams({ To: to, From: SMS_FROM, Body: chunk }).toString(),
        {
          auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }
      );
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[SMS] Send failed: ${err.response?.data?.message || err.message}`);
      return false;
    }
  }
  return true;
}

// Send WhatsApp response
async function sendWhatsApp(to, text) {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    console.error('[WhatsApp] Twilio credentials not set');
    return false;
  }

  const whatsappTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  // WhatsApp messages can be up to 4096 chars
  const chunks = splitForSms(text, 4000);

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
        new URLSearchParams({ To: whatsappTo, From: WHATSAPP_FROM, Body: chunk }).toString(),
        {
          auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }
      );
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[WhatsApp] Send failed: ${err.response?.data?.message || err.message}`);
      return false;
    }
  }
  return true;
}

// Split text for SMS at natural break points
function splitForSms(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt + 1).trim());
    remaining = remaining.substring(splitAt + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Generate TwiML empty response (acknowledge webhook)
function twimlResponse() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

module.exports = {
  parseMessage,
  sendSms,
  sendWhatsApp,
  twimlResponse,
};
