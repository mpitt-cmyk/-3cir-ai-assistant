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
const axios = require('axios');
const multer = require('multer');

const { buildSystemPrompt, detectAudience, OPENING_MESSAGES, QUICK_REPLIES, QUALIFICATIONS } = require('./prompts/system-prompt');
const ghl = require('./services/ghl');
const seek = require('./services/seek');
const abs = require('./services/abs');

// ============================================================
// CONFIG
// ============================================================
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://www.3cir.com,https://3cir.com').split(',').map(s => s.trim());
const MAX_MSG_LENGTH = 2000;
const MAX_HISTORY = 20;
const INACTIVITY_MINUTES = 30;
const INACTIVITY_CHECK_MS = 60000;
const SEEK_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================
// STARTUP
// ============================================================
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set.');
  process.exit(1);
}

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const sessions = new NodeCache({ stdTTL: 7200, checkperiod: 600 });
sessions.on('expired', async (key, session) => {
  await handleSessionEnd(session, 'expired').catch(() => {});
});

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

const chatLimiter = rateLimit({
  windowMs: 60000, max: 20,
  message: { error: "You're sending messages a bit fast — please wait a moment." },
  standardHeaders: true, legacyHeaders: false,
});

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

app.use('/public', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'public')));

// File upload handler — max 5MB, memory storage (Render has ephemeral disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'text/plain'];
  if (allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|doc|docx|jpg|jpeg|png|txt)$/i)) return cb(null, true);
  cb(new Error('File type not supported'));
}});

// ============================================================
// HELPERS
// ============================================================
function sanitise(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').trim().substring(0, MAX_MSG_LENGTH);
}

