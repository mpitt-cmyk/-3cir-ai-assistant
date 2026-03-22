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
const messenger = require('./services/messenger');
const smsService = require('./services/sms');

// === EVIDENCE SCANNER: Import the router ===
const evidenceScanRouter = require('./routes/evidence-scan');

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

// === EVIDENCE SCANNER: Expose session cache and GHL for the scanner ===
global._3cir_sessionCache = sessions;
global._3cir_ghl = ghl;

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.set('trust proxy', 1); // Render runs behind a proxy — required for express-rate-limit
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
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

// === EVIDENCE SCANNER: Mount the evidence scan router ===
app.use(evidenceScanRouter);

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
  status: 'ok', uptime: Math.round(process.uptime()), sessions: sessions.keys().length, version: '2.0.2',
  seek: { cached: seek.getCacheSize(), lastRefresh: seek.getLastRefresh() },
  abs: { live: abs.isLive() },
  features: { sms: !!process.env.GHL_WORKFLOW_SMS_URL, email: !!process.env.GHL_WORKFLOW_EMAIL_URL, escalation: !!process.env.ESCALATION_WEBHOOK_URL, callback: !!process.env.CALLBACK_WEBHOOK_URL, analytics: !!process.env.ANALYTICS_WEBHOOK_URL, fileUpload: !!process.env.FILE_UPLOAD_WEBHOOK_URL, evidenceScanner: true },
  channels: { messenger: !!process.env.META_PAGE_ACCESS_TOKEN, sms: !!process.env.TWILIO_ACCOUNT_SID, whatsapp: !!process.env.TWILIO_WHATSAPP_FROM },
}));

app.get('/', (req, res) => res.json({ name: '3CIR AI Assistant', version: '2.0.2', status: 'running' }));

