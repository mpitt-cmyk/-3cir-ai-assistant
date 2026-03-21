'use strict';

const axios = require('axios');

const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '3cir_chatbot_verify_2026';
const PAGE_ID = process.env.META_PAGE_ID || '595465687308008';

// Verify webhook (Meta sends GET with challenge)
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Messenger] Webhook verified');
    return { ok: true, challenge };
  }
  return { ok: false };
}

// Parse incoming webhook events into normalised messages
function parseMessages(body) {
  const messages = [];

  if (!body || !body.object) return messages;

  // Facebook Messenger + Instagram DM
  if (body.object === 'page' || body.object === 'instagram') {
    const entries = body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId || senderId === PAGE_ID) continue;

        messages.push({
          platform: body.object === 'instagram' ? 'instagram' : 'messenger',
          senderId,
          text: event.message.text || '',
          timestamp: event.timestamp || Date.now(),
          // Attachments (files, images)
          attachments: (event.message.attachments || []).map(a => ({
            type: a.type,
            url: a.payload?.url,
          })),
        });
      }
    }
  }

  return messages;
}

// Send a text message back to the user
async function sendMessage(recipientId, text, platform = 'messenger') {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('[Messenger] No PAGE_ACCESS_TOKEN set');
    return false;
  }

  // Split long messages (Messenger limit is 2000 chars)
  const chunks = splitMessage(text, 2000);

  for (const chunk of chunks) {
    try {
      const url = platform === 'instagram'
        ? `https://graph.facebook.com/v19.0/me/messages`
        : `https://graph.facebook.com/v19.0/me/messages`;

      await axios.post(url, {
        recipient: { id: recipientId },
        message: { text: chunk },
        messaging_type: 'RESPONSE',
      }, {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 10000,
      });

      // Rate limit: wait 200ms between chunks
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`[Messenger] Send failed: ${err.response?.data?.error?.message || err.message}`);
      return false;
    }
  }

  return true;
}

// Send typing indicator
async function sendTypingOn(recipientId) {
  if (!PAGE_ACCESS_TOKEN) return;
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
      recipient: { id: recipientId },
      sender_action: 'typing_on',
    }, {
      params: { access_token: PAGE_ACCESS_TOKEN },
      timeout: 5000,
    });
  } catch (e) {}
}

// Get user profile (name) from Meta
async function getUserProfile(senderId) {
  if (!PAGE_ACCESS_TOKEN) return null;
  try {
    const resp = await axios.get(`https://graph.facebook.com/v19.0/${senderId}`, {
      params: { fields: 'first_name,last_name', access_token: PAGE_ACCESS_TOKEN },
      timeout: 5000,
    });
    return { firstName: resp.data.first_name || '', lastName: resp.data.last_name || '' };
  } catch (e) {
    return null;
  }
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
  sendTypingOn,
  getUserProfile,
  PAGE_ID,
};
