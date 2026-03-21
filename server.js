'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const { buildSystemPrompt, detectAudience, OPENING_MESSAGES, QUICK_REPLIES } = require('./prompts/system-prompt');
const ghl = require('./services/ghl');

// ============================================================
// CONFIG
// ============================================================
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://www.3cir.com,https://3cir.com').split(',').map(s => s.trim());
const MAX_MSG_LENGTH = 2000; // FIX #6
const MAX_HISTORY = 20;     // FIX #21 from handover (cap conversation history)

// ============================================================
// STARTUP VALIDATION — FIX #2
// ============================================================
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set. Server will not start.');
  process.exit(1);
}

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SESSION STORE — FIX #7: Graceful expiry via node-cache
// ============================================================
const sessions = new NodeCache({ stdTTL: 7200, checkperiod: 600 }); // 2hr TTL

sessions.on('expired', async (key, session) => {
  await saveTranscript(session).catch(() => {});
});

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();

app.use('/public', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10kb' }));

// FIX #22 (CORS restricted to allowed origins)
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) return cb(null, true);
    console.warn(`[CORS] Blocked: ${origin}`);
    return cb(null, false);
  },
  credentials: true,
}));

// FIX #3: Rate limiting — 20 requests/min per IP on chat
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "You're sending messages a bit fast — please wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// FIX #25: HTTPS redirect in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Serve widget
app.use('/public', express.static(path.join(__dirname, 'public')));

// ============================================================
// HELPERS
// ============================================================

// FIX #6: Sanitise and limit message length
function sanitise(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').trim().substring(0, MAX_MSG_LENGTH);
}

// FIX #8: Robust name extraction
function extractName(text, previousBotAskedForName) {
  const patterns = [
    /(?:my name is|i'm|i am|call me|it's|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+here/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseName(m[1]);
  }
  // If bot just asked for name and reply is 1-6 words starting with a capital
  if (previousBotAskedForName && text.split(/\s+/).length <= 6) {
    const m = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (m) return parseName(m[1]);
  }
  return null;
}

function parseName(raw) {
  const parts = raw.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || '' };
}

// FIX #10: Email and phone extraction
function extractEmail(text) {
  const m = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractPhone(text) {
  const m = text.match(/(?:\+?61|0)[2-578]\d{8}|\d{4}\s?\d{3}\s?\d{3}/);
  return m ? m[0].replace(/\s/g, '') : null;
}

function botAskedForName(messages) {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'assistant') return false;
  const t = last.content.toLowerCase();
  return t.includes('your name') || t.includes('who am i speaking') || t.includes('what should i call you');
}

// Save transcript to GHL note
async function saveTranscript(session) {
  if (!session.contactId || !session.messages?.length) return;
  const lines = session.messages.map(m => `[${m.role === 'user' ? 'Visitor' : '3CIR Bot'}]: ${m.content}`).join('\n\n');
  const body = `AI Chatbot Conversation\nAudience: ${session.audience}\nMessages: ${session.messages.length}\nDuration: ${Math.round((Date.now() - session.created) / 60000)} min\n---\n${lines}`;
  await ghl.addNote(session.contactId, body);
}

// Lead capture — runs after each message
async function attemptLeadCapture(session) {
  if (session.contactId) return; // Already captured
  const userMsgs = session.messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const email = extractEmail(userMsgs);
  const phone = extractPhone(userMsgs);
  if (!email && !phone) return; // Not enough info yet

  // Try to find name
  let firstName = '', lastName = '';
  for (const m of session.messages) {
    if (m.role !== 'user') continue;
    const name = extractName(m.content, false);
    if (name) { firstName = name.firstName; lastName = name.lastName; break; }
  }

  const audience = session.audience;
  const tag = audience === 'services' ? 'src:AI Chat — Services' : 'src:AI Chat — Public';

  const result = await ghl.upsertContact({
    firstName, lastName, email: email || '', phone: phone || '',
    source: 'AI Chatbot',
    tags: [tag, 'chatbot-lead'],
  });

  if (result.ok) {
    session.contactId = result.contactId;
    const stageId = audience === 'services'
      ? process.env.GHL_STAGE_NEW_ENQUIRIES
      : process.env.GHL_STAGE_NEW_ENQUIRIES;

    await ghl.createOpportunity(result.contactId, {
      title: `AI Chat — ${firstName || email || phone || 'Unknown'}`,
      stageId,
      source: 'AI Chatbot',
    });
    console.log(`[Lead] Captured: ${firstName || ''} ${email || phone || ''} → ${result.contactId}`);
  }
}

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), sessions: sessions.keys().length, version: '1.0.0' });
});

// Dashboard
app.get('/', (req, res) => {
  res.json({ name: '3CIR AI Assistant', version: '1.0.0', status: 'running' });
});

// ============================================================
// POST /api/session — Create new session, return opening message
// ============================================================
app.post('/api/session', (req, res) => {
  const { referrerUrl } = req.body;
  const audience = detectAudience(referrerUrl);
  const id = uuidv4();
  const opening = OPENING_MESSAGES[audience];

  const session = {
    id,
    audience,
    messages: [{ role: 'assistant', content: opening }], // FIX #24: Include opening in history
    contactId: null,
    created: Date.now(),
  };
  sessions.set(id, session);

  res.json({
    sessionId: id,
    audience,
    openingMessage: opening,
    quickReplies: QUICK_REPLIES[audience],
  });
});