function extractName(text, prev) {
  const patterns = [
    /(?:my name is|i'm|i am|call me|it's|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+here/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseName(m[1]);
  }
  if (prev && text.split(/\s+/).length <= 6) {
    const m = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (m) return parseName(m[1]);
  }
  return null;
}

function parseName(raw) {
  const p = raw.trim().split(/\s+/);
  return { firstName: p[0], lastName: p.slice(1).join(' ') || '' };
}

function extractEmail(t) {
  const m = t.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractPhone(t) {
  const m = t.match(/(?:\+?61|0)[2-578]\d{8}|\d{4}\s?\d{3}\s?\d{3}/);
  return m ? m[0].replace(/\s/g, '') : null;
}

// ============================================================
// CONVERSATION DETECTION
// ============================================================
const GOODBYE_PATTERNS = [
  /\b(thanks|thank you|cheers|ta|appreciate it|that's? (all|everything)|no more questions)\b/i,
  /\b(bye|goodbye|see ya|see you|catch ya|gotta go|have a (good|great) (day|one|night))\b/i,
  /\b(i('m| am) (good|done|sorted|all good)|that helps|perfect|brilliant|awesome|legend)\b/i,
  /\b(i('ll| will) (do that|look into|check|submit|fill|complete)|let me (do|think|check|submit))\b/i,
];
const BOT_GOODBYE_PATTERNS = [
  /\b(all the best|best of luck|good luck|take care|pleasure chatting|glad i could help)\b/i,
  /\b(don't hesitate to (come back|reach out|contact)|we're here (whenever|anytime|if you need))\b/i,
];
const CALLBACK_PATTERNS = [
  /\b(call me back|callback|call back|ring me|give me a (call|ring|buzz))\b/i,
  /\b(can (someone|you) (call|ring|phone)|i('d| would) (like|prefer) a call)\b/i,
  /\b(book a call|schedule a call|arrange a call)\b/i,
];
const ESCALATION_KEYWORDS = {
  dva: /\b(dva|department of veterans|veterans['']?\s*affairs|veteran funding|dva funding)\b/i,
  teamRpl: /\b(team rpl|bulk rpl|group rpl|multiple staff|whole team|our team|my team|company rpl|corporate rpl)\b/i,
  highValue: /\$\s*\d{4,}|\b(budget|invest|spend)\b.*\d{3,}/i,
};

function detectGoodbye(t) { return GOODBYE_PATTERNS.some(p => p.test(t)); }
function detectBotGoodbye(t) { return BOT_GOODBYE_PATTERNS.some(p => p.test(t)); }
function detectCallbackRequest(t) { return CALLBACK_PATTERNS.some(p => p.test(t)); }

function checkEscalation(s) {
  if (s.escalated) return false;
  const t = s.messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const r = [];
  if (ESCALATION_KEYWORDS.dva.test(t)) r.push('DVA funding mentioned');
  if (ESCALATION_KEYWORDS.teamRpl.test(t)) r.push('Team/bulk RPL enquiry');
  if (ESCALATION_KEYWORDS.highValue.test(t)) r.push('High-value signals');
  if ((s.qualsDiscussed || []).length >= 3) r.push(`${s.qualsDiscussed.length} quals discussed`);
  return r.length > 0 ? r : false;
}

// ============================================================
// QUALIFICATION TRACKING
// ============================================================
function trackQualifications(text, audience) {
  const quals = QUALIFICATIONS[audience] || QUALIFICATIONS.public;
  const found = [];
  const lower = text.toLowerCase();

  for (const q of quals) {
    if (lower.includes(q.code.toLowerCase()) || lower.includes(q.name.toLowerCase())) {
      if (!found.find(f => f.code === q.code && f.name === q.name)) {
        found.push({ code: q.code, name: q.name, level: q.level, rpl: q.rpl, online: q.online });
      }
    }
  }

  const shorthand = {
    'leadership': 'Leadership and Management', 'project management': 'Project Management',
    'whs': 'Work Health and Safety', 'work health': 'Work Health and Safety',
    'hr': 'Human Resource', 'human resource': 'Human Resource',
    'cyber': 'Cyber Security', 'security management': 'Security Management',
    'security risk': 'Security Risk', 'correctional': 'Correctional',
    'quality audit': 'Quality Audit', 'business': 'Business',
    'entrepreneurship': 'Entrepreneurship', 'marketing': 'Marketing and Communication',
    'government security': 'Government Security', 'government investigation': 'Government Investigations',
    'portfolio management': 'Portfolio Management', 'strategic leadership': 'Strategic Leadership',
    'program management': 'Program Management',
  };

  for (const [term, qn] of Object.entries(shorthand)) {
    if (lower.includes(term)) {
      const matches = quals.filter(q => q.name.toLowerCase().includes(qn.toLowerCase()));
      for (const m of matches) {
        if (!found.find(f => f.code === m.code && f.name === m.name)) {
          found.push({ code: m.code, name: m.name, level: m.level, rpl: m.rpl, online: m.online });
        }
      }
    }
  }
  return found;
}

function buildTranscript(s) {
  return s.messages.map(m => `${m.role === 'user' ? 'You' : '3CIR'}: ${m.content}`).join('\n\n');
}

// ============================================================
// WEBHOOK TRIGGERS
// ============================================================
async function triggerSmsWebhook(s) {
  const u = process.env.GHL_WORKFLOW_SMS_URL;
  if (!u) return;
  try {
    await axios.post(u, { contactId: s.contactId, firstName: s.firstName || '', email: s.email || '', phone: s.phone || '', audience: s.audience, source: 'AI Chatbot' }, { timeout: 10000 });
    console.log(`[P1] SMS sent for ${s.contactId}`);
  } catch (e) { console.error(`[P1] ${e.message}`); }
}

async function triggerEmailWebhook(s) {
  const u = process.env.GHL_WORKFLOW_EMAIL_URL;
  if (!u || !s.contactId || s.emailSent) return;
  const q = s.qualsDiscussed || [];
  if (q.length === 0) return;
  const qs = q.map(x => {
    let p = `RPL $${x.rpl.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
    if (x.online) p += ` | Online Study $${x.online.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
    return `${x.name} (${x.code}) — ${p}`;
  }).join('\n');
  const rplUrl = s.audience === 'services'
    ? 'https://www.3cir.com/services/rpl-assessment-form/'
    : 'https://www.3cir.com/public/rpl-assessment-form/';

  // Build personalised evidence checklist based on audience
  const evidenceChecklist = s.audience === 'services'
    ? 'ADO Service Record or Certificate of Service\nPMKeys summary or Course Reports/ROAs\nPerformance Appraisals (PARs/SPARs)\nPosition descriptions or duty statements\nCivilian qualifications or training certificates\nReference letter from a commanding officer or supervisor'
    : 'Resume or CV\nPosition descriptions from current and previous roles\nReference letters from supervisors\nTraining certificates and course completions\nPerformance reviews or appraisals\nAny existing qualifications';

  const disclaimer = 'IMPORTANT: This summary is provided as guidance only. A formal RPL assessment would need to be completed for detailed and exact information to be provided regarding your eligibility and qualification outcomes. All qualifications are issued through Asset College (RTO 31718).';

  try {
    await axios.post(u, {
      contactId: s.contactId,
      firstName: s.firstName || '',
      email: s.email || '',
      phone: s.phone || '',
      audience: s.audience,
      qualificationsSummary: qs,
      qualificationsCount: q.length,
      qualificationsList: q.map(x => x.name),
      rplFormUrl: rplUrl,
      chatTranscript: buildTranscript(s),
      conversationLength: s.messages.length,
      evidenceChecklist: evidenceChecklist,
      uploadedFiles: (s.uploadedFiles || []).map(f => f.name),
      hasUploadedFiles: (s.uploadedFiles || []).length > 0,
      disclaimer: disclaimer,
      source: 'AI Chatbot',
    }, { timeout: 10000 });
    s.emailSent = true;
    console.log(`[P2] Email sent for ${s.contactId} — ${q.length} quals, ${(s.uploadedFiles || []).length} files`);
  } catch (e) { console.error(`[P2] ${e.message}`); }
}

async function triggerEscalationWebhook(s, reasons) {
  const u = process.env.ESCALATION_WEBHOOK_URL;
  if (!u) return;
  try {
    await axios.post(u, { contactId: s.contactId || null, firstName: s.firstName || '', email: s.email || '', phone: s.phone || '', audience: s.audience, reasons, qualsDiscussed: (s.qualsDiscussed || []).map(q => q.name), messageCount: s.messages.length, sessionId: s.id, source: 'AI Chatbot — HIGH VALUE' }, { timeout: 10000 });
    s.escalated = true;
    console.log(`[P9] Escalation: ${reasons.join(', ')}`);
  } catch (e) { console.error(`[P9] ${e.message}`); }
}

async function triggerCallbackWebhook(s, time) {
  const u = process.env.CALLBACK_WEBHOOK_URL;
  if (!u || !s.contactId) return;
  try {
    await axios.post(u, { contactId: s.contactId, firstName: s.firstName || '', phone: s.phone || '', email: s.email || '', preferredTime: time || 'Not specified', audience: s.audience, qualsDiscussed: (s.qualsDiscussed || []).map(q => q.name), source: 'AI Chatbot — Callback' }, { timeout: 10000 });
    s.callbackRequested = true;
    console.log(`[Callback] Triggered for ${s.contactId}`);
  } catch (e) { console.error(`[Callback] ${e.message}`); }
}

async function logAnalytics(s, reason) {
  const u = process.env.ANALYTICS_WEBHOOK_URL;
  if (!u) return;
  try {
    await axios.post(u, { sessionId: s.id, audience: s.audience, messageCount: s.messages.length, userMessageCount: s.messages.filter(m => m.role === 'user').length, durationMinutes: Math.round((Date.now() - s.created) / 60000), leadCaptured: !!s.contactId, contactId: s.contactId || null, qualsDiscussed: (s.qualsDiscussed || []).map(q => q.name), escalated: !!s.escalated, emailSent: !!s.emailSent, callbackRequested: !!s.callbackRequested, endReason: reason, timestamp: new Date().toISOString() }, { timeout: 10000 });
  } catch (e) { console.error(`[P3] ${e.message}`); }
}

// ============================================================
// SESSION END
// ============================================================
async function handleSessionEnd(s, reason) {
  if (s.contactId && s.messages?.length > 1) {
    const q = (s.qualsDiscussed || []).map(x => x.name).join(', ') || 'None';
    await ghl.addNote(s.contactId, `AI Chatbot Conversation\nAudience: ${s.audience}\nMessages: ${s.messages.length}\nDuration: ${Math.round((Date.now() - s.created) / 60000)} min\nQuals: ${q}\nEscalated: ${s.escalated ? 'YES' : 'No'}\nCallback: ${s.callbackRequested ? 'YES' : 'No'}\n---\n${buildTranscript(s)}`).catch(() => {});
  }
  if (!s.emailSent && s.contactId && (s.qualsDiscussed || []).length > 0) {
    await triggerEmailWebhook(s).catch(() => {});
  }
  await logAnalytics(s, reason).catch(() => {});
}

// ============================================================
// INACTIVITY CHECKER — 30min backup for P2
// ============================================================
const inactivityChecker = setInterval(() => {
  const now = Date.now();
  const ms = INACTIVITY_MINUTES * 60000;
  for (const k of sessions.keys()) {
    const s = sessions.get(k);
    if (!s) continue;
    if (now - (s.lastActivity || s.created) >= ms && s.contactId && !s.emailSent && (s.qualsDiscussed || []).length > 0 && s.messages.filter(m => m.role === 'user').length >= 2) {
      console.log(`[P2] 30-min inactivity backup for ${s.id}`);
      triggerEmailWebhook(s).catch(() => {});
      sessions.set(k, s);
    }
  }
}, INACTIVITY_CHECK_MS);

// ============================================================
// SEEK DAILY REFRESH — runs every 24 hours
// ============================================================
const seekRefresher = setInterval(() => {
  seek.refreshAll().catch(err => console.error('[SEEK] Refresh error: ' + err.message));
}, SEEK_REFRESH_MS);

// ============================================================
// LEAD CAPTURE
// ============================================================
async function attemptLeadCapture(s) {
  if (s.contactId) return;
  const t = s.messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const email = extractEmail(t);
  const phone = extractPhone(t);
  if (!email && !phone) return;
  let fn = '', ln = '';
  for (const m of s.messages) {
    if (m.role !== 'user') continue;
    const n = extractName(m.content, false);
    if (n) { fn = n.firstName; ln = n.lastName; break; }
  }
  const tag = s.audience === 'services' ? 'src:AI Chat — Services' : 'src:AI Chat — Public';
  const r = await ghl.upsertContact({ firstName: fn, lastName: ln, email: email || '', phone: phone || '', source: 'AI Chatbot', tags: [tag, 'chatbot-lead'] });
  if (r.ok) {
    s.contactId = r.contactId; s.firstName = fn; s.email = email || ''; s.phone = phone || '';
    await ghl.createOpportunity(r.contactId, { title: `AI Chat — ${fn || email || phone || 'Unknown'}`, stageId: process.env.GHL_STAGE_NEW_ENQUIRIES, source: 'AI Chatbot' });
    console.log(`[Lead] ${fn || ''} ${email || phone || ''} → ${r.contactId}`);
    await triggerSmsWebhook(s).catch(e => console.error(`[P1] ${e.message}`));
  }
}

// ============================================================
// ROUTES
// ============================================================
app.get('/health', (req, res) => res.json({
  status: 'ok', uptime: Math.round(process.uptime()), sessions: sessions.keys().length, version: '2.0.0',
  seek: { cached: seek.getCacheSize(), lastRefresh: seek.getLastRefresh() },
  abs: { live: abs.isLive() },
  features: { sms: !!process.env.GHL_WORKFLOW_SMS_URL, email: !!process.env.GHL_WORKFLOW_EMAIL_URL, escalation: !!process.env.ESCALATION_WEBHOOK_URL, callback: !!process.env.CALLBACK_WEBHOOK_URL, analytics: !!process.env.ANALYTICS_WEBHOOK_URL, fileUpload: !!process.env.FILE_UPLOAD_WEBHOOK_URL },
}));

app.get('/', (req, res) => res.json({ name: '3CIR AI Assistant', version: '2.0.0', status: 'running' }));

app.post('/api/session', (req, res) => {
  const { referrerUrl } = req.body;
  const aud = detectAudience(referrerUrl);
  const id = uuidv4();
  const s = { id, audience: aud, messages: [{ role: 'assistant', content: OPENING_MESSAGES[aud] }], contactId: null, firstName: '', email: '', phone: '', qualsDiscussed: [], escalated: false, emailSent: false, callbackRequested: false, created: Date.now(), lastActivity: Date.now() };
  sessions.set(id, s);
  res.json({ sessionId: id, audience: aud, openingMessage: OPENING_MESSAGES[aud], quickReplies: QUICK_REPLIES[aud] });
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session_expired', message: 'Chat expired. Starting new conversation.' });
  res.json({ sessionId: s.id, audience: s.audience, messages: s.messages, quickReplies: QUICK_REPLIES[s.audience] });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, sessionId, pageUrl } = req.body;
  const clean = sanitise(message);
  if (!clean) return res.status(400).json({ error: 'Message is required.' });
  if (clean.length >= MAX_MSG_LENGTH) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ type: 'error', content: "That message is a bit long — could you shorten it?" })}\n\n`);
    return res.end();
  }

  let s = sessions.get(sessionId);
  if (!s) {
    const aud = detectAudience(pageUrl);
    const id = uuidv4();
    s = { id, audience: aud, messages: [{ role: 'assistant', content: OPENING_MESSAGES[aud] }], contactId: null, firstName: '', email: '', phone: '', qualsDiscussed: [], escalated: false, emailSent: false, callbackRequested: false, created: Date.now(), lastActivity: Date.now() };
    sessions.set(id, s);
    res.setHeader('X-New-Session-Id', id);
  }

  s.lastActivity = Date.now();
  s.messages.push({ role: 'user', content: clean });

  const uq = trackQualifications(clean, s.audience);
  for (const q of uq) {
    if (!s.qualsDiscussed.find(d => d.code === q.code && d.name === q.name)) s.qualsDiscussed.push(q);
  }

  if (s.messages.length > MAX_HISTORY) {
    const f = s.messages[0];
    s.messages = [f, ...s.messages.slice(-(MAX_HISTORY - 1))];
  }
  sessions.set(s.id, s);

  const msgs = s.messages.map(m => ({ role: m.role, content: m.content }));

  // Build system prompt with SEEK job data and ABS labour data
  const seekData = seek.getJobDataSummary();
  const absData = abs.getLabourDataSummary();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', s.id);
  res.flushHeaders();

  let disc = false;
  req.on('close', () => { disc = true; });
  let reply = '';

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(s.audience, pageUrl || '', seekData, absData),
      messages: msgs,
    });

    for await (const ev of stream) {
      if (disc) { stream.controller?.abort(); break; }
      if (ev.type === 'content_block_delta' && ev.delta?.text) {
        reply += ev.delta.text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: ev.delta.text })}\n\n`);
      }
    }

    if (!disc) {
      if (reply) {
        s.messages.push({ role: 'assistant', content: reply });
        s.lastActivity = Date.now();
        const bq = trackQualifications(reply, s.audience);
        for (const q of bq) {
          if (!s.qualsDiscussed.find(d => d.code === q.code && d.name === q.name)) s.qualsDiscussed.push(q);
        }
        sessions.set(s.id, s);
      }

      attemptLeadCapture(s).catch(e => console.error(`[Lead] ${e.message}`));

      const esc = checkEscalation(s);
      if (esc) triggerEscalationWebhook(s, esc).catch(e => console.error(`[P9] ${e.message}`));

      // P2: Goodbye detection — primary email trigger
      const userBye = detectGoodbye(clean);
      const botBye = reply ? detectBotGoodbye(reply) : false;
      const ending = userBye || botBye;
      if (ending && s.contactId && !s.emailSent && (s.qualsDiscussed || []).length > 0) {
        setTimeout(() => {
          const cs = sessions.get(s.id);
          if (cs && !cs.emailSent && Date.now() - cs.lastActivity >= 120000) {
            console.log(`[P2] Goodbye — email for ${s.id}`);
            triggerEmailWebhook(cs).catch(() => {});
            sessions.set(s.id, cs);
          }
        }, 120000);
      }

      // Callback detection
      if (detectCallbackRequest(clean) && s.contactId && !s.callbackRequested) {
        const tm = clean.match(/(?:at|around|about|tomorrow|today|monday|tuesday|wednesday|thursday|friday|morning|afternoon|evening|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi);
        triggerCallbackWebhook(s, tm ? tm.join(' ') : 'As soon as possible').catch(e => console.error(`[CB] ${e.message}`));
      }

      res.write(`data: ${JSON.stringify({ type: 'done', leadCaptured: !!s.contactId, qualsDiscussed: (s.qualsDiscussed || []).length, conversationEnding: ending })}\n\n`);
    }
  } catch (err) {
    console.error(`[Claude] ${err.message}`);
    if (!disc) {
      const fb = "I'm having a brief technical moment. You can try again, or call us directly on 1300 517 039.";
      res.write(`data: ${JSON.stringify({ type: 'error', content: fb })}\n\n`);
      s.messages.push({ role: 'assistant', content: fb });
      sessions.set(s.id, s);
    }
  }
  res.end();
});

app.post('/api/lead', async (req, res) => {
  const { sessionId, name, email, phone } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });
  const tag = s.audience === 'services' ? 'src:AI Chat — Services' : 'src:AI Chat — Public';
  const p = (name || '').split(/\s+/);
  const r = await ghl.upsertContact({ firstName: p[0] || '', lastName: p.slice(1).join(' ') || '', email: email || '', phone: phone || '', source: 'AI Chatbot', tags: [tag, 'chatbot-lead'] });
  if (r.ok) {
    s.contactId = r.contactId; s.firstName = p[0] || ''; s.email = email || ''; s.phone = phone || '';
    sessions.set(sessionId, s);
    await ghl.createOpportunity(r.contactId, { title: `AI Chat — ${p[0] || email || phone}`, stageId: process.env.GHL_STAGE_NEW_ENQUIRIES, source: 'AI Chatbot' });
    await triggerSmsWebhook(s).catch(() => {});
  }
  res.json({ ok: r.ok, contactId: r.contactId });
});

// ============================================================
// POST /api/upload — Resume/CV file upload from widget
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const { sessionId } = req.body;
    const s = sessionId ? sessions.get(sessionId) : null;
    const file = req.file;

    console.log(`[Upload] ${file.originalname} (${(file.size/1024).toFixed(0)}KB) from session ${sessionId || 'unknown'}`);

    // Store file info in session
    if (s) {
      if (!s.uploadedFiles) s.uploadedFiles = [];
      s.uploadedFiles.push({ name: file.originalname, size: file.size, type: file.mimetype, uploadedAt: new Date().toISOString() });
      sessions.set(sessionId, s);

      // Add GHL note if contact exists
      if (s.contactId) {
        await ghl.addNote(s.contactId, `Resume/CV uploaded via chatbot: ${file.originalname} (${(file.size/1024).toFixed(0)}KB, ${file.mimetype})`).catch(() => {});
      }
    }

    // Trigger file upload webhook if configured (Rex can build a workflow that emails it to Matt)
    const webhookUrl = process.env.FILE_UPLOAD_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          contactId: s?.contactId || null,
          firstName: s?.firstName || '',
          email: s?.email || '',
          phone: s?.phone || '',
          audience: s?.audience || 'unknown',
          fileName: file.originalname,
          fileSize: file.size,
          fileType: file.mimetype,
          fileBase64: file.buffer.toString('base64'),
          source: 'AI Chatbot — File Upload',
        }, { timeout: 30000, maxContentLength: 10 * 1024 * 1024 });
        console.log(`[Upload] Webhook triggered for ${file.originalname}`);
      } catch (err) {
        console.error(`[Upload] Webhook failed: ${err.message}`);
      }
    }

    res.json({ ok: true, fileName: file.originalname, fileSize: file.size });
  } catch (err) {
    console.error(`[Upload] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Upload failed' });
  }
});

// ============================================================
// POST /api/transcript — Email conversation transcript to visitor
// ============================================================
app.post('/api/transcript', async (req, res) => {
  const { sessionId, email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'Email required' });

  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });

  const url = process.env.GHL_WORKFLOW_EMAIL_URL;
  if (!url) return res.status(500).json({ ok: false, error: 'Email not configured' });

  const quals = s.qualsDiscussed || [];
  const qualSummary = quals.map(q => {
    let price = `RPL $${q.rpl.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
    if (q.online) price += ` | Online Study $${q.online.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
    return `${q.name} (${q.code}) — ${price}`;
  }).join('\n');

  const rplUrl = s.audience === 'services' ? 'https://www.3cir.com/services/rpl-assessment-form/' : 'https://www.3cir.com/public/rpl-assessment-form/';
  const transcript = buildTranscript(s);

  try {
    const evidenceChecklist = s.audience === 'services'
      ? 'ADO Service Record or Certificate of Service\nPMKeys summary or Course Reports/ROAs\nPerformance Appraisals (PARs/SPARs)\nPosition descriptions or duty statements\nCivilian qualifications or training certificates\nReference letter from a commanding officer or supervisor'
      : 'Resume or CV\nPosition descriptions from current and previous roles\nReference letters from supervisors\nTraining certificates and course completions\nPerformance reviews or appraisals\nAny existing qualifications';

    const disclaimer = 'IMPORTANT: This summary is provided as guidance only. A formal RPL assessment would need to be completed for detailed and exact information to be provided regarding your eligibility and qualification outcomes. All qualifications are issued through Asset College (RTO 31718).';

    await axios.post(url, {
      contactId: s.contactId || null,
      firstName: s.firstName || '',
      email: email,
      phone: s.phone || '',
      audience: s.audience,
      qualificationsSummary: qualSummary || 'No specific qualifications discussed yet',
      qualificationsCount: quals.length,
      qualificationsList: quals.map(q => q.name),
      rplFormUrl: rplUrl,
      chatTranscript: transcript,
      conversationLength: s.messages.length,
      evidenceChecklist: evidenceChecklist,
      uploadedFiles: (s.uploadedFiles || []).map(f => f.name),
      hasUploadedFiles: (s.uploadedFiles || []).length > 0,
      disclaimer: disclaimer,
      source: 'AI Chatbot — Transcript Request',
    }, { timeout: 10000 });

    // Also attempt lead capture with this email if not already captured
    if (!s.contactId) {
      s.email = email;
      await attemptLeadCapture(s).catch(() => {});
    }

    console.log(`[Transcript] Sent to ${email} for session ${sessionId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[Transcript] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Failed to send' });
  }
});

// ============================================================
// POST /api/rating — Satisfaction rating from widget
// ============================================================
app.post('/api/rating', async (req, res) => {
  const { sessionId, rating } = req.body;
  const s = sessionId ? sessions.get(sessionId) : null;

  console.log(`[Rating] ${rating} from session ${sessionId || 'unknown'}`);

  if (s) {
    s.rating = rating;
    sessions.set(sessionId, s);

    // Add to GHL note if contact exists
    if (s.contactId) {
      const emoji = rating === 'positive' ? '👍' : '👎';
      await ghl.addNote(s.contactId, `Chatbot satisfaction rating: ${emoji} ${rating}`).catch(() => {});
    }
  }

  // Log to analytics
  const analyticsUrl = process.env.ANALYTICS_WEBHOOK_URL;
  if (analyticsUrl) {
    try {
      await axios.post(analyticsUrl, {
        sessionId: sessionId,
        audience: s?.audience || 'unknown',
        messageCount: s?.messages?.length || 0,
        userMessageCount: s?.messages?.filter(m => m.role === 'user').length || 0,
        durationMinutes: s ? Math.round((Date.now() - s.created) / 60000) : 0,
        leadCaptured: !!s?.contactId,
        contactId: s?.contactId || null,
        qualsDiscussed: (s?.qualsDiscussed || []).map(q => q.name),
        escalated: !!s?.escalated,
        emailSent: !!s?.emailSent,
        callbackRequested: !!s?.callbackRequested,
        endReason: 'rating_' + rating,
        timestamp: new Date().toISOString(),
      }, { timeout: 10000 });
    } catch (e) {}
  }

  res.json({ ok: true });
});

// ============================================================
// SHUTDOWN
// ============================================================
async function shutdown(sig) {
  console.log(`\n[Server] ${sig}`);
  clearInterval(inactivityChecker);
  clearInterval(seekRefresher);
  const ks = sessions.keys();
  await Promise.allSettled(ks.map(k => { const s = sessions.get(k); return s ? handleSessionEnd(s, 'shutdown').catch(() => {}) : Promise.resolve(); }));
  console.log(`[Server] ${ks.length} sessions saved.`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  console.log('============================================================');
  console.log('  3CIR AI ASSISTANT v2.0.0');
  console.log(`  Port:     ${PORT}`);
  console.log(`  Env:      ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Origins:  ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`  GHL:      ${process.env.GHL_LOCATION_ID || 'NOT SET'}`);
  console.log(`  Claude:   Configured`);
  console.log(`  SMS:      ${process.env.GHL_WORKFLOW_SMS_URL ? 'ON' : 'OFF'}`);
  console.log(`  Email:    ${process.env.GHL_WORKFLOW_EMAIL_URL ? 'ON' : 'OFF'}`);
  console.log(`  Escalate: ${process.env.ESCALATION_WEBHOOK_URL ? 'ON' : 'OFF'}`);
  console.log(`  Callback: ${process.env.CALLBACK_WEBHOOK_URL ? 'ON' : 'OFF'}`);
  console.log(`  Analytics:${process.env.ANALYTICS_WEBHOOK_URL ? 'ON' : 'OFF'}`);
  console.log(`  Upload:   ${process.env.FILE_UPLOAD_WEBHOOK_URL ? 'ON' : 'Local only'}`);
  console.log(`  SEEK:     ${seek.getCacheSize()} qualifications cached`);
  console.log(`  ABS:      ${process.env.ABS_API_KEY ? 'Live API' : 'Baseline data'}`);
  console.log('============================================================');

  // Initial SEEK refresh (runs in background, doesn't block startup)
  seek.refreshAll().catch(err => console.error('[SEEK] Initial refresh error: ' + err.message));

  // Check ABS API if key is set
  if (process.env.ABS_API_KEY) {
    abs.fetchLiveData().catch(err => console.error('[ABS] ' + err.message));
  }
});

module.exports = app;
