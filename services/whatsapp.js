'use strict';

const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '3cir_chatbot_verify_2026';

// Verify webhook (Meta sends GET with challenge — same as Messenger)
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WhatsApp] Webhook verified');
    return { ok: true, challenge };
  }
  return { ok: false };
}

// Parse incoming webhook events into normalised messages
function parseMessages(body) {
  const messages = [];

  if (!body || body.object !== 'whatsapp_business_account') return messages;

  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const incomingMessages = value.messages || [];

      for (const msg of incomingMessages) {
        if (msg.type !== 'text' || !msg.text?.body) continue;

        messages.push({
          platform: 'whatsapp',
          senderId: msg.from, // Phone number in international format
          text: msg.text.body.trim(),
          timestamp: parseInt(msg.timestamp) * 1000 || Date.now(),
          messageId: msg.id,
          phoneNumberId: phoneNumberId,
          // Contact name if available
          contactName: value.contacts?.[0]?.profile?.name || '',
        });
      }
    }
  }

  return messages;
}

// Send a text message back via WhatsApp Cloud API
async function sendMessage(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.error('[WhatsApp] Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID');
    return false;
  }

  // WhatsApp messages can be up to 4096 chars
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: { body: chunk },
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[WhatsApp] Send failed: ${err.response?.data?.error?.message || err.message}`);
      return false;
    }
  }

  return true;
}

// Mark message as read (shows blue ticks)
async function markAsRead(messageId) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !messageId) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );
  } catch (e) {}
}

// Split long messages at natural break points
function splitMessage(text, maxLen) {
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

module.exports = {
  verifyWebhook,
  parseMessages,
  sendMessage,
  markAsRead,
};