// ============================================================
// GET /api/session/:id — Restore session (FIX #7, #15)
// ============================================================
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'session_expired', message: 'Your chat session has expired. Starting a new conversation.' });
  }
  res.json({
    sessionId: session.id,
    audience: session.audience,
    messages: session.messages,
    quickReplies: QUICK_REPLIES[session.audience],
  });
});

// ============================================================
// POST /api/chat — Main conversation with SSE streaming
// ============================================================
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, sessionId, pageUrl } = req.body;
  const clean = sanitise(message);

  // FIX #6: Message length check
  if (!clean) return res.status(400).json({ error: 'Message is required.' });
  if (clean.length >= MAX_MSG_LENGTH) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ type: 'error', content: "That message is a bit long — could you shorten it? I work best with shorter questions." })}\n\n`);
    return res.end();
  }

  // Get or recover session (FIX #7)
  let session = sessions.get(sessionId);
  if (!session) {
    const audience = detectAudience(pageUrl);
    const id = uuidv4();
    session = {
      id, audience,
      messages: [{ role: 'assistant', content: OPENING_MESSAGES[audience] }],
      contactId: null, created: Date.now(),
    };
    sessions.set(id, session);
    // Send new session ID to client
    res.setHeader('X-New-Session-Id', id);
  }

  // Add user message
  session.messages.push({ role: 'user', content: clean });

  // Cap history to prevent token overflow
  if (session.messages.length > MAX_HISTORY) {
    const first = session.messages[0];
    session.messages = [first, ...session.messages.slice(-(MAX_HISTORY - 1))];
  }

  sessions.set(session.id, session);

  // Build Claude messages (only user + assistant, no system)
  const claudeMessages = session.messages.map(m => ({ role: m.role, content: m.content }));

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', session.id);
  res.flushHeaders();

  // FIX #4: Track client disconnect
  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });

  let fullReply = '';

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(session.audience, pageUrl || ''),
      messages: claudeMessages,
    });

    for await (const event of stream) {
      if (clientDisconnected) {
        stream.controller?.abort();
        break;
      }
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullReply += event.delta.text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: event.delta.text })}\n\n`);
      }
    }

    if (!clientDisconnected) {
      // Add assistant response to history
      if (fullReply) {
        session.messages.push({ role: 'assistant', content: fullReply });
        sessions.set(session.id, session);
      }

      // Attempt lead capture in background
      attemptLeadCapture(session).catch(err => console.error(`[Lead] Error: ${err.message}`));

      // Send done event
      res.write(`data: ${JSON.stringify({ type: 'done', leadCaptured: !!session.contactId })}\n\n`);
    }
  } catch (err) {
    console.error(`[Claude] Stream error: ${err.message}`);
    if (!clientDisconnected) {
      const fallback = "I'm having a brief technical moment. You can try again, or call us directly on 1300 517 039.";
      res.write(`data: ${JSON.stringify({ type: 'error', content: fallback })}\n\n`);
      session.messages.push({ role: 'assistant', content: fallback });
      sessions.set(session.id, session);
    }
  }

  res.end();
});

// ============================================================
// POST /api/lead — Manual lead capture from widget
// ============================================================
app.post('/api/lead', async (req, res) => {
  const { sessionId, name, email, phone } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });

  const audience = session.audience;
  const tag = audience === 'services' ? 'src:AI Chat — Services' : 'src:AI Chat — Public';
  const parts = (name || '').split(/\s+/);

  const result = await ghl.upsertContact({
    firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '',
    email: email || '', phone: phone || '',
    source: 'AI Chatbot', tags: [tag, 'chatbot-lead'],
  });

  if (result.ok) {
    session.contactId = result.contactId;
    sessions.set(sessionId, session);
    await ghl.createOpportunity(result.contactId, {
      title: `AI Chat — ${parts[0] || email || phone}`,
      stageId: process.env.GHL_STAGE_NEW_ENQUIRIES,
      source: 'AI Chatbot',
    });
  }

  res.json({ ok: result.ok, contactId: result.contactId });
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
async function shutdown(signal) {
  console.log(`\n[Server] ${signal} — saving conversations...`);
  const keys = sessions.keys();
  const promises = keys.map(k => {
    const s = sessions.get(k);
    return s ? saveTranscript(s).catch(() => {}) : Promise.resolve();
  });
  await Promise.allSettled(promises);
  console.log(`[Server] ${promises.length} conversations saved. Exiting.`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log('============================================================');
  console.log('  3CIR AI ASSISTANT v1.0.0');
  console.log(`  Port:     ${PORT}`);
  console.log(`  Env:      ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Origins:  ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`  GHL:      ${process.env.GHL_LOCATION_ID || 'NOT SET'}`);
  console.log(`  Claude:   Configured`);
  console.log('============================================================');
});

module.exports = app;