// Standalone chat pages — shareable URLs for emails, social, QR codes
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat-services.html')));
app.get('/chat/services', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat-services.html')));
app.get('/chat/public', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat-public.html')));

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

  // === EVIDENCE SCANNER: Add file context to system prompt so Claude knows about uploads ===
  let fileContext = '';
  if (s.uploadedFiles && s.uploadedFiles.length > 0) {
    const fileNames = s.uploadedFiles.map(f => f.name).join(', ');
    const hasContact = !!(s.contactId || s.email || s.phone);
    const hasQuals = (s.qualsDiscussed || []).length > 0;
    fileContext = '\n\nFILES UPLOADED IN THIS SESSION:\n' + fileNames;
    if (hasContact && hasQuals && s.uploadedFileBuffer) {
      fileContext += '\nALL THREE CONDITIONS MET: The visitor has uploaded a file, discussed qualifications, AND provided contact details. You SHOULD offer the evidence check now. Say something like: "I can see you\'ve uploaded your ' + s.uploadedFiles[s.uploadedFiles.length - 1].name + '. Would you like me to run a quick evidence check against the [qualification name]? It takes about 30 seconds."';
    } else if (!hasContact) {
      fileContext += '\nFile uploaded but contact details not yet captured. Continue the conversation naturally — collect their name and email before offering the evidence check.';
    }
    console.log(`[Evidence Debug] File context added to prompt. Files: ${fileNames}, hasContact: ${hasContact}, hasQuals: ${hasQuals}, hasBuffer: ${!!s.uploadedFileBuffer}`);
  }
  const fullSystemPrompt = buildSystemPrompt(s.audience, pageUrl || '', seekData, absData) + fileContext;

  // === EVIDENCE SCANNER: Auto-trigger scan when conditions are met ===
  // Three trigger paths:
  //   1. User says "scan my resume" AND file already uploaded → immediate
  //   2. User said "scan" earlier (scanRequested=true), then uploaded → triggers on next message
  //   3. File just uploaded (fileJustUploaded=true) + contact + quals → auto-trigger, no keyword needed
  let scanResults = '';
  const scanPatterns = /\b(scan|evidence check|check my (resume|cv|document|file|record)|analyse my|analyze my|run.*(check|scan|analysis))\b/i;
  const hasFile = s.uploadedFileBuffer && s.uploadedFiles && s.uploadedFiles.length > 0;
  const hasContact = !!(s.contactId);
  const hasQuals = (s.qualsDiscussed || []).length > 0;
  const scanMatch = scanPatterns.test(clean);

  // If user asks for scan but no file yet, remember the request
  if (scanMatch && !hasFile) {
    s.scanRequested = true;
    sessions.set(s.id, s);
    console.log(`[Evidence Scan] Scan requested but no file yet — flagged for auto-trigger after upload`);
  }

  // Trigger scan if: (keyword match OR previously requested OR file just uploaded) AND all conditions met
  const shouldScan = (scanMatch || s.scanRequested || s.fileJustUploaded) && hasFile && hasContact && hasQuals && !s.evidenceScanned;
  console.log(`[Evidence Scan] Check: shouldScan=${shouldScan} | scanMatch=${scanMatch} | scanRequested=${!!s.scanRequested} | fileJustUploaded=${!!s.fileJustUploaded} | hasFile=${hasFile} | hasContact=${hasContact} | hasQuals=${hasQuals} | scanned=${!!s.evidenceScanned}`);

  // Clear the fileJustUploaded flag regardless
  if (s.fileJustUploaded) { s.fileJustUploaded = false; sessions.set(s.id, s); }

  if (shouldScan) {
    try {
      const { analyseEvidence, extractWordText } = require('./services/evidence-scanner');
      const lastQual = s.qualsDiscussed[s.qualsDiscussed.length - 1];
      console.log(`[Evidence Scan] Auto-triggered for ${lastQual.code} ${lastQual.name}`);

      // Extract text from Word docs if needed
      let scanBuffer = s.uploadedFileBuffer;
      let scanMime = s.uploadedFileMime;
      if (scanMime === 'application/msword' || scanMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const extracted = await extractWordText(scanBuffer);
        scanBuffer = Buffer.from(extracted, 'utf-8');
        scanMime = 'text/plain';
      }

      const result = await analyseEvidence(scanBuffer, scanMime, s.uploadedFileName, lastQual.code, s.audience);

      if (result.success) {
        const scan = result.prospectSummary;
        scanResults = '\n\nEVIDENCE SCAN RESULTS (just completed — present these to the visitor naturally):\n' +
          'Qualification: ' + scan.qualCode + ' ' + scan.qualName + '\n' +
          'Match Score: ' + scan.score + '%\n' +
          'Assessment: ' + scan.confidenceText + '\n' +
          'Strengths: ' + scan.strengths.join(', ') + '\n' +
          'Gaps: ' + scan.gaps.join(', ') + '\n' +
          'IMPORTANT: Present these results conversationally. Lead with the score, mention strengths, gently note gaps, and end with the CTA to submit the free RPL assessment form. Do NOT use markdown formatting. Do NOT mention unit codes or competency standards.';

        // Send full analysis to GHL
        if (s.contactId && global._3cir_ghl) {
          await global._3cir_ghl.addNote(s.contactId, result.ghlNote).catch(e => console.error('[Evidence Scan] GHL note failed:', e.message));
          await global._3cir_ghl.upsertContact({ email: s.email || '', phone: s.phone || '', tags: ['evidence-pre-scanned'] }).catch(() => {});
        }

        // Clear buffer and mark as scanned
        s.uploadedFileBuffer = null;
        s.evidenceScanned = true;
        s.evidenceScanScore = scan.score;
        s.evidenceScanQual = lastQual.code;
        sessions.set(s.id, s);

        // Log to analytics
        const analyticsUrl = process.env.ANALYTICS_WEBHOOK_URL;
        if (analyticsUrl) {
          axios.post(analyticsUrl, { sessionId: s.id, audience: s.audience, eventType: 'evidence_scan', qualCode: lastQual.code, score: scan.score, contactId: s.contactId, timestamp: new Date().toISOString() }, { timeout: 10000 }).catch(() => {});
        }

        console.log(`[Evidence Scan] Complete: ${scan.score}% match for ${lastQual.code}`);
      } else {
        console.error(`[Evidence Scan] analyseEvidence returned success=false`);
      }
    } catch (scanErr) {
      console.error('[Evidence Scan] Auto-trigger error:', scanErr.message, scanErr.stack);
      // Non-blocking — chat continues normally without scan results
    }
  }
  // Clear scanRequested flag after successful scan
  if (shouldScan) { s.scanRequested = false; sessions.set(s.id, s); }
  const chatSystemPrompt = fullSystemPrompt + scanResults;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', s.id);
  res.flushHeaders();

  let disc = false;
  req.on('close', () => { disc = true; });
  let reply = '';

  try {
    // Retry once on failure before showing error
    let attempts = 0;
    let stream;
    while (attempts < 2) {
      try {
        stream = await anthropic.messages.stream({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: chatSystemPrompt,
          messages: msgs,
        });
        break;
      } catch (retryErr) {
        attempts++;
        if (attempts >= 2) throw retryErr;
        console.log(`[Claude] Retry ${attempts} after: ${retryErr.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

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
  const { sessionId, name, email, phone, qualInterest, audience, notes, source } = req.body;
  const s = sessionId ? sessions.get(sessionId) : null;

  // Voice calls won't have a session — that's OK
  if (sessionId && !s) return res.status(404).json({ error: 'Session not found' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });

  const aud = s?.audience || audience || 'services';
  const isVoice = !sessionId || source === 'AI Voice Call';
  const tag = isVoice
    ? (aud === 'public' ? 'src:AI Voice — Public' : 'src:AI Voice — Services')
    : (aud === 'services' ? 'src:AI Chat — Services' : 'src:AI Chat — Public');
  const p = (name || '').split(/\s+/);
  const leadSource = source || 'AI Chatbot';
  const tags = [tag, isVoice ? 'voice-lead' : 'chatbot-lead'];

  const r = await ghl.upsertContact({ firstName: p[0] || '', lastName: p.slice(1).join(' ') || '', email: email || '', phone: phone || '', source: leadSource, tags: tags });
  if (r.ok) {
    if (s) {
      s.contactId = r.contactId; s.firstName = p[0] || ''; s.email = email || ''; s.phone = phone || '';
      sessions.set(sessionId, s);
    }
    const oppTitle = isVoice ? `AI Voice — ${p[0] || phone || email}` : `AI Chat — ${p[0] || email || phone}`;
    await ghl.createOpportunity(r.contactId, { title: oppTitle, stageId: process.env.GHL_STAGE_NEW_ENQUIRIES, source: leadSource });

    // Add qualification interest and notes if provided (from voice calls)
    if (qualInterest || notes) {
      const noteText = [qualInterest ? `Qualification interest: ${qualInterest}` : '', notes ? `Notes: ${notes}` : ''].filter(Boolean).join('\n');
      await ghl.addNote(r.contactId, noteText).catch(() => {});
    }

    if (s) await triggerSmsWebhook(s).catch(() => {});
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

      // === EVIDENCE SCANNER: Store file buffer for pre-scanner analysis ===
      s.uploadedFileBuffer = file.buffer;
      s.uploadedFileMime = file.mimetype;
      s.uploadedFileName = file.originalname;
      s.fileJustUploaded = true; // Flag for auto-trigger on next /api/chat call

      sessions.set(sessionId, s);

      console.log(`[Evidence Scan] File stored: ${file.originalname} (${file.buffer.length} bytes). fileJustUploaded=true, scanRequested=${!!s.scanRequested}, contactId=${s.contactId || 'NONE'}, quals=${(s.qualsDiscussed||[]).length}`);

      // Add GHL note if contact exists
      if (s.contactId) {
        await ghl.addNote(s.contactId, `Resume/CV uploaded via chatbot: ${file.originalname} (${(file.size/1024).toFixed(0)}KB, ${file.mimetype})`).catch(() => {});
      }
    } else {
      console.log(`[Evidence Debug] WARNING: No session found for ${sessionId} — file buffer NOT stored`);
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
// MULTI-CHANNEL: Non-streaming chat function for messaging platforms
// ============================================================
async function channelChat(sessionKey, userMessage, platform, audience) {
  // Get or create session
  let s = sessions.get(sessionKey);
  if (!s) {
    s = {
      id: sessionKey,
      audience: audience || 'services',
      messages: [],
      qualsDiscussed: [],
      created: Date.now(),
      lastActivity: Date.now(),
      contactId: null,
      firstName: '',
      email: '',
      phone: '',
      platform: platform,
      uploadedFiles: [],
    };
  }

  s.messages.push({ role: 'user', content: userMessage });
  s.lastActivity = Date.now();

  const seekData = seek.getJobDataSummary();
  const absData = abs.getLabourDataSummary();

  // Channel-specific system prompt additions
  let channelNote = '';
  if (platform === 'sms') {
    channelNote = '\n\nCHANNEL: SMS. Keep responses SHORT — max 2-3 sentences per reply. Be direct and concise. No long paragraphs. Include the RPL form URL when relevant: https://www.3cir.com/services/rpl-assessment-form/';
  } else if (platform === 'whatsapp') {
    channelNote = '\n\nCHANNEL: WhatsApp. Keep responses concise — max 3-4 short paragraphs. People expect quick replies on WhatsApp. You can be slightly more detailed than SMS but still keep it punchy.';
  } else if (platform === 'messenger' || platform === 'instagram') {
    channelNote = `\n\nCHANNEL: ${platform === 'instagram' ? 'Instagram DM' : 'Facebook Messenger'}. Keep responses conversational and concise — max 3-4 short paragraphs. People expect chat-style replies. If they want more detail, direct them to the chatbot on the website or the RPL form.`;
  }

  const systemPrompt = buildSystemPrompt(s.audience, '', seekData, absData) + channelNote;
  const msgs = s.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: platform === 'sms' ? 512 : 1024,
      system: systemPrompt,
      messages: msgs,
    });

    const reply = response.content?.[0]?.text || 'Sorry, I had a technical issue. Please call us on 1300 517 039.';

    s.messages.push({ role: 'assistant', content: reply });
    const bq = trackQualifications(reply, s.audience);
    for (const q of bq) {
      if (!s.qualsDiscussed.find(d => d.code === q.code && d.name === q.name)) s.qualsDiscussed.push(q);
    }
    sessions.set(sessionKey, s);

    // Attempt lead capture
    attemptLeadCapture(s).catch(e => console.error(`[Lead] ${e.message}`));

    // Log to analytics
    logAnalytics(s, `${platform}_message`).catch(() => {});

    return reply;
  } catch (err) {
    console.error(`[${platform}] Claude error: ${err.message}`);
    return 'Sorry, I\'m having a brief technical moment. Please call us on 1300 517 039 or visit 3cir.com to chat with us there.';
  }
}

// ============================================================
// FACEBOOK MESSENGER + INSTAGRAM DMs
// ============================================================
app.get('/api/messenger', (req, res) => {
  const result = messenger.verifyWebhook(req.query);
  if (result.ok) return res.status(200).send(result.challenge);
  res.status(403).send('Forbidden');
});

app.post('/api/messenger', async (req, res) => {
  // Always respond 200 immediately — Meta requires fast acknowledgement
  res.status(200).send('EVENT_RECEIVED');

  const messages = messenger.parseMessages(req.body);

  for (const msg of messages) {
    if (!msg.text) continue;

    const sessionKey = `${msg.platform}_${msg.senderId}`;
    console.log(`[${msg.platform}] ${msg.senderId}: ${msg.text.substring(0, 80)}`);

    // Show typing indicator
    await messenger.sendTypingOn(msg.senderId);

    // Get user name if first message
    let s = sessions.get(sessionKey);
    if (!s) {
      const profile = await messenger.getUserProfile(msg.senderId);
      if (profile) {
        s = {
          id: sessionKey,
          audience: 'services',
          messages: [],
          qualsDiscussed: [],
          created: Date.now(),
          lastActivity: Date.now(),
          contactId: null,
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: '',
          phone: '',
          platform: msg.platform,
          uploadedFiles: [],
        };
        sessions.set(sessionKey, s);
      }
    }

    // Get response from Claude
    const reply = await channelChat(sessionKey, msg.text, msg.platform, 'services');

    // Send reply
    await messenger.sendMessage(msg.senderId, reply, msg.platform);
  }
});

// ============================================================
// SMS via Twilio
// ============================================================
app.post('/api/sms', async (req, res) => {
  // Respond with empty TwiML immediately
  res.set('Content-Type', 'text/xml');
  res.send(smsService.twimlResponse());

  const msg = smsService.parseMessage(req.body);
  if (!msg || !msg.text) return;

  const sessionKey = `sms_${msg.phone}`;
  console.log(`[SMS] ${msg.phone}: ${msg.text.substring(0, 80)}`);

  // Store phone in session
  let s = sessions.get(sessionKey);
  if (!s) {
    s = {
      id: sessionKey,
      audience: 'services',
      messages: [],
      qualsDiscussed: [],
      created: Date.now(),
      lastActivity: Date.now(),
      contactId: null,
      firstName: '',
      email: '',
      phone: msg.phone,
      platform: 'sms',
      uploadedFiles: [],
    };
    sessions.set(sessionKey, s);
  }

  const reply = await channelChat(sessionKey, msg.text, 'sms', 'services');
  await smsService.sendSms(msg.phone, reply);
});

// ============================================================
// WhatsApp via Twilio
// ============================================================
app.post('/api/whatsapp', async (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(smsService.twimlResponse());

  const msg = smsService.parseMessage(req.body);
  if (!msg || !msg.text) return;

  const sessionKey = `whatsapp_${msg.phone}`;
  console.log(`[WhatsApp] ${msg.phone}: ${msg.text.substring(0, 80)}`);

  let s = sessions.get(sessionKey);
  if (!s) {
    s = {
      id: sessionKey,
      audience: 'services',
      messages: [],
      qualsDiscussed: [],
      created: Date.now(),
      lastActivity: Date.now(),
      contactId: null,
      firstName: '',
      email: '',
      phone: msg.phone,
      platform: 'whatsapp',
      uploadedFiles: [],
    };
    sessions.set(sessionKey, s);
  }

  const reply = await channelChat(sessionKey, msg.text, 'whatsapp', 'services');
  await smsService.sendWhatsApp(msg.phone, reply);
});

// ============================================================
// POST /api/voice-callback — Vapi post-call webhook
// Receives call transcript and summary after every voice call
// ============================================================
app.post('/api/voice-callback', async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const msg = req.body?.message || req.body;
    const call = msg?.call || msg;
    const type = msg?.type || '';

    // Only process end-of-call reports
    if (type && type !== 'end-of-call-report') return;

    const phone = call?.customer?.number || '';
    const transcript = call?.transcript || '';
    const summary = call?.summary || '';
    const duration = call?.endedAt && call?.startedAt
      ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
      : 0;

    console.log(`[Voice Callback] Call ended | Phone: ${phone} | Duration: ${duration}s | Transcript: ${transcript.length} chars`);

    if (!phone) return;

    // Upsert contact by phone — this searches first, creates if not found
    const r = await ghl.upsertContact({
      firstName: 'Voice Caller',
      lastName: '',
      email: '',
      phone: phone,
      source: 'AI Voice Call',
      tags: ['src:AI Voice — Services', 'voice-lead'],
    }).catch(() => ({ ok: false }));

    if (r.ok && r.contactId) {
      // Add transcript as a contact note
      const noteText = [
        `AI Voice Call — ${duration}s`,
        summary ? `\nSummary: ${summary}` : '',
        transcript ? `\nFull Transcript:\n${transcript}` : '',
      ].join('');
      await ghl.addNote(r.contactId, noteText).catch(e => {
        console.error(`[Voice Callback] Failed to add note: ${e.message}`);
      });

      // Create opportunity if this is a new contact (capture_lead may have already created one)
      await ghl.createOpportunity(r.contactId, {
        title: `AI Voice — ${phone}`,
        stageId: process.env.GHL_STAGE_NEW_ENQUIRIES,
        source: 'AI Voice Call',
      }).catch(() => {}); // Silently fail if opp already exists

      console.log(`[Voice Callback] Contact ${r.contactId} updated with transcript`);
    }

    // Log to analytics if configured
    const analyticsUrl = process.env.ANALYTICS_WEBHOOK_URL;
    if (analyticsUrl) {
      await axios.post(analyticsUrl, {
        sessionId: `voice_${phone}_${Date.now()}`,
        platform: 'voice',
        audience: 'services',
        messageCount: 0,
        qualsDiscussed: [],
        duration: duration,
        summary: summary || 'Voice call — see transcript in GHL',
        leadCaptured: true,
        source: 'AI Voice Call',
      }, { timeout: 10000 }).catch(() => {});
    }
  } catch (err) {
    console.error(`[Voice Callback] Error: ${err.message}`);
  }
});

// ============================================================
// POST /api/outbound-call — Trigger Vapi outbound follow-up call
// ============================================================
app.post('/api/outbound-call', async (req, res) => {
  const { phone, name, email, qualification, audience, contactId, reason } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Phone number required' });

  const vapiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!vapiKey || !phoneNumberId) return res.status(500).json({ ok: false, error: 'Voice calling not configured' });

  const callReason = reason || '48-hour follow-up';
  const qualInfo = qualification || 'their RPL qualification';
  const firstName = name || 'there';

  const prompt = `You are calling ${firstName} from 3CIR to follow up on their recent enquiry about ${qualInfo}. This is a ${callReason} call.

Your goal is to:
1. Confirm they received the information they were looking for
2. Answer any remaining questions about the RPL process
3. Encourage them to submit their free RPL assessment form if they haven't already
4. Offer to help with evidence gathering

Be warm, professional, and not pushy. If they're busy, offer to call back at a better time. If they've already submitted their form, congratulate them and let them know Matt will be in touch within 24-48 hours.

Key facts:
- 3CIR is Australia's leading veteran-owned RPL provider
- Free RPL assessment — no obligation
- 225+ five-star reviews
- Payment plans available: Afterpay, Zip, Klarna, weekly direct debit
- Evidence checklist will be emailed to them
- Typical RPL assessment takes 2-4 weeks

DO NOT use the word "mate". Use Australian English. Be professional but warm.`;

  try {
    const response = await axios.post('https://api.vapi.ai/call/phone', {
      phoneNumberId: phoneNumberId,
      customer: { number: phone },
      assistant: {
        model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', messages: [{ role: 'system', content: prompt }] },
        voice: { provider: '11labs', voiceId: 'cjVigY5qzO86Huf0OWal', model: 'eleven_turbo_v2_5' },
        firstMessage: `Hi ${firstName}, this is 3CIR calling. I'm just following up on your recent RPL enquiry. Is now a good time for a quick chat?`,
        transcriber: { provider: 'deepgram' },
        serverUrl: `https://threecir-ai-assistant.onrender.com/api/voice-callback`,
      },
    }, {
      headers: { Authorization: `Bearer ${vapiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    // Log the outbound call to GHL
    if (contactId) {
      await ghl.addNote(contactId, `Outbound AI follow-up call triggered (${callReason}). Qualification: ${qualInfo}`).catch(() => {});
      await ghl.upsertContact({ email: email || '', phone: phone, tags: ['follow-up-call-sent'] }).catch(() => {});
    }

    console.log(`[Outbound] Call triggered to ${phone} — ${callReason}`);
    res.json({ ok: true, callId: response.data?.id });
  } catch (err) {
    console.error(`[Outbound] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Failed to initiate call' });
  }
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
  console.log('  3CIR AI ASSISTANT v2.0.2');
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
  console.log(`  Messenger:${process.env.META_PAGE_ACCESS_TOKEN ? 'ON' : 'OFF'}`);
  console.log(`  SMS:      ${process.env.TWILIO_ACCOUNT_SID ? 'ON' : 'OFF'}`);
  console.log(`  WhatsApp: ${process.env.TWILIO_WHATSAPP_FROM ? 'ON' : 'OFF'}`);
  console.log(`  SEEK:     ${seek.getCacheSize()} qualifications cached`);
  console.log(`  ABS:      ${process.env.ABS_API_KEY ? 'Live API' : 'Baseline data'}`);
  console.log(`  Evidence: ON (auto-trigger on upload)`);
  console.log('============================================================');

  // Initial SEEK refresh (runs in background, doesn't block startup)
  seek.refreshAll().catch(err => console.error('[SEEK] Initial refresh error: ' + err.message));

  // Check ABS API if key is set
  if (process.env.ABS_API_KEY) {
    abs.fetchLiveData().catch(err => console.error('[ABS] ' + err.message));
  }
});

module.exports = app;
